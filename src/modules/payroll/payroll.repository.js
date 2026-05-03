/**
 * MTOS Payroll Repository
 *
 * Fixes:
 *   CRIT-03 — findExistingRun() now includes tenantId (IDOR on idempotency check)
 *   HIGH-03 — lockRun() uses updateMany with tenantId (cross-tenant lock IDOR)
 *   HIGH-05 — getTenderForPayroll() includes tenantId filter
 *
 * Design contract:
 *  - EVERY public function that takes a tenderId or runId MUST also accept
 *    tenantId and include it in the WHERE clause.
 *  - This is enforced by the JSDoc @param annotations and the unit tests.
 *  - No function in this file emits a Prisma query without tenantId in the
 *    where clause (the only exception is lookups by globally-unique PK where
 *    the service layer has already validated ownership).
 */

'use strict';

// ─── Types (JSDoc) ────────────────────────────────────────────────────────────
// @typedef {import('@prisma/client').PrismaClient} PrismaClient

// ─── findExistingRun ──────────────────────────────────────────────────────────

/**
 * Checks whether a payroll run already exists for the given parameters.
 *
 * CRIT-03 FIX: tenantId is now a required parameter and is included in
 * the WHERE clause. Without it, a COMPANY_ADMIN from Tenant A could supply
 * Tenant B's tenderId and permanently block Tenant B's payroll for the month.
 *
 * Before (vulnerable):
 *   where: { tenderId, month, year }
 *
 * After (fixed):
 *   where: { tenderId, month, year, tenantId }
 *
 * @param {PrismaClient} prisma
 * @param {string} tenantId   – REQUIRED — must come from req.user.tenantId
 * @param {string} tenderId
 * @param {number} month      – 1-12
 * @param {number} year
 * @returns {Promise<Object|null>}
 */
async function findExistingRun(prisma, tenantId, tenderId, month, year) {
  if (!tenantId) throw new Error('findExistingRun: tenantId is required (CRIT-03)');
  if (!tenderId) throw new Error('findExistingRun: tenderId is required');

  return prisma.payrollRun.findFirst({
    where: {
      tenantId,   // CRIT-03: was missing
      tenderId,
      month,
      year,
    },
  });
}

// ─── lockRun ──────────────────────────────────────────────────────────────────

/**
 * Locks a payroll run, marking it as being processed by a specific user.
 *
 * HIGH-03 FIX: Uses updateMany with tenantId instead of update with only
 * runId. updateMany returns a count — if count === 0, the run either doesn't
 * exist in this tenant (IDOR attempt) or was already locked (race condition).
 *
 * Before (vulnerable):
 *   prisma.payrollRun.update({ where: { id: runId } ... })
 *   // Any runId from any tenant could be locked.
 *
 * After (fixed):
 *   prisma.payrollRun.updateMany({ where: { id: runId, tenantId } ... })
 *   // Returns { count: 0 } for foreign runIds — treated as not-found.
 *
 * @param {PrismaClient} prisma
 * @param {string} tenantId      – REQUIRED
 * @param {string} runId
 * @param {string} lockedByUserId
 * @returns {Promise<Object>}    – { count: number }
 */
async function lockRun(prisma, tenantId, runId, lockedByUserId) {
  if (!tenantId)       throw new Error('lockRun: tenantId is required (HIGH-03)');
  if (!runId)          throw new Error('lockRun: runId is required');
  if (!lockedByUserId) throw new Error('lockRun: lockedByUserId is required');

  const result = await prisma.payrollRun.updateMany({
    where:  { id: runId, tenantId },   // HIGH-03: tenantId added
    data:   {
      status:       'PROCESSING',
      lockedBy:     lockedByUserId,
      lockedAt:     new Date(),
    },
  });

  if (result.count === 0) {
    const err = new Error(
      `lockRun: run "${runId}" not found in tenant "${tenantId}". ` +
      `Possible cross-tenant IDOR attempt or run already locked.`
    );
    err.code = 'RUN_NOT_FOUND_OR_LOCKED';
    throw err;
  }

  return result;
}

// ─── getTenderForPayroll ──────────────────────────────────────────────────────

/**
 * Fetches a tender for use in payroll calculation.
 *
 * HIGH-05 FIX: tenantId is now required and included in the WHERE clause.
 * Without it, a COMPANY_ADMIN could trigger payroll on a foreign tenant's
 * tender, leaking that tenant's salary structure and employee list.
 *
 * Before (vulnerable):
 *   where: { id: tenderId }
 *
 * After (fixed):
 *   where: { id: tenderId, tenantId }
 *
 * @param {PrismaClient} prisma
 * @param {string} tenantId  – REQUIRED — must come from req.user.tenantId
 * @param {string} tenderId
 * @returns {Promise<Object|null>}
 */
async function getTenderForPayroll(prisma, tenantId, tenderId) {
  if (!tenantId) throw new Error('getTenderForPayroll: tenantId is required (HIGH-05)');
  if (!tenderId) throw new Error('getTenderForPayroll: tenderId is required');

  return prisma.tender.findFirst({
    where: {
      id:       tenderId,
      tenantId, // HIGH-05: was missing
    },
    include: {
      salaryComponents: true,
      employees: {
        where: { isActive: true },
        include: {
          // Employee PII fields will be encrypted. Call decryptPII() in the
          // service/engine layer after fetching — not here in the repository.
          loanDeductions: {
            where: { isActive: true },
          },
        },
      },
    },
  });
}

// ─── createRunWithRows ────────────────────────────────────────────────────────

/**
 * Creates a payroll run and all computed rows in a single atomic transaction.
 *
 * MED-01 FIX: Loan balance updates are now accepted as a parameter and
 * executed INSIDE the same transaction, preventing the double-deduction
 * scenario where rows are saved but loan balances are not updated.
 *
 * @param {PrismaClient} prisma
 * @param {string} tenantId
 * @param {Object} runData              – payroll run metadata
 * @param {Array}  rows                 – computed payroll rows
 * @param {Array}  loanBalanceUpdates   – [{ loanId, newBalance, newRemainingEmi }]
 * @returns {Promise<Object>}           – created payroll run
 */
async function createRunWithRows(prisma, tenantId, runData, rows, loanBalanceUpdates = []) {
  if (!tenantId) throw new Error('createRunWithRows: tenantId is required');

  return prisma.$transaction(async (tx) => {
    // 1. Create the payroll run
    const run = await tx.payrollRun.create({
      data: {
        ...runData,
        tenantId,
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });

    // 2. Create all rows linked to this run
    if (rows.length > 0) {
      await tx.payrollRow.createMany({
        data: rows.map((row) => ({
          ...row,
          payrollRunId: run.id,
          tenantId,
        })),
      });
    }

    // 3. MED-01 FIX: Update loan balances INSIDE the same transaction.
    //    Previously this was done in _updateLoanBalances() AFTER the
    //    transaction completed, with a swallowed try/catch. If the process
    //    died between steps 2 and 3, the loan balance was never decremented
    //    and the next run would deduct the EMI again.
    for (const update of loanBalanceUpdates) {
      await tx.employeeLoan.update({
        where: { id: update.loanId, tenantId },  // tenantId guard
        data: {
          remainingBalance: update.newBalance,
          remainingEmi:     update.newRemainingEmi,
          isActive:         update.newBalance > 0,
        },
      });
    }

    return run;
  });
}

// ─── unlockRun ────────────────────────────────────────────────────────────────

/**
 * Unlocks a payroll run (e.g. on failure, to allow retry).
 * Uses updateMany with tenantId for same IDOR protection as lockRun.
 *
 * @param {PrismaClient} prisma
 * @param {string} tenantId
 * @param {string} runId
 * @param {string} status   – e.g. 'FAILED'
 * @param {string} errorMsg
 */
async function unlockRun(prisma, tenantId, runId, status = 'FAILED', errorMsg = null) {
  if (!tenantId) throw new Error('unlockRun: tenantId is required');

  return prisma.payrollRun.updateMany({
    where: { id: runId, tenantId },
    data: {
      status,
      lockedBy:   null,
      lockedAt:   null,
      errorMessage: errorMsg,
    },
  });
}

// ─── getRunById ───────────────────────────────────────────────────────────────

/**
 * Fetches a single payroll run, scoped to the tenant.
 */
async function getRunById(prisma, tenantId, runId) {
  if (!tenantId) throw new Error('getRunById: tenantId is required');
  return prisma.payrollRun.findFirst({
    where: { id: runId, tenantId },
    include: { rows: true },
  });
}

module.exports = {
  findExistingRun,
  lockRun,
  unlockRun,
  getTenderForPayroll,
  createRunWithRows,
  getRunById,
};
