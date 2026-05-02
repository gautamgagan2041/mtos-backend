// src/modules/disbursement/disbursement.service.js
'use strict';

const repository     = require('./disbursement.repository');
const payrollRepo    = require('../payroll/payroll.repository');

/**
 * Initialize disbursements for a locked payroll run
 * Must be called after payroll is locked
 */
async function initializeDisbursements(runId, tenantId) {
  // Verify run exists and is locked
  const run = await payrollRepo.findRun(runId, tenantId);
  if (!run) throw new Error('Payroll run not found');
  if (run.status !== 'LOCKED') {
    throw new Error(
      `Cannot initialize disbursements — payroll status is "${run.status}". ` +
      `Payroll must be LOCKED first.`
    );
  }

  return repository.initializeDisbursements(runId, tenantId);
}

/**
 * Get all disbursement records with summary
 */
async function getDisbursements(runId, tenantId) {
  const run = await payrollRepo.findRun(runId, tenantId);
  if (!run) throw new Error('Payroll run not found');

  return repository.getDisbursementSummary(runId, tenantId);
}

/**
 * Mark single payment as transferred — records UTR
 */
async function markTransferred(disbursementId, tenantId, utrNo, transferredBy) {
  if (!utrNo || utrNo.trim().length === 0) {
    throw new Error('UTR number is required to mark payment as transferred');
  }

  await repository.markTransferred(disbursementId, tenantId, {
    utrNo:         utrNo.trim(),
    transferredAt: new Date(),
    transferredBy,
  });

  return { success: true, message: `Payment marked as transferred. UTR: ${utrNo}` };
}

/**
 * Mark payment as failed
 */
async function markFailed(disbursementId, tenantId, failureReason) {
  await repository.markFailed(disbursementId, tenantId, failureReason);
  return { success: true, message: 'Payment marked as failed' };
}

/**
 * Bulk mark all pending as transferred
 */
async function bulkMarkTransferred(runId, tenantId, transferredBy, batchRef) {
  const ref = batchRef || ('BULK-' + runId.slice(-8).toUpperCase() + '-' + Date.now());
  const result = await repository.bulkMarkTransferred(runId, tenantId, transferredBy, ref);
  return {
    success: true,
    message: `${result.count} payments marked as transferred`,
    count:   result.count,
  };
}

module.exports = {
  initializeDisbursements,
  getDisbursements,
  markTransferred,
  markFailed,
  bulkMarkTransferred,
};
