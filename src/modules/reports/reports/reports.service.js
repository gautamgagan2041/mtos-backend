'use strict';

/**
 * reports.service.js — Analytics and reporting engine
 *
 * REPORTS:
 *  1. payrollSummary(month, year)   — company-wide payroll overview
 *  2. tenderComparison(months)      — compare multiple months for a tender
 *  3. complianceDashboard()         — all alerts grouped by severity
 *  4. employeeStatement(empId)      — 12-month history for one employee
 *  5. pfSummary(month, year)        — PF contribution summary for all tenders
 *  6. costAnalytics()               — cost trend + margin trend
 *  7. headcountTrend(months)        — employee count over time
 */

const prisma  = require('../../config/database');
const { r2, sum } = require('../../utils/decimal');

const MONTHS_LABEL = [
  '', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// ── 1. Company-Wide Payroll Summary ──────────────────────────────

async function payrollSummary(tenantId, month, year) {
  const m = parseInt(month);
  const y = parseInt(year);

  const runs = await prisma.payrollRun.findMany({
    where:   { tenantId, month: m, year: y, status: { in: ['COMPLETED', 'LOCKED'] } },
    include: {
      tender: { include: { client: { select: { name: true } } } },
      _count: { select: { rows: true } },
    },
    orderBy: { tender: { name: 'asc' } },
  });

  const tenderBreakdown = runs.map(run => ({
    runId:         run.id,
    tenderName:    run.tender.name,
    tenderCode:    run.tender.code,
    clientName:    run.tender.client?.name,
    status:        run.status,
    employeeCount: run._count.rows,
    grossPay:      r2(run.totalGross),
    netPay:        r2(run.totalNet),
    pfEE:          r2(run.totalPFEE),
    pfER:          r2(run.totalPFER),
    esic:          r2(run.totalESIC),
    pt:            r2(run.totalPT),
    provisions:    r2(run.totalProvisions || 0),
    employerCosts: r2(run.totalEmployerCosts || 0),
    totalCostToClient: r2(run.totalCostToClient || 0),
    pfFiled:       run.pfFiled   || false,
    esicFiled:     run.esicFiled || false,
  }));

  // Totals
  const totals = {
    totalTenders:  runs.length,
    totalEmployees: tenderBreakdown.reduce((s, r) => s + r.employeeCount, 0),
    grossPay:      r2(sum(tenderBreakdown.map(r => r.grossPay))),
    netPay:        r2(sum(tenderBreakdown.map(r => r.netPay))),
    pfEE:          r2(sum(tenderBreakdown.map(r => r.pfEE))),
    pfER:          r2(sum(tenderBreakdown.map(r => r.pfER))),
    esic:          r2(sum(tenderBreakdown.map(r => r.esic))),
    pt:            r2(sum(tenderBreakdown.map(r => r.pt))),
    provisions:    r2(sum(tenderBreakdown.map(r => r.provisions))),
    totalCostToClient: r2(sum(tenderBreakdown.map(r => r.totalCostToClient))),
    challanStatus: {
      pfFiled:   tenderBreakdown.filter(r => r.pfFiled).length,
      pfPending: tenderBreakdown.filter(r => !r.pfFiled).length,
      esicFiled:   tenderBreakdown.filter(r => r.esicFiled).length,
      esicPending: tenderBreakdown.filter(r => !r.esicFiled).length,
    },
  };

  return {
    month: m, year: y, monthLabel: `${MONTHS_LABEL[m]} ${y}`,
    tenderBreakdown, totals,
  };
}

// ── 2. Tender Month-over-Month Comparison ─────────────────────────

async function tenderComparison(tenantId, tenderId, numMonths = 6) {
  const runs = await prisma.payrollRun.findMany({
    where:   { tenderId, tenantId, status: { in: ['COMPLETED', 'LOCKED'] } },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
    take:    numMonths,
    include: { _count: { select: { rows: true } } },
  });

  // Corresponding invoices
  const invoices = await prisma.invoice.findMany({
    where: {
      tenderId,
      month: { in: runs.map(r => r.month) },
      year:  { in: runs.map(r => r.year) },
    },
    select: { month: true, year: true, grandTotal: true, status: true },
  });
  const invMap = Object.fromEntries(invoices.map(i => [`${i.month}:${i.year}`, i]));

  const data = runs.reverse().map(run => {
    const inv          = invMap[`${run.month}:${run.year}`];
    const totalCost    = r2(Number(run.totalCostToClient || 0));
    const invoiced     = r2(Number(inv?.grandTotal || 0));
    const margin       = invoiced > 0 ? r2(invoiced - totalCost) : null;
    const marginPct    = invoiced > 0 && margin !== null
      ? r2((margin / invoiced) * 100) : null;

    return {
      label:          `${MONTHS_LABEL[run.month]} ${run.year}`,
      month:          run.month,
      year:           run.year,
      employeeCount:  run._count.rows,
      grossPay:       r2(run.totalGross),
      netPay:         r2(run.totalNet),
      totalCost,
      invoiced,
      margin,
      marginPct,
    };
  });

  return { tenderId, numMonths, data };
}

// ── 3. Compliance Dashboard ───────────────────────────────────────

async function complianceDashboard(tenantId) {
  const [alerts, expiringDocs, expiredDocs, unfiledPF, unfiledESIC] = await Promise.all([
    // Unresolved alerts grouped by severity
    prisma.complianceAlert.groupBy({
      by:     ['severity'],
      where:  { tenantId, isResolved: false },
      _count: { id: true },
    }),

    // Documents expiring in next 60 days
    prisma.complianceDocument.findMany({
      where: {
        tenantId,
        isActive:   true,
        expiryDate: {
          gte: new Date(),
          lte: new Date(Date.now() + 60 * 86_400_000),
        },
      },
      include: { tender: { select: { name: true } } },
      orderBy: { expiryDate: 'asc' },
    }),

    // Expired documents
    prisma.complianceDocument.count({
      where: { tenantId, isActive: true, expiryDate: { lt: new Date() } },
    }),

    // Unfiled PF challans (this month)
    prisma.payrollRun.count({
      where: {
        tenantId,
        status:   { in: ['COMPLETED', 'LOCKED'] },
        pfFiled:  false,
        month:    new Date().getMonth() === 0 ? 12 : new Date().getMonth(),
        year:     new Date().getMonth() === 0 ? new Date().getFullYear() - 1 : new Date().getFullYear(),
      },
    }),

    // Unfiled ESIC returns
    prisma.payrollRun.count({
      where: {
        tenantId,
        status:    { in: ['COMPLETED', 'LOCKED'] },
        esicFiled: false,
        month:     new Date().getMonth() === 0 ? 12 : new Date().getMonth(),
        year:      new Date().getMonth() === 0 ? new Date().getFullYear() - 1 : new Date().getFullYear(),
      },
    }),
  ]);

  const alertsBySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  alerts.forEach(a => { alertsBySeverity[a.severity] = a._count.id; });

  const expiringDocsFormatted = expiringDocs.map(doc => ({
    id:         doc.id,
    name:       doc.name,
    docType:    doc.docType,
    tender:     doc.tender?.name,
    expiryDate: doc.expiryDate,
    daysLeft:   Math.ceil((new Date(doc.expiryDate) - new Date()) / 86_400_000),
  }));

  return {
    healthScore: _calculateHealthScore(alertsBySeverity, expiredDocs, unfiledPF, unfiledESIC),
    alertsBySeverity,
    totalUnresolved: Object.values(alertsBySeverity).reduce((a, b) => a + b, 0),
    expiredDocuments:    expiredDocs,
    expiringDocuments:   expiringDocsFormatted,
    challanStatus: {
      pfUnfiled:   unfiledPF,
      esicUnfiled: unfiledESIC,
    },
  };
}

// ── 4. Employee Statement (12-month history) ──────────────────────

async function employeeStatement(tenantId, employeeId) {
  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId },
    select: { id: true, name: true, sr: true, uan: true, esicNumber: true },
  });
  if (!employee) { const e = new Error('Employee not found'); e.statusCode = 404; throw e; }

  const rows = await prisma.payrollRow.findMany({
    where: { employeeId },
    include: {
      run:  { select: { month: true, year: true, status: true, tenderId: true } },
      components: {
        include: { component: { select: { name: true, code: true, type: true } } },
        orderBy: { component: { displayOrder: 'asc' } },
      },
    },
    orderBy: [{ run: { year: 'desc' } }, { run: { month: 'desc' } }],
    take:    24, // Last 24 months
  });

  const statement = rows.map(row => ({
    month:          row.run.month,
    year:           row.run.year,
    label:          `${MONTHS_LABEL[row.run.month]} ${row.run.year}`,
    status:         row.run.status,
    workDays:       row.workDays,
    grossEarnings:  r2(row.grossEarnings),
    totalDeductions:r2(row.totalDeductions),
    netPay:         r2(row.netPay),
    pfEE:           r2(row.pfEE),
    esicEE:         r2(row.esicEE),
    pt:             r2(row.pt),
    loanDeduction:  r2(row.loanDeduction || 0),
    components:     row.components.map(c => ({
      name:   c.component.name,
      code:   c.component.code,
      type:   c.component.type,
      amount: r2(c.computedValue),
    })),
  }));

  // Yearly aggregates
  const byYear = {};
  for (const row of statement) {
    if (!byYear[row.year]) {
      byYear[row.year] = { year: row.year, grossTotal: 0, netTotal: 0, pfTotal: 0, months: 0 };
    }
    byYear[row.year].grossTotal += row.grossEarnings;
    byYear[row.year].netTotal   += row.netPay;
    byYear[row.year].pfTotal    += row.pfEE;
    byYear[row.year].months++;
  }
  Object.values(byYear).forEach(y => {
    y.grossTotal = r2(y.grossTotal);
    y.netTotal   = r2(y.netTotal);
    y.pfTotal    = r2(y.pfTotal);
  });

  return { employee, statement, yearlyTotals: Object.values(byYear) };
}

// ── 5. PF Challan Summary ─────────────────────────────────────────

async function pfChallanSummary(tenantId, month, year) {
  const m = parseInt(month);
  const y = parseInt(year);

  const runs = await prisma.payrollRun.findMany({
    where:   { tenantId, month: m, year: y, status: { in: ['COMPLETED', 'LOCKED'] } },
    include: {
      tender: { select: { name: true, code: true } },
      rows:   { select: { pfWage: true, pfEE: true, pfER: true, erEPF: true, erEPS: true, edli: true, adminCharge: true } },
    },
  });

  const data = runs.map(run => {
    const totals = {
      pfWage:      r2(sum(run.rows.map(r => Number(r.pfWage)))),
      pfEE:        r2(sum(run.rows.map(r => Number(r.pfEE)))),
      pfER:        r2(sum(run.rows.map(r => Number(r.pfER)))),
      erEPF:       r2(sum(run.rows.map(r => Number(r.erEPF || 0)))),
      erEPS:       r2(sum(run.rows.map(r => Number(r.erEPS || 0)))),
      edli:        r2(sum(run.rows.map(r => Number(r.edli || 0)))),
      adminCharge: r2(sum(run.rows.map(r => Number(r.adminCharge || 0)))),
    };
    totals.totalChallan = r2(totals.pfEE + totals.pfER + totals.edli + totals.adminCharge);

    return {
      runId:      run.id,
      tender:     run.tender,
      pfFiled:    run.pfFiled || false,
      ...totals,
    };
  });

  const grandTotal = {
    pfEE:        r2(sum(data.map(d => d.pfEE))),
    pfER:        r2(sum(data.map(d => d.pfER))),
    edli:        r2(sum(data.map(d => d.edli))),
    adminCharge: r2(sum(data.map(d => d.adminCharge))),
    totalChallan: r2(sum(data.map(d => d.totalChallan))),
    filedCount:  data.filter(d => d.pfFiled).length,
    pendingCount: data.filter(d => !d.pfFiled).length,
  };

  return { month: m, year: y, monthLabel: `${MONTHS_LABEL[m]} ${y}`, tenders: data, grandTotal };
}

// ── 6. Cost Analytics (trend) ────────────────────────────────────

async function costAnalytics(tenantId, numMonths = 12) {
  const runs = await prisma.payrollRun.findMany({
    where:   { tenantId, status: { in: ['COMPLETED', 'LOCKED'] } },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
    take:    numMonths,
    select: {
      month: true, year: true,
      totalGross: true, totalNet: true,
      totalEmployerCosts: true, totalProvisions: true, totalCostToClient: true,
      _count: { select: { rows: true } },
    },
  });

  const byMonth = {};
  for (const run of runs) {
    const key = `${run.year}-${String(run.month).padStart(2, '0')}`;
    if (!byMonth[key]) {
      byMonth[key] = {
        label: `${MONTHS_LABEL[run.month]} ${run.year}`,
        month: run.month, year: run.year,
        grossPay: 0, netPay: 0, employerCosts: 0, provisions: 0, totalCost: 0, employees: 0,
      };
    }
    byMonth[key].grossPay     += Number(run.totalGross);
    byMonth[key].netPay       += Number(run.totalNet);
    byMonth[key].employerCosts += Number(run.totalEmployerCosts || 0);
    byMonth[key].provisions   += Number(run.totalProvisions || 0);
    byMonth[key].totalCost    += Number(run.totalCostToClient || 0);
    byMonth[key].employees    += run._count.rows;
  }

  const trend = Object.entries(byMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => ({
      ...v,
      grossPay:      r2(v.grossPay),
      netPay:        r2(v.netPay),
      employerCosts: r2(v.employerCosts),
      provisions:    r2(v.provisions),
      totalCost:     r2(v.totalCost),
    }));

  return { numMonths, trend };
}

// ── Excel Export Helper ───────────────────────────────────────────

/**
 * exportPayrollSummaryToExcel — generate XLSX buffer for download
 */
async function exportPayrollSummaryToExcel(tenantId, month, year) {
  let XLSX;
  try {
    XLSX = require('xlsx');
  } catch {
    throw new Error('Excel export requires xlsx package. Run: npm install xlsx');
  }

  const report = await payrollSummary(tenantId, month, year);
  const pfData  = await pfChallanSummary(tenantId, month, year);

  const wb = XLSX.utils.book_new();

  // Sheet 1: Payroll Summary
  const summaryRows = report.tenderBreakdown.map(r => ({
    'Tender':         r.tenderName,
    'Client':         r.clientName,
    'Employees':      r.employeeCount,
    'Gross Pay':      r.grossPay,
    'Net Pay':        r.netPay,
    'PF (EE)':        r.pfEE,
    'PF (ER)':        r.pfER,
    'ESIC':           r.esic,
    'PT':             r.pt,
    'Provisions':     r.provisions,
    'Total Cost':     r.totalCostToClient,
    'PF Filed':       r.pfFiled ? 'Yes' : 'No',
    'ESIC Filed':     r.esicFiled ? 'Yes' : 'No',
  }));
  summaryRows.push({
    'Tender': 'TOTAL',
    'Employees':      report.totals.totalEmployees,
    'Gross Pay':      report.totals.grossPay,
    'Net Pay':        report.totals.netPay,
    'PF (EE)':        report.totals.pfEE,
    'PF (ER)':        report.totals.pfER,
    'ESIC':           report.totals.esic,
    'PT':             report.totals.pt,
    'Provisions':     report.totals.provisions,
    'Total Cost':     report.totals.totalCostToClient,
  });

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Payroll Summary');

  // Sheet 2: PF Challan Summary
  const pfRows = pfData.tenders.map(t => ({
    'Tender':       t.tender.name,
    'PF Wage':      t.pfWage,
    'EE EPF':       t.pfEE,
    'ER EPF':       t.erEPF,
    'ER EPS':       t.erEPS,
    'EDLI':         t.edli,
    'Admin Charge': t.adminCharge,
    'Total Challan':t.totalChallan,
    'Status':       t.pfFiled ? 'Filed' : 'Pending',
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pfRows), 'PF Challan');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ── Helpers ───────────────────────────────────────────────────────

function _calculateHealthScore(alerts, expiredDocs, unfiledPF, unfiledESIC) {
  let score = 100;
  score -= alerts.CRITICAL * 20;
  score -= alerts.HIGH     * 10;
  score -= alerts.MEDIUM   * 3;
  score -= expiredDocs     * 15;
  score -= unfiledPF       * 8;
  score -= unfiledESIC     * 8;
  return Math.max(0, Math.min(100, score));
}

module.exports = {
  payrollSummary,
  tenderComparison,
  complianceDashboard,
  employeeStatement,
  pfChallanSummary,
  costAnalytics,
  exportPayrollSummaryToExcel,
};
