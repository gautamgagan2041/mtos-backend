/**
 * MTOS Cache Service
 *
 * Fixes:
 *   CRIT-05 — Replace blocking KEYS with non-blocking SCAN cursor iteration
 *   HIGH-04 — acquireLock distinguishes "lock taken" vs "Redis error"
 *   LOW-02  — Lock TTL is documented; callers receive structured errors
 *
 * Design contract:
 *  - getClient() returns the shared ioredis instance; never import ioredis directly.
 *  - All public functions are async and throw typed errors (code property).
 *  - scan() is the ONLY way to iterate keys — KEYS is banned in this module.
 *  - withLock() differentiates three states: ACQUIRED, TAKEN, ERROR.
 */

'use strict';

// ─── Error types ──────────────────────────────────────────────────────────────

class LockTakenError extends Error {
  constructor(lockKey) {
    super(`Distributed lock is held by another process: ${lockKey}`);
    this.code    = 'LOCK_TAKEN';
    this.lockKey = lockKey;
  }
}

class LockServiceError extends Error {
  constructor(lockKey, cause) {
    super(`Redis unavailable while acquiring lock "${lockKey}": ${cause.message}`);
    this.code    = 'LOCK_SERVICE_UNAVAILABLE';
    this.lockKey = lockKey;
    this.cause   = cause;
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TTL = Object.freeze({
  PT_CONFIG:       3600,   // seconds — invalidate when PT slabs updated (MED-04)
  PAYROLL_LOCK:     300,   // seconds — lock lifetime for payroll run
  TENDER_DATA:      600,
  SUBSCRIPTION:    1800,
  DEFAULT:          300,
});

const KEY = {
  payrollLock:  (tenantId, tenderId, month, year) =>
    `lock:payroll:${tenantId}:${tenderId}:${month}:${year}`,
  ptConfig:     (tenantId, state) =>
    `pt:config:${tenantId}:${state}`,
  tenderData:   (tenantId, tenderId) =>
    `tender:${tenantId}:${tenderId}`,
  subscription: (tenantId) =>
    `subscription:${tenantId}`,
};

// ─── Singleton client ─────────────────────────────────────────────────────────

let _client = null;

/**
 * Returns the shared Redis client.
 * In test environments, callers inject a mock via setClientForTest().
 */
function getClient() {
  if (!_client) {
    throw new Error(
      'Redis client not initialised. Call initRedis(config) at startup.'
    );
  }
  return _client;
}

/**
 * Initialises the Redis client from a config object.
 * Should be called once at application startup, after validateSecrets().
 *
 * MED-06: password is REQUIRED — startup fails if omitted.
 */
function initRedis(redisConfig) {
  if (_client) return _client;

  // Dynamic require so tests can mock without real ioredis installed
  const Redis = require('ioredis');

  if (!redisConfig.password) {
    throw new Error(
      'MED-06: Redis password is required. Set REDIS_PASSWORD in environment. ' +
      'Never run Redis without authentication in any environment.'
    );
  }

  _client = new Redis({
    host:            redisConfig.host,
    port:            redisConfig.port,
    password:        redisConfig.password,
    tls:             redisConfig.tls ? {} : undefined,
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,
    lazyConnect:     false,
    connectTimeout:  5000,
  });

  _client.on('error', (err) => {
    // Structured log — do NOT use console.error (LOW-01)
    const logger = _getLogger();
    logger.error({ err, component: 'redis' }, 'Redis connection error');
  });

  return _client;
}

/** @internal — for tests only */
function _setClientForTest(mockClient) { _client = mockClient; }
function _clearClientForTest()         { _client = null; }

// ─── SCAN-based key iteration (replaces KEYS — fixes CRIT-05) ─────────────────

/**
 * Non-blocking key scan using SCAN cursor iteration.
 * Replaces the blocking KEYS command that could freeze Redis for seconds.
 *
 * @param {string} pattern  – glob pattern, e.g. "pt:config:tenant123:*"
 * @param {number} count    – hint to Redis for keys per batch (default 100)
 * @returns {Promise<string[]>}
 */
async function scanKeys(pattern, count = 100) {
  const client  = getClient();
  const results = [];
  let   cursor  = '0';

  do {
    const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    cursor = nextCursor;
    results.push(...keys);
  } while (cursor !== '0');

  return results;
}

/**
 * Deletes all keys matching a glob pattern.
 * Uses SCAN + DEL (pipeline) to avoid blocking Redis.
 *
 * @param {string} pattern
 * @returns {Promise<number>}  number of keys deleted
 */
async function deleteByPattern(pattern) {
  const keys = await scanKeys(pattern);
  if (keys.length === 0) return 0;

  const client   = getClient();
  const pipeline = client.pipeline();
  for (const key of keys) pipeline.del(key);
  const results = await pipeline.exec();

  return results.filter(([err]) => !err).length;
}

// ─── Typed get/set/del ────────────────────────────────────────────────────────

async function get(key) {
  const raw = await getClient().get(key);
  if (raw === null) return null;
  try { return JSON.parse(raw); }
  catch { return raw; }
}

async function set(key, value, ttlSeconds = TTL.DEFAULT) {
  const serialised = typeof value === 'string' ? value : JSON.stringify(value);
  await getClient().setex(key, ttlSeconds, serialised);
}

async function del(key) {
  await getClient().del(key);
}

// ─── Distributed lock ─────────────────────────────────────────────────────────

/**
 * Attempts to acquire a distributed lock using SET NX EX.
 *
 * Returns:
 *   true            – lock acquired
 *   throws LockTakenError         – lock held by another process (HIGH-04: was null)
 *   throws LockServiceError       – Redis unavailable (HIGH-04: was also null)
 *
 * HIGH-04 fix: the two failure modes now throw DIFFERENT typed errors so
 * withLock() can surface the correct message to the operator.
 */
async function acquireLock(lockKey, ttlSeconds = TTL.PAYROLL_LOCK, ownerId = null) {
  const owner = ownerId || `pid:${process.pid}:${Date.now()}`;
  let result;
  try {
    result = await getClient().set(lockKey, owner, 'NX', 'EX', ttlSeconds);
  } catch (err) {
    throw new LockServiceError(lockKey, err);
  }

  if (result !== 'OK') {
    throw new LockTakenError(lockKey);
  }

  return true;
}

/**
 * Releases a lock. Uses a Lua script to ensure we only release our own lock.
 */
async function releaseLock(lockKey, ownerId) {
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  return getClient().eval(script, 1, lockKey, ownerId);
}

/**
 * Executes fn() inside a distributed lock.
 *
 * HIGH-04 fix: callers now receive specific errors:
 *   - LockTakenError       → another payroll run is in progress (expected)
 *   - LockServiceError     → Redis is down (infrastructure alert, not user error)
 *
 * @param {string}   lockKey
 * @param {Function} fn          – async operation to execute
 * @param {number}   ttlSeconds  – lock lifetime
 */
async function withLock(lockKey, fn, ttlSeconds = TTL.PAYROLL_LOCK) {
  const ownerId = `pid:${process.pid}:${Date.now()}`;

  // acquireLock throws LockTakenError or LockServiceError — do NOT swallow here.
  // Callers (payroll.service.js) catch and translate to appropriate HTTP responses.
  await acquireLock(lockKey, ttlSeconds, ownerId);

  try {
    return await fn();
  } finally {
    await releaseLock(lockKey, ownerId).catch((err) => {
      _getLogger().warn(
        { err, lockKey, ownerId },
        'Failed to release distributed lock — will expire via TTL'
      );
    });
  }
}

// ─── PT config cache with explicit invalidation (MED-04) ──────────────────────

/**
 * Invalidates the PT config cache for a specific tenant + state combination.
 * MUST be called whenever PT slabs are updated via the admin UI.
 *
 * MED-04 fix: previously the cache had no invalidation path and served
 * stale PT rates for up to 60 minutes after a government rate change.
 */
async function invalidatePtConfig(tenantId, state) {
  const key = KEY.ptConfig(tenantId, state);
  await del(key);
  _getLogger().info({ tenantId, state, key }, 'PT config cache invalidated');
}

// ─── Logger shim (LOW-01) ─────────────────────────────────────────────────────

/**
 * Returns the application logger.
 * Uses a console-based fallback in test environments so this module doesn't
 * depend on the logger being fully initialised.
 */
function _getLogger() {
  try {
    return require('../config/logger');
  } catch {
    return {
      info:  (...args) => console.info(...args),
      warn:  (...args) => console.warn(...args),
      error: (...args) => console.error(...args),
    };
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Lifecycle
  initRedis,
  getClient,
  _setClientForTest,
  _clearClientForTest,

  // Key operations
  get,
  set,
  del,
  scanKeys,
  deleteByPattern,
  invalidatePtConfig,

  // Distributed lock
  acquireLock,
  releaseLock,
  withLock,
  LockTakenError,
  LockServiceError,

  // Constants
  TTL,
  KEY,
};
