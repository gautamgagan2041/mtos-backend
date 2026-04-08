// src/modules/disbursement/disbursement.repository.js
// ─────────────────────────────────────────────────────────────────
// Disbursement Repository — DB layer for payment disbursement
// Tracks salary payment status per employee per payroll run
// ─────────────────────────────────────────────────────────────────

'use strict';

const prisma = require('../../config/database');

/**
 * Create disbursement records for all employees in a payroll run
 * Called after payroll is locked — one record per employee
 * Idempotent — skips employees that already have a record
 */
async function initializeDisbursements(runId, tenantId) {
  // Get all payroll rows for this run
  const rows = await prisma.payrollRow.findMany({
    where: { runId },
    include: { employee: true },
  });

  // Aggregate net pay per employee (split rows are summed)
  const empMap = {};
  for (const row of rows) {
    const id = row.employeeId;
    if (!empMap[id]) {
      empMap[id] = {
        employeeId:  id,
        netPay:      0,
        bankAccount: row.employee.bankAccount || null,
        ifscCode:    row.employee.ifscCode    || null,
        bankName:    row.employee.bankName    || null,
      };
    }
    empMap[id].netPay += row.netPay;
  }

  const employees = Object.values(empMap);

  // Create records — skip existing ones
  const created = [];
  for (const emp of employees) {
    const existing = await prisma.paymentDisbursement.findUnique({
      where: { runId_employeeId: { runId, employeeId: emp.employeeId } },
    });

    if (!existing) {
      const record = await prisma.paymentDisbursement.create({
        data: {
          tenantId:    tenantId,
          runId,
          employeeId:  emp.employeeId,
          netPay:      Math.round(emp.netPay * 100) / 100,
          bankAccount: emp.bankAccount,
          ifscCode:    emp.ifscCode,
          bankName:    emp.bankName,
          status:      'PENDING',
        },
      });
      created.push(record);
    }
  }

  return { created: created.length, skipped: employees.length - created.length };
}

/**
 * Get all disbursement records for a payroll run
 */
async function getDisbursements(runId, tenantId) {
  return prisma.paymentDisbursement.findMany({
    where:   { runId, tenantId },
    include: { employee: { select: { id: true, name: true, sr: true, uan: true } } },
    orderBy: { employee: { sr: 'asc' } },
  });
}

/**
 * Mark a single employee payment as transferred
 */
async function markTransferred(disbursementId, tenantId, data) {
  return prisma.paymentDisbursement.updateMany({
    where: { id: disbursementId, tenantId },
    data: {
      status:       'TRANSFERRED',
      utrNo:        data.utrNo        || null,
      transferredAt: new Date(data.transferredAt || new Date()),
      transferredBy: data.transferredBy,
      failureReason: null,
    },
  });
}

/**
 * Mark a single payment as failed
 */
async function markFailed(disbursementId, tenantId, failureReason) {
  return prisma.paymentDisbursement.updateMany({
    where: { id: disbursementId, tenantId },
    data: {
      status:        'FAILED',
      failureReason: failureReason || 'Payment failed',
    },
  });
}

/**
 * Mark all pending disbursements as transferred in bulk
 * Used for bulk bank transfer confirmation
 */
async function bulkMarkTransferred(runId, tenantId, transferredBy) {
  return prisma.paymentDisbursement.updateMany({
    where: { runId, tenantId, status: 'PENDING' },
    data: {
      status:        'TRANSFERRED',
      transferredAt: new Date(),
      transferredBy,
    },
  });
}

/**
 * Get disbursement summary for a run
 */
async function getDisbursementSummary(runId, tenantId) {
  const records = await prisma.paymentDisbursement.findMany({
    where: { runId, tenantId },
  });

  const summary = {
    total:       records.length,
    pending:     records.filter(r => r.status === 'PENDING').length,
    transferred: records.filter(r => r.status === 'TRANSFERRED').length,
    failed:      records.filter(r => r.status === 'FAILED').length,
    onHold:      records.filter(r => r.status === 'ON_HOLD').length,
    totalAmount:      Math.round(records.reduce((s, r) => s + r.netPay, 0) * 100) / 100,
    transferredAmount: Math.round(
      records.filter(r => r.status === 'TRANSFERRED')
             .reduce((s, r) => s + r.netPay, 0) * 100
    ) / 100,
    pendingAmount: Math.round(
      records.filter(r => r.status === 'PENDING')
             .reduce((s, r) => s + r.netPay, 0) * 100
    ) / 100,
  };

  return { records, summary };
}

module.exports = {
  initializeDisbursements,
  getDisbursements,
  markTransferred,
  markFailed,
  bulkMarkTransferred,
  getDisbursementSummary,
};
