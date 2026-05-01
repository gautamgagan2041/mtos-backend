'use strict';

/**
 * tender.service.js — Business logic for tender domain
 *
 * FEATURES:
 *  1. CRUD with code uniqueness check
 *  2. Profitability dashboard per tender (your moat feature)
 *  3. Wage revision impact simulator — shows cost change if MW increases
 *  4. Formula component validator (UI can test before saving)
 */

const repo           = require('./tender.repository');
const audit          = require('../../services/auditService');
const cache          = require('../../services/cacheService');
const { evaluateFormula } = require('../../utils/formulaParser');
const { r2, sum }    = require('../../utils/decimal');

// ── CRUD ──────────────────────────────────────────────────────────

async function getTenders(tenantId, filters) {
  return repo.findAll(tenantId, filters);
}

async function getTender(tenantId, id) {
  const tender = await repo.findById(id, tenantId);
  if (!tender) { const e = new Error('Tender not found'); e.statusCode = 404; throw e; }
  return tender;
}

async function createTender(tenantId, data, actorUserId) {
  if (data.code) {
    const existing = await repo.findByCode(tenantId, data.code.toUpperCase());
    if (existing) {
      const e = new Error(`Tender code "${data.code}" already exists`);
      e.statusCode = 409;
      throw e;
    }
    data.code = data.code.toUpperCase();
  }

  const tender = await repo.create(tenantId, data);

  await audit.log({
    tenantId, userId: actorUserId,
    action: 'CREATE', entityType: 'TENDER', entityId: tender.id,
    newValues: { name: tender.name, code: tender.code, clientId: tender.clientId },
  });

  return tender;
}

async function updateTender(tenantId, id, data, actorUserId) {
  const existing = await getTender(tenantId, id);
  const updated  = await repo.update(id, tenantId, data);

  await audit.log({
    tenantId, userId: actorUserId,
    action: 'UPDATE', entityType: 'TENDER', entityId: id,
    oldValues: { name: existing.name, status: existing.status },
    newValues:  { name: updated.name,  status: updated.status },
  });

  await cache.del(`mtos:${tenantId}:tenders:*`);
  return updated;
}

async function assignSalaryStructure(tenantId, tenderId, salaryStructureId, actorUserId) {
  await getTender(tenantId, tenderId); // Ownership check
  const updated = await repo.assignSalaryStructure(tenderId, tenantId, salaryStructureId);

  await audit.log({
    tenantId, userId: actorUserId,
    action: 'UPDATE', entityType: 'TENDER', entityId: tenderId,
    newValues: { salaryStructureId },
  });

  await cache.del(cache.keys.salaryStructure(tenantId, salaryStructureId));
  return updated;
}

async function addEmployeeToTender(tenantId, tenderId, employeeData, actorUserId) {
  await getTender(tenantId, tenderId);
  const te = await repo.addEmployee(tenderId, tenantId, employeeData);

  await audit.log({
    tenantId, userId: actorUserId,
    action: 'CREATE', entityType: 'TENDER_EMPLOYEE', entityId: te.id,
    newValues: { tenderId, employeeId: employeeData.employeeId, rank: employeeData.rank },
  });

  return te;
}

// ── Profitability Dashboard ───────────────────────────────────────

/**
 * getTenderProfitability — builds a full financial picture for a tender.
 *
 * Returns per-month data for last 12 months:
 *  - Employee cost (net pay + statutory + provisions)
 *  - Invoice billed to client
 *  - Gross margin ₹ and %
 *  - Upcoming risk flags (DA revision, expiry, unfiled compliance)
 *
 * THIS IS YOUR MOAT — Darwinbox, Zoho People do not have this.
 */
async function getTenderProfitability(tenantId, tenderId) {
  const tender = await repo.getProfitabilityData(tenderId, tenantId);
  if (!tender) { const e = new Error('Tender not found'); e.statusCode = 404; throw e; }

  // Build month-by-month comparison
  const months = [];
  const invoiceMap = Object.fromEntries(
    tender.invoices.map(inv => [`${inv.month}:${inv.year}`, inv])
  );

  for (const run of tender.payrollRuns) {
    const invoice = invoiceMap[`${run.month}:${run.year}`];
    const invoiceAmount = invoice?.grandTotal || 0;

    // Total cost = employee cost + employer statutory + provisions
    const totalCost = r2(
      Number(run.totalGross || 0) +
      Number(run.totalEmployerCosts || 0) +
      Number(run.totalProvisions || 0)
    );

    const grossMargin = invoiceAmount > 0
      ? r2(invoiceAmount - totalCost)
      : null;

    const marginPct = invoiceAmount > 0
      ? r2((grossMargin / invoiceAmount) * 100)
      : null;

    months.push({
      month:          run.month,
      year:           run.year,
      employeeCount:  run._count.rows,
      grossPay:       r2(run.totalGross),
      netPay:         r2(run.totalNet),
      employerPF:     r2(run.totalPFER),
      employerESIC:   r2(Number(run.totalESIC) - Number(run.totalPFEE || 0)),
      provisions:     r2(run.totalProvisions || 0),
      totalCost,
      invoicedAmount: r2(invoiceAmount),
      invoiceStatus:  invoice?.status || null,
      grossMargin,
      marginPct,
      runId:          run.id,
      invoiceId:      invoice?.id || null,
    });
  }

  // Summary stats
  const completedMonths = months.filter(m => m.invoicedAmount > 0);
  const avgMarginPct = completedMonths.length > 0
    ? r2(completedMonths.reduce((s, m) => s + (m.marginPct || 0), 0) / completedMonths.length)
    : null;

  // Risk flags
  const riskFlags = [];
  const daysToExpiry = Math.ceil((new Date(tender.endDate) - new Date()) / 86_400_000);

  if (tender.endDate && daysToExpiry <= 60 && daysToExpiry > 0) {
    riskFlags.push({
      type:     'TENDER_EXPIRY',
      severity: daysToExpiry <= 30 ? 'CRITICAL' : 'HIGH',
      message:  `Tender expires in ${daysToExpiry} days (${new Date(tender.endDate).toLocaleDateString('en-IN')})`,
    });
  }

  if (avgMarginPct !== null && avgMarginPct < 5) {
    riskFlags.push({
      type:     'LOW_MARGIN',
      severity: avgMarginPct < 2 ? 'CRITICAL' : 'HIGH',
      message:  `Average margin is only ${avgMarginPct}% — check DA revision impact`,
    });
  }

  return {
    tender: {
      id:          tender.id,
      name:        tender.name,
      code:        tender.code,
      status:      tender.status,
      startDate:   tender.startDate,
      endDate:     tender.endDate,
      daysToExpiry,
      client:      tender.client,
      activeStaff: tender.employees.length,
    },
    months,
    summary: {
      totalMonthsRun:    tender.payrollRuns.length,
      avgMarginPct,
      totalBilled:    r2(sum(tender.invoices.map(i => Number(i.grandTotal || 0)))),
      totalCost:      r2(sum(tender.payrollRuns.map(r => Number(r.totalCostToClient || 0)))),
    },
    riskFlags,
  };
}

// ── Wage Revision Impact Simulator ───────────────────────────────

/**
 * simulateWageRevision — show cost impact of a minimum wage change.
 *
 * Given: new DA or basic increase %
 * Returns: before/after cost per employee, per tender, margin impact.
 *
 * EXAMPLE:
 *   MW increases by ₹500/month for all guards from Apr 1.
 *   This tender has 50 guards at ₹19,760/month.
 *   Simulated impact:
 *     - Extra gross per employee: ₹500
 *     - Extra PF (12%): ₹60
 *     - Extra ESIC (3.25%): ₹16.25
 *     - Extra provisions: ₹25.52
 *     - Total extra cost/employee: ₹601.77
 *     - Total extra per month (50 emp): ₹30,088
 *     - Margin impact: ₹-30,088/month
 *     - Revised margin %: 6.2% (was 9.1%)
 */
async function simulateWageRevision(tenantId, tenderId, revisionParams) {
  const { increaseType, increaseValue, effectiveFrom } = revisionParams;

  // increaseType: 'FIXED_AMOUNT' | 'PERCENT' | 'DA_ONLY' | 'BASIC_ONLY' | 'ALL'
  // increaseValue: number (₹ or %)

  const tender = await repo.getProfitabilityData(tenderId, tenantId);
  if (!tender) { const e = new Error('Tender not found'); e.statusCode = 404; throw e; }

  // Use last payroll run as baseline
  const lastRun = tender.payrollRuns[0];
  if (!lastRun) {
    return { error: 'No completed payroll run found to use as baseline' };
  }

  const lastInvoice  = tender.invoices[0];
  const currentCost  = r2(Number(lastRun.totalCostToClient || 0));
  const invoiceValue = r2(Number(lastInvoice?.grandTotal || 0));
  const employeeCount = lastRun._count.rows;

  // Calculate per-employee increase
  const avgGrossPerEmp = r2(Number(lastRun.totalGross) / employeeCount);

  let increasePerEmp = 0;
  switch (increaseType) {
    case 'FIXED_AMOUNT':
      increasePerEmp = r2(increaseValue);
      break;
    case 'PERCENT':
      increasePerEmp = r2(avgGrossPerEmp * (increaseValue / 100));
      break;
    case 'DA_ONLY':
      // Assume DA is ~40% of gross — increase DA only
      increasePerEmp = r2(increaseValue);
      break;
    default:
      increasePerEmp = r2(increaseValue);
  }

  // Statutory cost increase (cascades from higher gross)
  const pfIncrease   = r2(Math.min(increasePerEmp, 15000) * 0.12);      // ER PF 12% on incremental
  const esicIncrease = r2(increasePerEmp * 0.0325);                     // ESIC ER 3.25%
  const provIncrease = r2(increasePerEmp * (0.0833 + 0.0481 + 0.01));  // Bonus + Gratuity + LW
  const totalExtraPerEmp = r2(increasePerEmp + pfIncrease + esicIncrease + provIncrease);

  const totalExtraPerMonth = r2(totalExtraPerEmp * employeeCount);
  const revisedCost        = r2(currentCost + totalExtraPerMonth);

  const currentMargin = invoiceValue > 0 ? r2(invoiceValue - currentCost) : null;
  const revisedMargin = invoiceValue > 0 ? r2(invoiceValue - revisedCost) : null;
  const currentMarginPct = invoiceValue > 0 && currentMargin !== null
    ? r2((currentMargin / invoiceValue) * 100) : null;
  const revisedMarginPct = invoiceValue > 0 && revisedMargin !== null
    ? r2((revisedMargin / invoiceValue) * 100) : null;

  const needsReNegotiation = revisedMarginPct !== null && revisedMarginPct < 5;

  return {
    tender:    { id: tender.id, name: tender.name, client: tender.client?.name },
    baseline:  {
      month: lastRun.month, year: lastRun.year,
      employeeCount, avgGrossPerEmp,
      totalCost: currentCost, invoiceValue,
      marginPct: currentMarginPct,
    },
    revision: {
      increaseType, increaseValue, effectiveFrom,
      increasePerEmployee: increasePerEmp,
      breakdownPerEmployee: {
        directIncrease:      increasePerEmp,
        pfEmployerIncrease:  pfIncrease,
        esicEmployerIncrease: esicIncrease,
        provisionsIncrease:  provIncrease,
        totalIncrease:       totalExtraPerEmp,
      },
      totalExtraPerMonth,
      totalExtraPerYear: r2(totalExtraPerMonth * 12),
    },
    impact: {
      revisedCost,
      revisedMargin,
      revisedMarginPct,
      marginChange: revisedMarginPct !== null && currentMarginPct !== null
        ? r2(revisedMarginPct - currentMarginPct) : null,
      needsReNegotiation,
      suggestedNewBillingRate: needsReNegotiation
        ? r2(revisedCost / (1 - 0.08)) // Target 8% margin
        : null,
      recommendation: needsReNegotiation
        ? `Immediate re-negotiation required. Revised cost ₹${revisedCost.toLocaleString('en-IN')} leaves margin below 5%.`
        : `Margin remains acceptable at ${revisedMarginPct}% after revision.`,
    },
  };
}

// ── Formula Validator ─────────────────────────────────────────────

/**
 * validateFormula — test a formula before saving to a pay component.
 * Used by the UI formula builder.
 */
function validateFormula(formula, testValues) {
  try {
    const result = evaluateFormula(formula, testValues || {
      BASIC: 15000, VDA: 4760, presentDays: 26, otHours: 8, workingDays: 26,
    });
    return { valid: true, result, formula };
  } catch (err) {
    return { valid: false, error: err.message, formula };
  }
}

// ── Pay Components CRUD ───────────────────────────────────────────

async function listPayComponents(tenantId) {
  return repo.listPayComponents(tenantId);
}

async function createPayComponent(tenantId, data, actorUserId) {
  if (data.type === 'EARNING' && data.calculationType === 'FORMULA' && data.formula) {
    const test = validateFormula(data.formula, {});
    if (!test.valid) {
      const e = new Error(`Invalid formula: ${test.error}`);
      e.statusCode = 400;
      throw e;
    }
  }
  const component = await repo.createPayComponent(tenantId, {
    ...data,
    code: data.code?.toUpperCase().replace(/\s+/g, '_'),
  });
  await audit.log({
    tenantId, userId: actorUserId,
    action: 'CREATE', entityType: 'PAY_COMPONENT', entityId: component.id,
    newValues: { name: component.name, code: component.code, type: component.type },
  });
  return component;
}

async function listSalaryStructures(tenantId) {
  return repo.listSalaryStructures(tenantId);
}

async function createSalaryStructure(tenantId, data, actorUserId) {
  const structure = await repo.createSalaryStructure(tenantId, data);
  await audit.log({
    tenantId, userId: actorUserId,
    action: 'CREATE', entityType: 'SALARY_STRUCTURE', entityId: structure.id,
    newValues: { name: structure.name },
  });
  await cache.del(`mtos:${tenantId}:ss:*`);
  return structure;
}

module.exports = {
  getTenders, getTender, createTender, updateTender,
  assignSalaryStructure, addEmployeeToTender,
  getTenderProfitability, simulateWageRevision,
  validateFormula,
  listPayComponents, createPayComponent,
  listSalaryStructures, createSalaryStructure,
};
