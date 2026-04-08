// src/modules/payroll/payroll.repository.js
// ─────────────────────────────────────────────────────────────────
// Payroll Repository — ALL DB operations for payroll domain
// No calculation logic. No HTTP. Only database.
// ─────────────────────────────────────────────────────────────────

'use strict';

const prisma = require('../../config/database');

// ── PayrollRun ────────────────────────────────────────────────────

async function findRun(runId, tenantId) {
  return prisma.payrollRun.findFirst({
    where: { id: runId, tenantId },
  });
}

async function findRunWithRows(runId, tenantId) {
  return prisma.payrollRun.findFirst({
    where: { id: runId, tenantId },
    include: {
      rows: {
        include: {
          employee:   true,
          components: true,
        },
        orderBy: { employee: { sr: 'asc' } },
      },
      tender: {
        include: {
          client:                true,
          legacySalaryStructures: true,
        },
      },
      runByUser: { select: { name: true } },
    },
  });
}

async function findExistingRun(tenderId, month, year) {
  return prisma.payrollRun.findFirst({
    where: { tenderId, month, year },
  });
}

async function createRun(tenantId, tenderId, month, year, runByUserId) {
  return prisma.payrollRun.create({
    data: {
      tenantId,
      tenderId,
      month,
      year,
      status:     'PROCESSING',
      runBy:      runByUserId,
      totalGross: 0,
      totalNet:   0,
      totalPFEE:  0,
      totalPFER:  0,
      totalESIC:  0,
      totalPT:    0,
    },
  });
}

async function updateRunTotals(runId, totals) {
  return prisma.payrollRun.update({
    where: { id: runId },
    data: {
      status:     'COMPLETED',
      totalGross: totals.totalGross,
      totalNet:   totals.totalNet,
      totalPFEE:  totals.totalPFEE,
      totalPFER:  totals.totalPFER,
      totalESIC:  totals.totalESIC,
      totalPT:    totals.totalPT,
    },
  });
}

async function lockRun(runId, lockedByUserId) {
  return prisma.payrollRun.update({
    where: { id: runId },
    data: {
      status:   'LOCKED',
      lockedAt: new Date(),
      lockedBy: lockedByUserId,
    },
  });
}

async function deleteRunRows(runId) {
  return prisma.payrollRow.deleteMany({ where: { runId } });
}

async function deleteRun(runId) {
  return prisma.payrollRun.delete({ where: { id: runId } });
}

async function getRunsByTender(tenderId) {
  return prisma.payrollRun.findMany({
    where:   { tenderId },
    include: { runByUser: { select: { name: true } } },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
  });
}

// ── Tender Data for Payroll ───────────────────────────────────────

/**
 * Load full tender data needed for payroll calculation
 * Includes both old and new salary structures + employees + attendance
 */
async function getTenderForPayroll(tenderId, month, year) {
  return prisma.tender.findUnique({
    where: { id: tenderId },
    include: {
      // New component-based structure
      salaryStructure: {
        include: {
          components: {
            where:   { isActive: true },
            include: { component: true },
            orderBy: { component: { displayOrder: 'asc' } },
          },
        },
      },
      // Old legacy structures (backward compat)
      legacySalaryStructures: true,
      // Active employees with attendance for this month/year
      employees: {
        where: { isActive: true },
        include: {
          employee:   true,
          attendance: {
            where: { month, year },
          },
        },
      },
    },
  });
}

// ── PayrollRow — Batched Save ─────────────────────────────────────

/**
 * Save all payroll rows in a single transaction
 * This is the correct approach for 500+ employees
 * Prevents N+1 writes and ensures atomicity
 *
 * @param {string} runId
 * @param {Array}  rows  - Array of row data objects
 */
async function savePayrollRows(runId, rows) {
  return prisma.$transaction(
    rows.map(row => {
      const { components, ...rowData } = row;
      return prisma.payrollRow.create({
        data: {
          ...rowData,
          runId,
          components: components?.length
            ? { create: components }
            : undefined,
        },
      });
    }),
    { timeout: 120000 } // 2 min timeout for large payrolls
  );
}

// ── PF Challan Data ───────────────────────────────────────────────

async function getPFChallanData(runId, tenantId) {
  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId },
    include: {
      rows: {
        include: { employee: true },
        orderBy: { employee: { sr: 'asc' } },
      },
      tender: { include: { client: true } },
    },
  });
  return run;
}

// ── Transfer Sheet ────────────────────────────────────────────────

async function getTransferSheetData(runId, tenantId) {
  return prisma.payrollRun.findFirst({
    where: { id: runId, tenantId },
    include: {
      rows: {
        include: { employee: true },
        orderBy: { employee: { sr: 'asc' } },
      },
    },
  });
}

// ── PT Config ─────────────────────────────────────────────────────

/**
 * Load PT slabs for a given state
 * Used by payroll engine instead of hardcoded Maharashtra logic
 */
async function getPTConfig(tenantId, state) {
  return prisma.professionalTaxConfig.findUnique({
    where: { tenantId_state: { tenantId, state } },
    include: {
      slabs: { orderBy: { minSalary: 'asc' } },
    },
  });
}

module.exports = {
  findRun,
  findRunWithRows,
  findExistingRun,
  createRun,
  updateRunTotals,
  lockRun,
  deleteRunRows,
  deleteRun,
  getRunsByTender,
  getTenderForPayroll,
  savePayrollRows,
  getPFChallanData,
  getTransferSheetData,
  getPTConfig,
};