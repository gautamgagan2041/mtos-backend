'use strict';

/**
 * cacheService.js — Redis-backed caching layer
 *
 * INSTALL:  npm install ioredis
 * ENV:      REDIS_HOST=localhost  REDIS_PORT=6379  REDIS_PASSWORD=
 *
 * KEY NAMESPACING:
 *   mtos:<tenantId>:<entity>:<id>
 *
 * TTLs are tuned for payroll domain:
 *   Tenant settings:    5 min   (changes on plan upgrade, config changes)
 *   PT config:          60 min  (state slabs rarely change)
 *   Salary structures:  5 min   (can change between payroll runs)
 *   Employee list:      1 min   (changes frequently)
 *   ESIC periods:       1 min   (written during payroll run)
 */

const Redis  = require('ioredis');
const logger = require('../utils/logger');

const TTL = {
  TENANT:           5   * 60,  // 5 min
  PT_CONFIG:        60  * 60,  // 60 min
  SALARY_STRUCTURE: 5   * 60,  // 5 min
  EMPLOYEE_LIST:    1   * 60,  // 1 min
  ESIC_PERIODS:     1   * 60,  // 1 min
  PLAN_FEATURES:    10  * 60,  // 10 min
};

let _client = null;

function getClient() {
  if (_client) return _client;

  _client = new Redis({
    host:     process.env.REDIS_HOST     || 'localhost',
    port:     parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    db:       parseInt(process.env.REDIS_DB   || '0'),
    maxRetriesPerRequest: 3,
    enableOfflineQueue:   false,
    // Graceful degradation: if Redis is down, don't break the app
    reconnectOnError: (err) => {
      logger.error(`[Cache] Redis error: ${err.message}`);
      return true;
    },
    lazyConnect: true,
  });

  _client.on('error', (err) => {
    logger.error(`[Cache] Redis connection error: ${err.message}`);
  });

  _client.on('connect', () => {
    logger.info('[Cache] Redis connected');
  });

  return _client;
}

/**
 * get — retrieve a cached value
 * Returns null if not found or Redis is unavailable
 */
async function get(key) {
  try {
    const raw = await getClient().get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    logger.warn(`[Cache] GET failed for key "${key}": ${err.message}`);
    return null; // Graceful degradation — fall through to DB
  }
}

/**
 * set — store a value with TTL
 * Fails silently if Redis is unavailable (DB remains source of truth)
 */
async function set(key, value, ttl = 60) {
  try {
    await getClient().setex(key, ttl, JSON.stringify(value));
  } catch (err) {
    logger.warn(`[Cache] SET failed for key "${key}": ${err.message}`);
  }
}

/**
 * del — invalidate a key or pattern
 */
async function del(keyOrPattern) {
  try {
    if (keyOrPattern.includes('*')) {
      const keys = await getClient().keys(keyOrPattern);
      if (keys.length > 0) {
        await getClient().del(...keys);
      }
      return keys.length;
    }
    return await getClient().del(keyOrPattern);
  } catch (err) {
    logger.warn(`[Cache] DEL failed for "${keyOrPattern}": ${err.message}`);
    return 0;
  }
}

/**
 * getOrSet — cache-aside pattern
 * Tries cache first. On miss, calls fn(), caches result, returns it.
 * On Redis failure, calls fn() directly (transparent fallback).
 */
async function getOrSet(key, fn, ttl = 60) {
  const cached = await get(key);
  if (cached !== null) return cached;

  const value = await fn();
  if (value !== null && value !== undefined) {
    await set(key, value, ttl);
  }
  return value;
}

// ── Domain-specific cache helpers ─────────────────────────────────

const keys = {
  tenant:          (tenantId)                  => `mtos:${tenantId}:tenant`,
  ptConfig:        (tenantId, state)           => `mtos:${tenantId}:pt:${state}`,
  salaryStructure: (tenantId, structureId)     => `mtos:${tenantId}:ss:${structureId}`,
  employeeList:    (tenantId)                  => `mtos:${tenantId}:employees:active`,
  esicPeriods:     (tenantId, month, year)     => `mtos:${tenantId}:esic:${year}:${month}`,
  planFeatures:    (tenantId)                  => `mtos:${tenantId}:plan`,
  tenderAll:       (tenantId)                  => `mtos:${tenantId}:tenders:*`,
};

/**
 * Invalidate all cache for a tenant
 * Call after any settings change
 */
async function invalidateTenant(tenantId) {
  const count = await del(`mtos:${tenantId}:*`);
  logger.info(`[Cache] Invalidated ${count} keys for tenant ${tenantId}`);
}

/**
 * Invalidate salary structure cache (after structure update)
 */
async function invalidateSalaryStructure(tenantId, structureId) {
  await del(keys.salaryStructure(tenantId, structureId));
  // Also invalidate any tender-specific derived caches
  await del(`mtos:${tenantId}:tender:*`);
}

/**
 * Acquire a distributed lock (for payroll concurrency control)
 * Returns lockId if acquired, null if already locked
 *
 * Simple implementation — for production use redlock package
 */
async function acquireLock(lockKey, ttlSeconds = 120) {
  const lockId = `${Date.now()}-${Math.random()}`;
  try {
    const client = getClient();
    // SET key value NX EX ttl — atomic: only sets if not exists
    const result = await client.set(lockKey, lockId, 'EX', ttlSeconds, 'NX');
    if (result === 'OK') return lockId;
    return null; // Lock already held
  } catch (err) {
    logger.warn(`[Cache] acquireLock failed for "${lockKey}": ${err.message}`);
    return null;
  }
}

/**
 * Release a distributed lock (only release YOUR lock)
 */
async function releaseLock(lockKey, lockId) {
  // Lua script: atomic check-and-delete
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  try {
    await getClient().eval(script, 1, lockKey, lockId);
  } catch (err) {
    logger.warn(`[Cache] releaseLock failed for "${lockKey}": ${err.message}`);
  }
}

/**
 * withLock — acquire lock, run fn, release lock
 * Throws if lock cannot be acquired (another process is running)
 */
async function withLock(lockKey, fn, ttlSeconds = 120) {
  const lockId = await acquireLock(lockKey, ttlSeconds);
  if (!lockId) {
    throw new Error(
      `Operation already in progress. Another user is running this operation. ` +
      `Please wait and try again.`
    );
  }
  try {
    return await fn();
  } finally {
    await releaseLock(lockKey, lockId);
  }
}

module.exports = {
  get, set, del, getOrSet,
  invalidateTenant, invalidateSalaryStructure,
  acquireLock, releaseLock, withLock,
  keys, TTL,
};
