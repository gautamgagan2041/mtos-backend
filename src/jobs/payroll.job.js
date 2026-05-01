'use strict';

/**
 * payroll.job.js — BullMQ Async Payroll Processing
 *
 * WHY THIS EXISTS:
 *   Payroll for 300+ employees takes 8–30 seconds.
 *   HTTP timeout is typically 30s (nginx, load balancer).
 *   Synchronous payroll = timeouts, duplicate runs, and angry clients.
 *
 * HOW IT WORKS:
 *   1. POST /api/payroll/run → enqueues job → returns { jobId } immediately
 *   2. Worker processes job in background (separate Node process or same)
 *   3. Frontend polls GET /api/payroll/run/status/:jobId → { state, progress, result }
 *   4. On completion: WebSocket push OR frontend polling detects COMPLETED
 *
 * INSTALL:
 *   npm install bullmq ioredis
 *
 * SCALE:
 *   - Set concurrency: 3 → 3 payrolls run simultaneously (tune based on CPU)
 *   - Deploy multiple workers: node src/jobs/worker.js (separate PM2 process)
 *   - BullMQ handles deduplication, retries, backoff automatically
 */

const { Queue, Worker, QueueEvents } = require('bullmq');
const payrollService = require('../modules/payroll/payroll.service');
const auditService   = require('../services/auditService');
const logger         = require('../utils/logger');

// ── Redis Connection Config ───────────────────────────────────────

const connection = {
  host:     process.env.REDIS_HOST     || 'localhost',
  port:     parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
  maxRetriesPerRequest: null, // Required by BullMQ
};

// ── Queue Definition ──────────────────────────────────────────────

const QUEUE_NAME = 'mtos-payroll';

const payrollQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts:    3,           // Retry up to 3 times on failure
    backoff: {
      type:    'exponential',
      delay:   5000,          // 5s → 25s → 125s
    },
    removeOnComplete: {
      age:   24 * 3600,       // Keep completed jobs for 24 hours
      count: 1000,            // Keep last 1000 completed
    },
    removeOnFail: {
      age: 7 * 24 * 3600,    // Keep failed jobs for 7 days for debugging
    },
  },
});

// ── Queue Events (for logging/alerting) ───────────────────────────

const queueEvents = new QueueEvents(QUEUE_NAME, { connection });

queueEvents.on('completed', ({ jobId }) => {
  logger.info(`[PayrollQueue] Job ${jobId} completed`);
});

queueEvents.on('failed', ({ jobId, failedReason }) => {
  logger.error(`[PayrollQueue] Job ${jobId} failed: ${failedReason}`);
});

queueEvents.on('stalled', ({ jobId }) => {
  logger.warn(`[PayrollQueue] Job ${jobId} stalled — worker may have crashed`);
});

// ── Worker ────────────────────────────────────────────────────────

/**
 * createWorker — start the payroll job processor
 * Call this from your main index.js OR a separate worker.js process
 *
 * RECOMMENDED: Separate process
 *   // package.json scripts:
 *   "worker": "node src/jobs/worker.js"
 *   // PM2: pm2 start ecosystem.config.js
 */
function createWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { tenantId, tenderId, month, year, runByUserId } = job.data;

      logger.info(
        `[PayrollWorker] Processing job ${job.id} | ` +
        `Tenant: ${tenantId} | Tender: ${tenderId} | ${month}/${year}`
      );

      // Progress: 5% — job started
      await job.updateProgress(5);

      // Run payroll (the heavy computation)
      const result = await payrollService.runPayroll(
        tenantId, tenderId, month, year, runByUserId
      );

      // Progress: 90% — payroll done, saving audit
      await job.updateProgress(90);

      // Audit log the completion
      await auditService.log({
        tenantId,
        userId:     runByUserId,
        action:     'RUN_PAYROLL',
        entityType: 'PAYROLL_RUN',
        entityId:   result.runId,
        metadata:   {
          jobId:      job.id,
          tenderId,
          month,
          year,
          rowCount:   result.rowCount,
          totalGross: result.totalGross,
          totalNet:   result.totalNet,
        },
      });

      await job.updateProgress(100);

      return {
        runId:      result.runId,
        rowCount:   result.rowCount,
        totalGross: result.totalGross,
        totalNet:   result.totalNet,
        totals:     result.totals,
      };
    },
    {
      connection,
      concurrency: parseInt(process.env.PAYROLL_WORKER_CONCURRENCY || '3'),
      // Lock duration: if worker crashes, job re-queues after this ms
      lockDuration: 300_000, // 5 minutes
      stalledInterval: 30_000, // Check for stalled jobs every 30s
    }
  );

  worker.on('completed', (job, result) => {
    logger.info(
      `[PayrollWorker] Job ${job.id} completed | ` +
      `Run: ${result.runId} | Rows: ${result.rowCount} | ` +
      `Gross: ₹${result.totalGross}`
    );
  });

  worker.on('failed', (job, err) => {
    logger.error(
      `[PayrollWorker] Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`
    );
  });

  worker.on('error', (err) => {
    logger.error(`[PayrollWorker] Worker error: ${err.message}`);
  });

  logger.info(`[PayrollWorker] Started with concurrency=${worker.opts.concurrency}`);
  return worker;
}

// ── Public API: Enqueue ───────────────────────────────────────────

/**
 * enqueuePayroll — add payroll job to queue
 *
 * Deduplication: BullMQ job ID is deterministic:
 *   "payroll:{tenderId}:{month}:{year}"
 * If same job is enqueued twice, second call is a no-op.
 *
 * @returns {{ jobId: string, alreadyQueued: boolean }}
 */
async function enqueuePayroll({ tenantId, tenderId, month, year, runByUserId }) {
  const jobId = `payroll:${tenderId}:${month}:${year}`;

  // Check if already queued
  const existing = await payrollQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'active' || state === 'waiting' || state === 'delayed') {
      return { jobId, alreadyQueued: true, state };
    }
  }

  const job = await payrollQueue.add(
    'run-payroll',
    { tenantId, tenderId, month: Number(month), year: Number(year), runByUserId },
    {
      jobId,         // Deterministic ID enables deduplication
      priority: 1,   // Normal priority (lower number = higher priority)
    }
  );

  logger.info(
    `[PayrollQueue] Enqueued job ${job.id} | ` +
    `Tenant: ${tenantId} | Tender: ${tenderId} | ${month}/${year}`
  );

  return { jobId: job.id, alreadyQueued: false };
}

/**
 * getJobStatus — poll job state from frontend
 *
 * States: waiting | active | completed | failed | delayed | paused
 *
 * @returns {{
 *   state: string,
 *   progress: number,
 *   result?: object,
 *   failedReason?: string,
 *   processedAt?: Date,
 *   finishedAt?: Date,
 * }}
 */
async function getJobStatus(jobId) {
  const job = await payrollQueue.getJob(jobId);

  if (!job) {
    return { state: 'not_found', progress: 0 };
  }

  const state = await job.getState();

  return {
    state,
    progress:      job.progress || 0,
    attemptsMade:  job.attemptsMade,
    result:        state === 'completed' ? await job.returnvalue : null,
    failedReason:  state === 'failed'    ? job.failedReason       : null,
    processedAt:   job.processedOn  ? new Date(job.processedOn)  : null,
    finishedAt:    job.finishedOn   ? new Date(job.finishedOn)   : null,
  };
}

/**
 * cancelJob — cancel a waiting job (cannot cancel active jobs)
 */
async function cancelJob(jobId) {
  const job = await payrollQueue.getJob(jobId);
  if (!job) return false;

  const state = await job.getState();
  if (state === 'active') {
    throw new Error('Cannot cancel a payroll run that is already processing');
  }

  await job.remove();
  return true;
}

/**
 * getQueueMetrics — for admin dashboard
 */
async function getQueueMetrics() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    payrollQueue.getWaitingCount(),
    payrollQueue.getActiveCount(),
    payrollQueue.getCompletedCount(),
    payrollQueue.getFailedCount(),
    payrollQueue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed };
}

module.exports = {
  payrollQueue,
  createWorker,
  enqueuePayroll,
  getJobStatus,
  cancelJob,
  getQueueMetrics,
};
