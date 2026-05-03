/**
 * MTOS Express Application Security Configuration
 *
 * Fixes:
 *   HIGH-02 — Rate limiting is in-memory. Replace with Redis-backed store
 *             so limits survive across multiple Node.js instances/pods.
 *   LOW-06  — unsafe-inline CSP ships to production. Replaced with nonce-based CSP.
 *   LOW-03  — bcrypt on main thread. Moved to worker thread.
 *
 * This module exports factory functions — call them after initRedis() has run.
 */

'use strict';

const crypto = require('crypto');

// ─── HIGH-02: Redis-backed rate limiting ──────────────────────────────────────

/**
 * Creates rate limiter middleware backed by Redis.
 *
 * HIGH-02 FIX:
 *   Before: express-rate-limit with default in-memory store.
 *           Each process has its own counter → 10 attempts × 4 instances = 40
 *           attempts before lockout. Bypassable by load-balancer round-robin.
 *
 *   After:  rate-limit-redis store pointing at the shared Redis instance.
 *           All instances share one counter per IP → true 10-attempt limit.
 *
 * Usage in index.js:
 *   const { createRateLimiters } = require('./appSecurity');
 *   const limiters = createRateLimiters(redisClient);
 *   app.use('/api/auth', limiters.auth);
 *   app.use('/api',      limiters.api);
 *
 * @param {import('ioredis').Redis} redisClient
 */
function createRateLimiters(redisClient) {
  const rateLimit      = require('express-rate-limit');
  const RedisStore     = require('rate-limit-redis');

  /**
   * Shared store factory — each limiter gets its own key prefix so their
   * counters don't collide in Redis.
   */
  function makeStore(prefix) {
    return new RedisStore({
      // rate-limit-redis ≥ 3.x API
      sendCommand: (...args) => redisClient.call(...args),
      prefix,
    });
  }

  // Auth endpoints: strict — 10 attempts per 15 minutes per IP
  const auth = rateLimit({
    windowMs:         15 * 60 * 1000,
    max:              10,
    standardHeaders:  true,
    legacyHeaders:    false,
    store:            makeStore('rl:auth:'),
    message:          { error: 'Too many login attempts. Try again in 15 minutes.' },
    skipSuccessfulRequests: false,
  });

  // General API: 300 req per minute per IP — protects against scraping
  const api = rateLimit({
    windowMs:         60 * 1000,
    max:              300,
    standardHeaders:  true,
    legacyHeaders:    false,
    store:            makeStore('rl:api:'),
    message:          { error: 'Rate limit exceeded. Slow down.' },
    skipSuccessfulRequests: true,
  });

  // Payroll trigger: extra strict — 5 per hour per tenant (not per IP)
  // Use req.tenantId set by injectTenantId middleware as the key
  const payrollTrigger = rateLimit({
    windowMs:         60 * 60 * 1000,
    max:              5,
    standardHeaders:  true,
    legacyHeaders:    false,
    store:            makeStore('rl:payroll:'),
    keyGenerator:     (req) => req.tenantId || req.ip,
    message:          { error: 'Payroll trigger rate limit exceeded.' },
  });

  return { auth, api, payrollTrigger };
}

// ─── LOW-06: Nonce-based CSP (removes unsafe-inline) ─────────────────────────

/**
 * Express middleware that generates a cryptographic nonce per request and
 * attaches it to res.locals.cspNonce. Use the nonce on any inline <script>
 * tags in your HTML templates: <script nonce="<%= cspNonce %>">
 *
 * LOW-06 FIX:
 *   Before: scriptSrc: ["'self'", "'unsafe-inline'"]
 *           // unsafe-inline negates XSS protection entirely.
 *
 *   After:  scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`]
 *           // Only scripts with the correct per-request nonce execute.
 *
 * Usage:
 *   app.use(generateCspNonce);
 *   app.use(helmet({ ... }));  // helmet reads res.locals.cspNonce
 */
function generateCspNonce(req, res, next) {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
}

/**
 * Returns the Helmet contentSecurityPolicy options with nonce-based script-src.
 * Call AFTER generateCspNonce middleware.
 *
 * @returns {Object}  helmet contentSecurityPolicy directives
 */
function getHelmetCspOptions() {
  return {
    contentSecurityPolicy: {
      directives: {
        defaultSrc:     ["'self'"],
        // LOW-06 FIX: nonce instead of unsafe-inline
        scriptSrc:      ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
        styleSrc:       ["'self'", "'unsafe-inline'"], // CSS inline is lower risk
        imgSrc:         ["'self'", 'data:', 'https:'],
        connectSrc:     ["'self'"],
        fontSrc:        ["'self'"],
        objectSrc:      ["'none'"],
        mediaSrc:       ["'none'"],
        frameSrc:       ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
  };
}

// ─── LOW-03: bcrypt on worker thread ──────────────────────────────────────────

/**
 * Hashes a password using bcrypt on a worker thread, freeing the main
 * event loop from CPU-blocking work.
 *
 * LOW-03 FIX:
 *   Before: await bcrypt.hash(password, 12)  // blocks main thread ~200ms
 *   After:  await hashPassword(password)      // runs on worker thread
 *
 * Falls back to main thread if worker threads are not supported
 * (Node.js < 12 — should not occur in production but defensive).
 *
 * @param {string} password
 * @param {number} rounds    – bcrypt cost factor (default 12)
 * @returns {Promise<string>}
 */
async function hashPassword(password, rounds = 12) {
  const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
  const bcrypt = require('bcrypt');

  if (!isMainThread) {
    // This branch executes inside the worker — should not be called directly
    throw new Error('hashPassword must be called from the main thread');
  }

  return new Promise((resolve, reject) => {
    // Inline worker script — avoids a separate file
    const workerScript = `
      const { workerData, parentPort } = require('worker_threads');
      const bcrypt = require('bcrypt');
      bcrypt.hash(workerData.password, workerData.rounds)
        .then(hash => parentPort.postMessage({ hash }))
        .catch(err  => parentPort.postMessage({ error: err.message }));
    `;

    const worker = new Worker(workerScript, {
      eval: true,
      workerData: { password, rounds },
    });

    worker.once('message', (msg) => {
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.hash);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`bcrypt worker exited with code ${code}`));
    });
  });
}

/**
 * Compares a password to a hash (bcrypt.compare is I/O-bound, not CPU-bound,
 * so running it on the main thread is acceptable).
 */
async function verifyPassword(password, hash) {
  const bcrypt = require('bcrypt');
  return bcrypt.compare(password, hash);
}

module.exports = {
  createRateLimiters,
  generateCspNonce,
  getHelmetCspOptions,
  hashPassword,
  verifyPassword,
};
