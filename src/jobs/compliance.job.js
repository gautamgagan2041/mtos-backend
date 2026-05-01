'use strict';

/**
 * compliance.job.js — BullMQ Scheduled Compliance Jobs
 *
 * REPLACES: src/services/cronService.js
 *
 * WHY BULLMQ INSTEAD OF node-cron:
 *   node-cron runs on EVERY Node instance simultaneously.
 *   With 3 PM2 instances: same cron fires 3 times → 3x duplicate alerts.
 *   BullMQ scheduled jobs run exactly ONCE across all instances.
 *
 * JOBS:
 *   compliance-expiry-check  → Daily at 08:00 IST
 *   pf-filing-reminder       → Monthly on 5th at 09:00 IST
 *   esic-filing-reminder     → Monthly on 15th at 09:00 IST
 *   tender-expiry-check      → Daily at 08:30 IST
 */

const { Queue, Worker }    = require('bullmq');
const prisma               = require('../config/database');
const logger               = require('../utils/logger');
const cache                = require('../services/cacheService');
const notificationService  = require('../services/notificationService');

const connection = {
  host:     process.env.REDIS_HOST     || 'localhost',
  port:     parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
  maxRetriesPerRequest: null,
};

const COMPLIANCE_QUEUE = 'mtos-compliance';

const complianceQueue = new Queue(COMPLIANCE_QUEUE, { connection });

// ── Schedule recurring jobs (idempotent — safe to call on every startup) ──

async function scheduleComplianceJobs() {
  // Daily document expiry check — 08:00 IST (02:30 UTC)
  await complianceQueue.upsertJobScheduler(
    'compliance-expiry-daily',
    { pattern: '30 2 * * *', tz: 'UTC' },
    {
      name: 'check-compliance-expiry',
      data: { type: 'DOCUMENT_EXPIRY' },
      opts: {
        removeOnComplete: { count: 7 },
        removeOnFail:     { count: 30 },
      },
    }
  );

  // Monthly PF filing reminder — 5th of each month, 09:00 IST
  await complianceQueue.upsertJobScheduler(
    'pf-filing-reminder-monthly',
    { pattern: '30 3 5 * *', tz: 'UTC' },
    {
      name: 'pf-filing-reminder',
      data: { type: 'PF_FILING' },
    }
  );

  // Monthly ESIC filing reminder — 15th of each month
  await complianceQueue.upsertJobScheduler(
    'esic-filing-reminder-monthly',
    { pattern: '30 3 15 * *', tz: 'UTC' },
    {
      name: 'esic-filing-reminder',
      data: { type: 'ESIC_FILING' },
    }
  );

  // Daily tender expiry check — 08:30 IST
  await complianceQueue.upsertJobScheduler(
    'tender-expiry-daily',
    { pattern: '0 3 * * *', tz: 'UTC' },
    {
      name: 'check-tender-expiry',
      data: { type: 'TENDER_EXPIRY' },
    }
  );

  logger.info('[ComplianceJobs] Scheduled jobs registered');
}

// ── Worker ────────────────────────────────────────────────────────

function createComplianceWorker() {
  const worker = new Worker(
    COMPLIANCE_QUEUE,
    async (job) => {
      const { type } = job.data;
      logger.info(`[ComplianceWorker] Processing job: ${type}`);

      switch (type) {
        case 'DOCUMENT_EXPIRY': return checkAllTenantsDocumentExpiry();
        case 'PF_FILING':       return sendPFFilingReminders();
        case 'ESIC_FILING':     return sendESICFilingReminders();
        case 'TENDER_EXPIRY':   return checkTenderExpiry();
        default:
          logger.warn(`[ComplianceWorker] Unknown job type: ${type}`);
      }
    },
    {
      connection,
      concurrency: 1, // Compliance jobs are sequential — avoid DB overload
    }
  );

  worker.on('failed', (job, err) => {
    logger.error(`[ComplianceWorker] Job ${job?.id} (${job?.data?.type}) failed: ${err.message}`);
  });

  return worker;
}

// ── Job Handlers ──────────────────────────────────────────────────

/**
 * checkAllTenantsDocumentExpiry
 * Process all active tenants sequentially with distributed lock
 */
async function checkAllTenantsDocumentExpiry() {
  const tenants = await prisma.tenant.findMany({
    where:  { status: 'ACTIVE' },
    select: { id: true, name: true },
  });

  logger.info(`[ComplianceWorker] Checking document expiry for ${tenants.length} tenants`);
  let totalAlerts = 0;

  for (const tenant of tenants) {
    try {
      // Per-tenant lock: prevents double-processing if job retries
      const lockKey = `compliance-expiry:${tenant.id}:${_todayKey()}`;
      const lockId  = await cache.acquireLock(lockKey, 300); // 5 min lock
      if (!lockId) {
        logger.info(`[ComplianceWorker] Skipping tenant ${tenant.id} — already processed today`);
        continue;
      }

      const alerts = await _processDocumentExpiry(tenant.id);
      totalAlerts += alerts;

      await cache.releaseLock(lockKey, lockId);
    } catch (err) {
      logger.error(`[ComplianceWorker] Error for tenant ${tenant.id}: ${err.message}`);
      // Continue with next tenant — don't fail the whole job
    }
  }

  logger.info(`[ComplianceWorker] Document expiry check complete. Created ${totalAlerts} alerts`);
  return { tenantsProcessed: tenants.length, alertsCreated: totalAlerts };
}

async function _processDocumentExpiry(tenantId) {
  const now  = new Date();
  let alerts = 0;

  const docs = await prisma.complianceDocument.findMany({
    where: {
      tenantId,
      isActive:   true,
      expiryDate: { not: null, gte: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000) },
    },
    include: { tender: { select: { name: true } } },
  });

  for (const doc of docs) {
    const daysLeft = Math.ceil((new Date(doc.expiryDate) - now) / 86_400_000);

    const thresholds = [
      { days: 90, field: 'alert90Sent', type: 'COMPLIANCE_EXPIRY_90D', severity: 'MEDIUM' },
      { days: 60, field: 'alert60Sent', type: 'COMPLIANCE_EXPIRY_60D', severity: 'HIGH' },
      { days: 30, field: 'alert30Sent', type: 'COMPLIANCE_EXPIRY_30D', severity: 'CRITICAL' },
    ];

    for (const { days, field, type, severity } of thresholds) {
      if (daysLeft <= days && !doc[field]) {
        await _createAlert({
          tenantId,
          tenderId:  doc.tenderId,
          type,
          severity,
          entityId:  doc.id,
          title:     `${doc.name} expires in ${daysLeft} days`,
          message:   `Document "${doc.name}" for ${doc.tender?.name || 'a tender'} ` +
                     `expires on ${new Date(doc.expiryDate).toLocaleDateString('en-IN')}. ` +
                     `${daysLeft <= 30 ? 'IMMEDIATE renewal required.' : 'Please renew soon.'}`,
        });

        await prisma.complianceDocument.update({
          where: { id: doc.id },
          data:  { [field]: true },
        });

        alerts++;
        break; // Only one alert per doc per day
      }
    }

    // Expired — create if not already alerted today
    if (daysLeft <= 0) {
      const existingExpired = await prisma.complianceAlert.findFirst({
        where: { entityId: doc.id, alertType: 'COMPLIANCE_EXPIRED', isResolved: false },
      });
      if (!existingExpired) {
        await _createAlert({
          tenantId,
          tenderId: doc.tenderId,
          type:     'COMPLIANCE_EXPIRED',
          severity: 'CRITICAL',
          entityId:  doc.id,
          title:    `${doc.name} has EXPIRED`,
          message:  `Document "${doc.name}" expired ${Math.abs(daysLeft)} days ago. ` +
                    `This may violate statutory requirements and cause penalty.`,
        });
        alerts++;
      }
    }
  }

  return alerts;
}

/**
 * sendPFFilingReminders — check if PF challan filed this month
 */
async function sendPFFilingReminders() {
  const now         = new Date();
  const month       = now.getMonth() === 0 ? 12 : now.getMonth();     // Previous month
  const year        = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();

  // Find completed payroll runs where PF was not marked as filed
  const unfiledRuns = await prisma.payrollRun.findMany({
    where: {
      month,
      year,
      status:    { in: ['COMPLETED', 'LOCKED'] },
      pfFiled:   false,
    },
    include: {
      tenant: { select: { id: true, name: true } },
      tender: { select: { name: true } },
    },
  });

  for (const run of unfiledRuns) {
    await _createAlert({
      tenantId: run.tenantId,
      tenderId: run.tenderId,
      type:     'PF_CHALLAN_NOT_FILED',
      severity: 'HIGH',
      entityId:  run.id,
      title:    `PF Challan not filed for ${run.tender?.name} — ${month}/${year}`,
      message:  `PF challan for month ${month}/${year} has not been filed. ` +
                `Due date is 15th of current month. Late filing attracts ₹5/day penalty.`,
    });
  }

  logger.info(`[ComplianceWorker] PF reminders: ${unfiledRuns.length} unfiled challans`);
  return { unfiledCount: unfiledRuns.length };
}

/**
 * sendESICFilingReminders — check if ESIC return filed this month
 */
async function sendESICFilingReminders() {
  const now   = new Date();
  const month = now.getMonth() === 0 ? 12 : now.getMonth();
  const year  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();

  const unfiledRuns = await prisma.payrollRun.findMany({
    where: {
      month,
      year,
      status:    { in: ['COMPLETED', 'LOCKED'] },
      esicFiled: false,
    },
    include: {
      tenant: { select: { id: true } },
      tender: { select: { name: true } },
    },
  });

  for (const run of unfiledRuns) {
    await _createAlert({
      tenantId: run.tenantId,
      tenderId: run.tenderId,
      type:     'ESIC_RETURN_NOT_FILED',
      severity: 'HIGH',
      entityId:  run.id,
      title:    `ESIC Return not filed for ${run.tender?.name} — ${month}/${year}`,
      message:  `ESIC monthly return for ${month}/${year} not filed. ` +
                `Due date: 21st of next month. Penalty: ₹5000 or twice contribution amount.`,
    });
  }

  return { unfiledCount: unfiledRuns.length };
}

/**
 * checkTenderExpiry — alert when tenders are about to expire
 */
async function checkTenderExpiry() {
  const now          = new Date();
  const in30Days     = new Date(now.getTime() + 30 * 86_400_000);
  const in60Days     = new Date(now.getTime() + 60 * 86_400_000);

  const expiringTenders = await prisma.tender.findMany({
    where: {
      status:  'ACTIVE',
      endDate: { lte: in60Days, gte: now },
    },
    include: {
      tenant: { select: { id: true } },
      client: { select: { name: true } },
      _count: { select: { employees: { where: { isActive: true } } } },
    },
  });

  for (const tender of expiringTenders) {
    const daysLeft = Math.ceil((new Date(tender.endDate) - now) / 86_400_000);
    const severity = daysLeft <= 30 ? 'CRITICAL' : 'HIGH';

    await _createAlert({
      tenantId: tender.tenantId,
      tenderId: tender.id,
      type:     'TENDER_EXPIRY',
      severity,
      entityId:  tender.id,
      title:    `Tender "${tender.name}" expires in ${daysLeft} days`,
      message:  `Tender for ${tender.client?.name} expires on ` +
                `${new Date(tender.endDate).toLocaleDateString('en-IN')}. ` +
                `${tender._count.employees} employees currently deployed. ` +
                `Initiate renewal immediately to avoid disruption.`,
    });
  }

  return { expiringCount: expiringTenders.length };
}

// ── Shared Alert Creator ──────────────────────────────────────────

async function _createAlert({ tenantId, tenderId, type, severity, entityId, title, message }) {
  // Idempotent: don't duplicate unresolved alerts of same type for same entity
  const existing = await prisma.complianceAlert.findFirst({
    where: { entityId, alertType: type, isResolved: false },
  });
  if (existing) return existing;

  const alert = await prisma.complianceAlert.create({
    data: {
      tenantId,
      tenderId:   tenderId || null,
      entityType: 'COMPLIANCE_DOC',
      entityId,
      alertType:  type,
      severity,
      title,
      message,
      isResolved: false,
    },
  });

  // Fire-and-forget notification (email/WhatsApp)
  notificationService.sendComplianceAlert(tenantId, alert).catch(err => {
    logger.warn(`[ComplianceWorker] Notification failed: ${err.message}`);
  });

  return alert;
}

// ── Helpers ───────────────────────────────────────────────────────

function _todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

module.exports = {
  complianceQueue,
  scheduleComplianceJobs,
  createComplianceWorker,
};
