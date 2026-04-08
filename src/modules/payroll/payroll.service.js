// src/modules/payroll/payroll.service.js
// ─────────────────────────────────────────────────────────────────
// Payroll Service — Orchestration layer
// Calls: payroll.repository.js + payrollEngine.js
// Never touches: req, res, prisma directly
// ─────────────────────────────────────────────────────────────────

'use strict';

const repository    = require('./payroll.repository');
const payrollEngine = require('./engines/PayrollEngine.js');

// ── Run Payroll ───────────────────────────────────────────────────
async function runPayroll(tenantId, tenderId, month, year, runByUserId) {
  if (!tenderId) throw new Error('tenderId is required');
  if (!month)    throw new Error('month is required');
  if (!year)     throw new Error('year is required');
  if (!runByUserId) throw new Error('runByUserId is required');

  const monthNum = parseInt(month);
  const yearNum  = parseInt(year);

  if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
    throw new Error(`Invalid month: "${month}". Must be 1–12.`);
  }
  if (isNaN(yearNum) || yearNum < 2020 || yearNum > 2100) {
    throw new Error(`Invalid year: "${year}".`);
  }

  return payrollEngine.runPayroll(tenantId, tenderId, monthNum, yearNum, runByUserId);
}

// ── Get All Runs for Tender ───────────────────────────────────────
async function getRunsByTender(tenderId, tenantId) {
  // Verify tender belongs to tenant via first run check
  // Full tender verification is in the route middleware
  return repository.getRunsByTender(tenderId);
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
      `Payroll must be COMPLETED before locking.`
    );
  }

  return repository.lockRun(runId, lockedByUserId);
}

// ── Get PF Challan Data ───────────────────────────────────────────
async function getPFChallan(runId, tenantId) {
  const run = await repository.getPFChallanData(runId, tenantId);
  if (!run) throw new Error('Payroll run not found');

  // Aggregate PF data per employee
  // An employee can have multiple rows (split roles)
  // PF is summed across all rows for challan
  const pfMap = {};

  for (const row of run.rows) {
    const id = row.employeeId;
    if (!pfMap[id]) {
      pfMap[id] = {
        employee:    row.employee,
        grossWages:  0,
        pfWage:      0,
        pfEE:        0,
        pfER:        0,
        erEPF:       0,
        erEPS:       0,
        edli:        0,
        adminCharge: 0,
        totalPF:     0,
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

  const pfRows = Object.values(pfMap).map(r => ({
    ...r,
    grossWages:  Math.round(r.grossWages  * 100) / 100,
    pfWage:      Math.round(r.pfWage      * 100) / 100,
    pfEE:        Math.round(r.pfEE        * 100) / 100,
    pfER:        Math.round(r.pfER        * 100) / 100,
    erEPF:       Math.round(r.erEPF       * 100) / 100,
    erEPS:       Math.round(r.erEPS       * 100) / 100,
    edli:        Math.round(r.edli        * 100) / 100,
    adminCharge: Math.round(r.adminCharge * 100) / 100,
    totalPF:     Math.round(r.totalPF     * 100) / 100,
  }));

  // Grand totals for challan footer
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
  }), {
    grossWages: 0, pfWage: 0, pfEE: 0, pfER: 0,
    erEPF: 0, erEPS: 0, edli: 0, adminCharge: 0, totalPF: 0,
  });

  // Round totals
  Object.keys(totals).forEach(k => {
    totals[k] = Math.round(totals[k] * 100) / 100;
  });

  return { run, pfRows, totals };
}

// ── Get Transfer Sheet ────────────────────────────────────────────
async function getTransferSheet(runId, tenantId) {
  const run = await repository.getTransferSheetData(runId, tenantId);
  if (!run) throw new Error('Payroll run not found');

  // Aggregate net pay per employee across all rows
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
    netPay: Math.round(r.netPay * 100) / 100,
  }));

  const totalNet = Math.round(
    transferRows.reduce((sum, r) => sum + r.netPay, 0) * 100
  ) / 100;

  return { run, transferRows, totalNet };
}

module.exports = {
  runPayroll,
  getRunsByTender,
  getRun,
  lockRun,
  getPFChallan,
  getTransferSheet,
};
