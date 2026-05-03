/**
 * MTOS Disbursement Repository
 *
 * Fixes: CRIT-04 — decryptPII() is now called before bankAccount / ifscCode
 *                  are read from the DB row. Previously, the raw AES-256-GCM
 *                  ciphertext was sent as the wire transfer destination, making
 *                  all salary payments impossible.
 *
 * Design contract:
 *  - initializeDisbursements() is the ONLY function that builds the empMap.
 *  - empMap values MUST contain decrypted PII — never raw DB rows.
 *  - Any future field added to PII_FIELDS must be decrypted here automatically
 *    because decryptPII() iterates PII_FIELDS internally.
 */

'use strict';

const { decryptPII } = require('../../utils/encryption');

// ─── initializeDisbursements ──────────────────────────────────────────────────

/**
 * Fetches payroll rows for a run and builds an employee-keyed disbursement map.
 *
 * CRIT-04 FIX:
 *   Before: bankAccount: row.employee.bankAccount  // ← raw ciphertext
 *   After:  const emp = decryptPII(row.employee)   // ← plaintext
 *           bankAccount: emp.bankAccount
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} tenantId
 * @param {string} runId
 * @returns {Promise<Map<string, DisbursementEntry>>}
 */
async function initializeDisbursements(prisma, tenantId, runId) {
  if (!tenantId) throw new Error('initializeDisbursements: tenantId is required');
  if (!runId)    throw new Error('initializeDisbursements: runId is required');

  const rows = await prisma.payrollRow.findMany({
    where: { payrollRunId: runId, tenantId },
    include: {
      employee: {
        select: {
          id:          true,
          employeeCode: true,
          fullName:    true,
          // Encrypted PII fields — decryptPII() will decrypt these
          bankAccount: true,
          ifscCode:    true,
          // Non-PII fields
          bankName:    true,
        },
      },
    },
  });

  const empMap = new Map();

  for (const row of rows) {
    if (!row.employee) {
      // Defensive: row references a deleted/detached employee
      continue;
    }

    // CRIT-04 FIX: Decrypt all PII fields before reading bankAccount / ifscCode.
    //              decryptPII() is idempotent — safe to call multiple times.
    const emp = decryptPII(row.employee);

    // Validate that decryption produced a plausible bank account
    // (not still ciphertext). Log a warning if validation fails so the
    // disbursement file can be blocked before reaching the payment gateway.
    if (emp.bankAccount && looksLikeCiphertext(emp.bankAccount)) {
      throw new DisbursementEncryptionError(
        emp.id,
        `bankAccount for employee "${emp.employeeCode}" still appears to be ` +
        `ciphertext after decryption. Possible key mismatch (CRIT-01/CRIT-02). ` +
        `Aborting disbursement to prevent corrupt wire transfer.`
      );
    }

    empMap.set(row.employeeId, {
      employeeId:   emp.id,
      employeeCode: emp.employeeCode,
      fullName:     emp.fullName,
      bankAccount:  emp.bankAccount || null,   // decrypted plaintext
      ifscCode:     emp.ifscCode    || null,   // decrypted plaintext
      bankName:     emp.bankName    || null,
      netPay:       row.netPay,
      payrollRowId: row.id,
    });
  }

  return empMap;
}

// ─── createDisbursementFile ───────────────────────────────────────────────────

/**
 * Creates the disbursement file record and individual transfer entries.
 * All bank details stored here are plaintext (decrypted by initializeDisbursements).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} tenantId
 * @param {string} runId
 * @param {Map}    empMap   – result from initializeDisbursements()
 * @param {Object} metadata – { generatedBy, bankCode, valueDate }
 */
async function createDisbursementFile(prisma, tenantId, runId, empMap, metadata) {
  if (!tenantId) throw new Error('createDisbursementFile: tenantId is required');

  const entries = [...empMap.values()].filter((e) => e.bankAccount && e.ifscCode);

  if (entries.length === 0) {
    throw new Error(
      `createDisbursementFile: no valid bank details found for run "${runId}". ` +
      `Check that all employees have bankAccount and ifscCode set.`
    );
  }

  return prisma.$transaction(async (tx) => {
    const file = await tx.disbursementFile.create({
      data: {
        tenantId,
        payrollRunId: runId,
        generatedBy:  metadata.generatedBy,
        bankCode:     metadata.bankCode,
        valueDate:    metadata.valueDate || new Date(),
        totalRecords: entries.length,
        totalAmount:  entries.reduce((sum, e) => sum + Number(e.netPay), 0),
        status:       'GENERATED',
      },
    });

    await tx.disbursementEntry.createMany({
      data: entries.map((e) => ({
        tenantId,
        disbursementFileId: file.id,
        employeeId:   e.employeeId,
        payrollRowId: e.payrollRowId,
        bankAccount:  e.bankAccount,  // plaintext at this point
        ifscCode:     e.ifscCode,     // plaintext at this point
        bankName:     e.bankName,
        amount:       e.netPay,
        status:       'PENDING',
      })),
    });

    return file;
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Heuristic: does this value look like AES-256-GCM ciphertext in our wire format?
 * Pattern: "<24 hex>:<32 hex>:<N hex>"
 */
function looksLikeCiphertext(value) {
  return /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/.test(value);
}

class DisbursementEncryptionError extends Error {
  constructor(employeeId, message) {
    super(message);
    this.code       = 'DISBURSEMENT_ENCRYPTION_ERROR';
    this.employeeId = employeeId;
  }
}

module.exports = {
  initializeDisbursements,
  createDisbursementFile,
  DisbursementEncryptionError,
  looksLikeCiphertext,
};
