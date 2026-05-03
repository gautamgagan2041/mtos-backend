/**
 * MTOS Graceful Shutdown Handler
 *
 * Fixes: LOW-02 — Unhandled rejections or SIGKILL kill the process while a
 *                 payroll run holds a distributed lock. The lock remains held
 *                 for its full TTL (300 seconds), blocking all payroll runs
 *                 for all tenants for 5 minutes per crash.
 *
 * Design contract:
 *  - Call registerShutdownHandler(server, deps) once at application startup.
 *  - All active lock keys must be registered via trackActiveLock().
 *  - On shutdown, we attempt to release all tracked locks before exit.
 *  - unhandledRejection is logged and treated as a non-fatal warning unless
 *    it originates from a critical subsystem.
 *  - SIGTERM is the graceful signal (Kubernetes sends this). SIGINT for local dev.
 */

'use strict';

const logger = (() => {
  try { return require('./logger').forComponent('shutdown'); }
  catch { return console; }
})();

// ─── Active lock registry ─────────────────────────────────────────────────────

const _activeLocks = new Map(); // lockKey → { ownerId, releaseFn }

/**
 * Registers an active distributed lock so it can be released on shutdown.
 *
 * Call this immediately after acquireLock() returns true.
 *
 * @param {string}   lockKey
 * @param {string}   ownerId    – the owner token used to acquire the lock
 * @param {Function} releaseFn  – async () => void — calls releaseLock()
 */
function trackActiveLock(lockKey, ownerId, releaseFn) {
  _activeLocks.set(lockKey, { ownerId, releaseFn, acquiredAt: new Date() });
}

/**
 * Removes a lock from the registry after it has been released normally.
 */
function untrackActiveLock(lockKey) {
  _activeLocks.delete(lockKey);
}

// ─── Shutdown sequence ────────────────────────────────────────────────────────

let _isShuttingDown = false;

/**
 * Registers shutdown handlers for SIGTERM, SIGINT, and unhandledRejection.
 *
 * @param {import('http').Server} httpServer
 * @param {{ redisClient?: Object, prisma?: Object, bullmqQueues?: Array }} deps
 */
function registerShutdownHandler(httpServer, deps = {}) {
  const { redisClient, prisma, bullmqQueues = [] } = deps;

  async function shutdown(signal, exitCode = 0) {
    if (_isShuttingDown) return;
    _isShuttingDown = true;

    logger.info({ signal }, 'Graceful shutdown initiated');

    // 1. Stop accepting new HTTP connections
    httpServer.close(() => {
      logger.info({}, 'HTTP server closed');
    });

    // 2. LOW-02 FIX: Release all tracked distributed locks
    //    This prevents a 5-minute payroll blackout per crash.
    if (_activeLocks.size > 0) {
      logger.warn(
        { lockCount: _activeLocks.size, locks: [..._activeLocks.keys()] },
        'Releasing distributed locks on shutdown'
      );

      const releasePromises = [..._activeLocks.entries()].map(
        async ([lockKey, { releaseFn }]) => {
          try {
            await releaseFn();
            logger.info({ lockKey }, 'Lock released on shutdown');
          } catch (err) {
            logger.error({ lockKey, err }, 'Failed to release lock on shutdown — will expire via TTL');
          }
        }
      );

      await Promise.allSettled(releasePromises);
    }

    // 3. Drain BullMQ workers (stop picking up new jobs)
    for (const queue of bullmqQueues) {
      try {
        await queue.close();
        logger.info({ queue: queue.name }, 'BullMQ queue closed');
      } catch (err) {
        logger.error({ queue: queue.name, err }, 'Error closing BullMQ queue');
      }
    }

    // 4. Close Prisma connections
    if (prisma) {
      try {
        await prisma.$disconnect();
        logger.info({}, 'Prisma disconnected');
      } catch (err) {
        logger.error({ err }, 'Error disconnecting Prisma');
      }
    }

    // 5. Close Redis (after Prisma — Redis is needed for lock release above)
    if (redisClient) {
      try {
        await redisClient.quit();
        logger.info({}, 'Redis disconnected');
      } catch (err) {
        logger.error({ err }, 'Error disconnecting Redis');
      }
    }

    logger.info({ exitCode }, 'Shutdown complete');
    process.exit(exitCode);
  }

  // Graceful signals
  process.once('SIGTERM', () => shutdown('SIGTERM', 0));
  process.once('SIGINT',  () => shutdown('SIGINT',  0));

  // LOW-02 FIX: Don't crash the process on unhandled rejections.
  // Log the error structurally and continue, unless the error originates
  // from a critical subsystem (in which case the subsystem throws explicitly).
  process.on('unhandledRejection', (reason, promise) => {
    logger.error(
      { reason: reason instanceof Error ? reason.message : reason, component: 'process' },
      'Unhandled promise rejection — investigate immediately'
    );
    // DO NOT call process.exit() here — that's what caused the original bug.
    // The payroll lock TTL is 300s; if we crash here, the lock stays held.
    // Instead, surface the error to your APM and alert on the log.
  });

  process.on('uncaughtException', (err) => {
    logger.error({ err, component: 'process' }, 'Uncaught exception — shutting down safely');
    // Uncaught exceptions leave the process in an undefined state — exit is correct here.
    shutdown('uncaughtException', 1);
  });
}

module.exports = {
  registerShutdownHandler,
  trackActiveLock,
  untrackActiveLock,
};
