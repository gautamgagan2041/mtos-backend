'use strict';

/**
 * payroll.service.js — v4
 *
 * FIXES vs v3:
 *  1. Idempotency check BEFORE creating any DB records
 *  2. Clear error messages for each invalid state
 *  3. Distributed lock via PayrollEngine (prevents concurrent runs)
 */

const repository    = require('./payroll.repository');
const payrollEngine = require('./engines/PayrollEngine');

// ── Run Payroll ───────────────────────────────────────────────────

async function runPayroll(tenantId, tenderId, month, year, runByUserId) {
  if (!tenderId)    throw new Error('tenderId is required');
  if (!month)       throw new Error('month is required');
  if (!year)        throw new Error('year is required');
  if (!runByUserId) throw new Error('runByUserId is required');

  const monthNum = parseInt(month);
  const yearNum  = parseInt(year);

  if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
    throw new Error(`Invalid month: "${month}". Must be 1–12.`);
  }
  if (isNaN(yearNum) || yearNum < 2020 || yearNum > 2100) {
    throw new Error(`Invalid year: "${year}".`);
  }

  // ── Idempotency guard: check before creating any DB records
  const existing = await repository.findExistingRun(tenderId, monthNum, yearNum);
  if (existing) {
    if (existing.status === 'PROCESSING') {
      throw new Error(
        'Payroll run is already in progress for this tender and month. ' +
        'Please wait for it to complete.'
      );
    }
    if (existing.status === 'COMPLETED') {
      throw new Error(
        `Payroll for ${monthNum}/${yearNum} is already completed (Run ID: ${existing.id}). ` +
        'Delete the existing run before re-running.'
      );
    }
    if (existing.status === 'LOCKED') {
      throw new Error(
        `Payroll for ${monthNum}/${yearNum} is locked and cannot be re-run. ` +
        'Contact your administrator to unlock it.'
      );
    }
  }

  // ── Delegate to engine (engine handles distributed lock internally)
  return payrollEngine.runPayroll(tenantId, tenderId, monthNum, yearNum, runByUserId);
}

// ── Get All Runs for Tender ───────────────────────────────────────

async function getRunsByTender(tenderId, tenantId) {
  return repository.getRunsByTender(tenderId, tenantId);
}

// ── Get Single Run ────────────────────────────────────────────────

async function getRun(runId, tenantId) {
  const run = await repository.findRunWithRows(runId, tenantId);
  if (!run) throw new Error('Payroll run not found');
  return run;
}

// ── Lock Payroll ──────────────────────────────────────────────────

async function lockRun(runId, tenantId, lockedByUserId) {
  const run = await repository.findRun(runId, tenantId);
  if (!run) throw new Error('Payroll run not found');

  if (run.status === 'LOCKED') {
    throw new Error('Payroll is already locked');
  }
  if (run.status !== 'COMPLETED') {
    throw new Error(
      `Cannot lock payroll with status "${run.status}". ` +
      'Payroll must be COMPLETED before locking.'
    );
  }

  return repository.lockRun(runId, lockedByUserId);
}

// ── Delete Run (Admins Only) ──────────────────────────────────────

async function deleteRun(runId, tenantId) {
  return repository.deleteRun(runId, tenantId);
}

// ── Get PF Challan Data ───────────────────────────────────────────

async function getPFChallan(runId, tenantId) {
  const run = await repository.getPFChallanData(runId, tenantId);
  if (!run) throw new Error('Payroll run not found');

  // Aggregate PF data per employee (handles split rows)
  const pfMap = {};
  for (const row of run.rows) {
    const id = row.employeeId;
    if (!pfMap[id]) {
      pfMap[id] = {
        employee:    row.employee,
        grossWages:  0, pfWage: 0,
        pfEE: 0, pfER: 0,
        erEPF: 0, erEPS: 0,
        edli: 0, adminCharge: 0,
        totalPF: 0,
      };
    }
    pfMap[id].grossWages  += row.grossEarnings;
    pfMap[id].pfWage      += row.pfWage;
    pfMap[id].pfEE        += row.pfEE;
    pfMap[id].pfER        += row.pfER;
    pfMap[id].erEPF       += row.erEPF       || 0;
    pfMap[id].erEPS       += row.erEPS       || 0;
    pfMap[id].edli        += row.edli        || 0;
    pfMap[id].adminCharge += row.adminCharge || 0;
    pfMap[id].totalPF     += row.pfEE + row.pfER;
  }

  const r2 = n => Math.round((n || 0) * 100) / 100;
  const pfRows = Object.values(pfMap).map(r => ({
    ...r,
    grossWages:  r2(r.grossWages),
    pfWage:      r2(r.pfWage),
    pfEE:        r2(r.pfEE),
    pfER:        r2(r.pfER),
    erEPF:       r2(r.erEPF),
    erEPS:       r2(r.erEPS),
    edli:        r2(r.edli),
    adminCharge: r2(r.adminCharge),
    totalPF:     r2(r.totalPF),
  }));

  const totals = pfRows.reduce((acc, r) => ({
    grossWages:  acc.grossWages  + r.grossWages,
    pfWage:      acc.pfWage      + r.pfWage,
    pfEE:        acc.pfEE        + r.pfEE,
    pfER:        acc.pfER        + r.pfER,
    erEPF:       acc.erEPF       + r.erEPF,
    erEPS:       acc.erEPS       + r.erEPS,
    edli:        acc.edli        + r.edli,
    adminCharge: acc.adminCharge + r.adminCharge,
    totalPF:     acc.totalPF     + r.totalPF,
  }), { grossWages: 0, pfWage: 0, pfEE: 0, pfER: 0, erEPF: 0, erEPS: 0, edli: 0, adminCharge: 0, totalPF: 0 });

  Object.keys(totals).forEach(k => { totals[k] = r2(totals[k]); });

  return { run, pfRows, totals };
}

// ── Transfer Sheet ────────────────────────────────────────────────

async function getTransferSheet(runId, tenantId) {
  const run = await repository.getTransferSheetData(runId, tenantId);
  if (!run) throw new Error('Payroll run not found');

  const r2 = n => Math.round((n || 0) * 100) / 100;

  const transferMap = {};
  for (const row of run.rows) {
    const id = row.employeeId;
    if (!transferMap[id]) {
      transferMap[id] = {
        employee:    row.employee,
        netPay:      0,
        bankAccount: row.employee.bankAccount || null,
        ifscCode:    row.employee.ifscCode    || null,
        bankName:    row.employee.bankName    || null,
      };
    }
    transferMap[id].netPay += row.netPay;
  }

  const transferRows = Object.values(transferMap).map(r => ({
    ...r,
    netPay: r2(r.netPay),
  }));

  const totalNet = r2(transferRows.reduce((sum, r) => sum + r.netPay, 0));

  return { run, transferRows, totalNet };
}


// -- Validate Can Run (used by controller before enqueuing job) --
async function validateCanRun(tenantId, tenderId, month, year) {
  const monthNum = parseInt(month);
  const yearNum  = parseInt(year);
  if (isNaN(monthNum) || monthNum < 1 || monthNum > 12)
    throw new Error('Invalid month: ' + month + '. Must be 1-12.');
  if (isNaN(yearNum) || yearNum < 2020 || yearNum > 2100)
    throw new Error('Invalid year: ' + year);
  const existing = await repository.findExistingRun(tenderId, monthNum, yearNum);
  if (!existing) return { canRun: true };
  if (existing.status === 'PROCESSING')
    throw new Error('Payroll run is already in progress for this tender and month.');
  if (existing.status === 'COMPLETED')
    throw new Error('Payroll for ' + monthNum + '/' + yearNum + ' is already completed. Delete the existing run before re-running.');
  if (existing.status === 'LOCKED')
    throw new Error('Payroll for ' + monthNum + '/' + yearNum + ' is locked and cannot be re-run.');
  return { canRun: true };
}
module.exports = {
  runPayroll,
  validateCanRun,
  getRunsByTender,
  getRun,
  lockRun,
  deleteRun,
  getPFChallan,
  getTransferSheet,
};


