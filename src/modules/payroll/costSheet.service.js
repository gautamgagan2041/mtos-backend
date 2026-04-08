'use strict';

// ─── Cost Sheet Service ─────────────────────────────────────────────
// GET /api/payroll/:runId/cost-sheet

const prisma = require('../../config/database');
const { NATURE } = require('./engines/layeredPayrollEngine');

const r2 = (n) => Math.round((n || 0) * 100) / 100;

async function getCostSheet(runId, tenantId) {

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId },
    include: {
      tender: {
        include: {
          client: { select: { name: true, gstin: true } },
          billingConfig: true,
        },
      },
      rows: {
        include: {
          employee: {
            select: {
              id: true,
              name: true,
              employeeCode: true,
              uan: true,
            },
          },
          components: {
            include: {
              component: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  nature: true,
                  type: true,
                },
              },
            },
          },
          attendance: {
            select: { presentDays: true },
          },
        },
        orderBy: { employeeId: 'asc' },
      },
    },
  });

  if (!run) throw new Error('Payroll run not found');

  // ── Preload rank mapping (FIX: avoid N+1 queries) ────────────────
  const tenderEmployees = await prisma.tenderEmployee.findMany({
    where: { tenderId: run.tenderId, isActive: true },
    select: { employeeId: true, rank: true },
  });

  const rankMap = {};
  tenderEmployees.forEach(te => {
    rankMap[te.employeeId] = te.rank;
  });

  const costRows = [];
  const summary = {
    totalGrossEarnings: 0,
    totalDeductions: 0,
    totalNetPay: 0,
    totalEmployerCost: 0,
    totalProvisions: 0,
    totalTenderCost: 0,
    totalCostToClient: 0,
    employeeCount: 0,
  };

  for (const row of run.rows) {

    const layer1Earnings   = {};
    const layer1Deductions = {};
    const layer2Employer   = {};
    const layer3Provisions = {};
    const layer4Tender     = {};

    // ── Component-based reconstruction ────────────────────────────
    if (row.components.length > 0) {
      for (const rowComp of row.components) {
        const comp   = rowComp.component;
        const nature = comp.nature || deriveNatureFallback(comp);
        const value  = rowComp.computedValue;

        switch (nature) {
          case NATURE.EARNING:       layer1Earnings[comp.code]   = value; break;
          case NATURE.DEDUCTION:     layer1Deductions[comp.code] = value; break;
          case NATURE.EMPLOYER_COST: layer2Employer[comp.code]   = value; break;
          case NATURE.PROVISION:     layer3Provisions[comp.code] = value; break;
          case NATURE.TENDER_COST:   layer4Tender[comp.code]     = value; break;
          default:
            if (comp.type === 'EARNING') layer1Earnings[comp.code] = value;
            else layer1Deductions[comp.code] = value;
        }
      }
    } else {
      // ── Old runs fallback ───────────────────────────────────────
      reconstructFromSnapshot(
        row,
        layer1Earnings,
        layer1Deductions,
        layer2Employer,
        layer3Provisions,
        layer4Tender
      );
    }

    // ── Employer fallback (PF/ESIC) ───────────────────────────────
    if (Object.keys(layer2Employer).length === 0) {
      if (row.pfER > 0)        layer2Employer['PF_ER']   = row.pfER;
      if (row.edli > 0)        layer2Employer['EDLI']    = row.edli;
      if (row.adminCharge > 0) layer2Employer['ADMIN']   = row.adminCharge;
      if (row.esicER > 0)      layer2Employer['ESIC_ER'] = row.esicER;
    }

    // ── Reliever calculation ─────────────────────────────────────
    if (!layer4Tender['RELIEVER']) {
      const base = r2(
        row.grossEarnings +
        sum(layer2Employer) +
        sum(layer3Provisions) +
        sum(layer4Tender)
      );
      layer4Tender['RELIEVER'] = r2(base / 6);
    }

    const grossEarnings   = row.grossEarnings;
    const totalDeductions = row.totalDeductions;
    const netPay          = row.netPay;

    const totalEmployer = r2(sum(layer2Employer));
    const totalProv     = r2(sum(layer3Provisions));
    const totalTender   = r2(sum(layer4Tender));

    const costToClient = r2(
      grossEarnings + totalEmployer + totalProv + totalTender
    );

    costRows.push({
      employee: {
        id: row.employeeId,
        name: row.employee.name,
        uan: row.employee.uan,
        rank: rankMap[row.employeeId] || row.rank,
        presentDays: row.attendance?.presentDays ?? row.workDays,
      },
      layer1: {
        label: 'Employee earnings',
        earnings: layer1Earnings,
        deductions: layer1Deductions,
        grossPay: grossEarnings,
        netPay,
      },
      layer2: {
        label: 'Employer statutory',
        components: layer2Employer,
        total: totalEmployer,
      },
      layer3: {
        label: 'Provisions',
        components: layer3Provisions,
        total: totalProv,
      },
      layer4: {
        label: 'Tender costs',
        components: layer4Tender,
        total: totalTender,
      },
      costToClient,
    });

    // ── Summary accumulation ─────────────────────────────────────
    summary.totalGrossEarnings += grossEarnings;
    summary.totalDeductions    += totalDeductions;
    summary.totalNetPay        += netPay;
    summary.totalEmployerCost  += totalEmployer;
    summary.totalProvisions    += totalProv;
    summary.totalTenderCost    += totalTender;
    summary.totalCostToClient  += costToClient;
    summary.employeeCount++;
  }

  // ── Final rounding ─────────────────────────────────────────────
  Object.keys(summary).forEach(k => {
    if (typeof summary[k] === 'number') summary[k] = r2(summary[k]);
  });

  // ── Billing calculation ────────────────────────────────────────
  const config = run.tender.billingConfig;
  const serviceChargeRate = config?.serviceChargeRate ?? 0.10;

  const serviceCharge   = r2(summary.totalCostToClient * serviceChargeRate);
  const billingSubtotal = r2(summary.totalCostToClient + serviceCharge);

  return {
    run: {
      id: run.id,
      month: run.month,
      year: run.year,
      status: run.status,
    },
    tender: {
      id: run.tenderId,
      name: run.tender.name,
      workOrder: run.tender.workOrder,
      client: run.tender.client?.name,
    },
    costRows,
    summary,
    billing: {
      costToClient: summary.totalCostToClient,
      serviceChargeRate,
      serviceCharge,
      billingSubtotal,
      note: 'GST calculated separately',
    },
  };
}

// ────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────

function sum(obj) {
  return Object.values(obj).reduce((s, v) => s + v, 0);
}

function reconstructFromSnapshot(row, earnings, deductions, employer, provisions, tenderCost) {
  if (row.payableBasic) earnings['BASIC'] = row.payableBasic;
  if (row.vdaPayable) earnings['VDA'] = row.vdaPayable;
  if (row.hra) earnings['HRA'] = row.hra;

  if (row.bonus) provisions['BONUS'] = row.bonus;
  if (row.washingAllow) tenderCost['WASHING'] = row.washingAllow;
  if (row.uniformAllow) tenderCost['UNIFORM'] = row.uniformAllow;

  if (row.extraDutyAmt) earnings['EXTRA_DUTY'] = row.extraDutyAmt;

  if (row.pfEE) deductions['PF_EE'] = row.pfEE;
  if (row.esicEE) deductions['ESIC_EE'] = row.esicEE;
  if (row.pt) deductions['PT'] = row.pt;

  if (row.pfER) employer['PF_ER'] = row.pfER;
  if (row.edli) employer['EDLI'] = row.edli;
  if (row.adminCharge) employer['ADMIN'] = row.adminCharge;
  if (row.esicER) employer['ESIC_ER'] = row.esicER;
}

function deriveNatureFallback(comp) {
  if (comp.type === 'DEDUCTION') return NATURE.DEDUCTION;

  if (['BONUS', 'GRATUITY', 'LEAVE_WAGES', 'LEAVE_ENCASH'].includes(comp.code)) {
    return NATURE.PROVISION;
  }

  if (['UNIFORM', 'WASHING', 'RELIEVER'].includes(comp.code)) {
    return NATURE.TENDER_COST;
  }

  if (['PF_ER', 'ESIC_ER', 'EDLI', 'PF_ADMIN'].includes(comp.code)) {
    return NATURE.EMPLOYER_COST;
  }

  return NATURE.EARNING;
}

module.exports = { getCostSheet };