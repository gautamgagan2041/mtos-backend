'use strict';

/**
 * costSheet.service.js — v4 Complete Cost Layering
 *
 * The cost sheet is the FINANCIAL HEART of the manpower billing model.
 * It shows exactly what a tender costs the manpower company, and maps
 * directly to what they can legitimately bill the client.
 *
 * 4-LAYER COST MODEL:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ Layer 1: Employee Take-Home (Net Pay)                            │
 * │   = Gross Earnings - Employee Deductions (PF EE + ESIC EE + PT) │
 * ├─────────────────────────────────────────────────────────────────┤
 * │ Layer 2: Statutory Employer Costs                                │
 * │   = PF ER (12%) + ESIC ER (3.25%) + EDLI (0.5%) + Admin (1%)   │
 * ├─────────────────────────────────────────────────────────────────┤
 * │ Layer 3: Provisions (Accrued, Paid Annually)                    │
 * │   = Bonus (8.33%) + Gratuity (4.81%) + Leave Wages (1%)        │
 * ├─────────────────────────────────────────────────────────────────┤
 * │ Layer 4: Tender-Specific Costs                                  │
 * │   = Uniform + Washing + Reliever + Training + Miscellaneous     │
 * └─────────────────────────────────────────────────────────────────┘
 * TOTAL COST TO CLIENT = Layer 1 + Layer 2 + Layer 3 + Layer 4
 *
 * Then billing adds:
 *   + Service Charge (e.g. 5% of total)
 *   + GST (18% of Service Charge, or full invoice depending on GST mode)
 *   = Grand Total Invoice Value
 */

const prisma = require('../../config/database');
const { r2, sum } = require('../../utils/decimal');

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function getCostSheet(runId, tenantId) {
  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, tenantId },
    include: {
      rows: {
        include: {
          employee: { select: { id: true, name: true, sr: true } },
          components: {
            include: { component: { select: { name: true, code: true, nature: true, type: true } } },
            where:    { component: { nature: { in: ['TENDER_COST'] } } },
          },
        },
        orderBy: { employee: { sr: 'asc' } },
      },
      tender: {
        include: {
          client:         { select: { name: true, gstin: true } },
          billingConfig:  true,
        },
      },
    },
  });

  if (!run) { const e = new Error('Payroll run not found'); e.statusCode = 404; throw e; }

  const rows = run.rows;

  // ── Layer 1: Employee take-home ───────────────────────────────
  const layer1 = {
    label:      'Employee Wages (Net Pay)',
    grossPay:    r2(sum(rows.map(r => Number(r.grossEarnings)))),
    pfEE:        r2(sum(rows.map(r => Number(r.pfEE)))),
    esicEE:      r2(sum(rows.map(r => Number(r.esicEE)))),
    pt:          r2(sum(rows.map(r => Number(r.pt)))),
    netPay:      r2(sum(rows.map(r => Number(r.netPay)))),
    loanDeductions: r2(sum(rows.map(r => Number(r.loanDeduction || 0)))),
  };
  layer1.totalDeductions = r2(layer1.pfEE + layer1.esicEE + layer1.pt + layer1.loanDeductions);

  // ── Layer 2: Statutory employer costs ─────────────────────────
  const layer2 = {
    label:       'Statutory Employer Costs',
    pfER:         r2(sum(rows.map(r => Number(r.pfER)))),
    erEPF:        r2(sum(rows.map(r => Number(r.erEPF || 0)))),
    erEPS:        r2(sum(rows.map(r => Number(r.erEPS || 0)))),
    edli:         r2(sum(rows.map(r => Number(r.edli || 0)))),
    adminCharge:  r2(sum(rows.map(r => Number(r.adminCharge || 0)))),
    esicER:       r2(sum(rows.map(r => Number(r.esicER)))),
  };
  layer2.total = r2(layer2.pfER + layer2.esicER + layer2.edli + layer2.adminCharge);

  // ── Layer 3: Provisions ────────────────────────────────────────
  const layer3 = {
    label:             'Provisions (Accrued Monthly)',
    bonusProvision:     r2(sum(rows.map(r => Number(r.bonusProvision     || 0)))),
    gratuityProvision:  r2(sum(rows.map(r => Number(r.gratuityProvision  || 0)))),
    leaveWageProvision: r2(sum(rows.map(r => Number(r.leaveWageProvision || 0)))),
  };
  layer3.total = r2(layer3.bonusProvision + layer3.gratuityProvision + layer3.leaveWageProvision);

  // ── Layer 4: Tender-specific costs ────────────────────────────
  // These come from PayrollRowComponents with nature = TENDER_COST
  const tenderCostMap = {};
  for (const row of rows) {
    for (const comp of (row.components || [])) {
      const code = comp.component.code;
      if (!tenderCostMap[code]) {
        tenderCostMap[code] = { name: comp.component.name, code, total: 0 };
      }
      tenderCostMap[code].total = r2(tenderCostMap[code].total + Number(comp.computedValue));
    }
  }
  const layer4Items = Object.values(tenderCostMap);
  const layer4 = {
    label: 'Tender-Specific Costs',
    items: layer4Items,
    total: r2(sum(layer4Items.map(i => i.total))),
  };

  // ── Grand Total ───────────────────────────────────────────────
  const totalCostToClient = r2(
    layer1.grossPay +   // Full gross (not net — employer pays gross + statutory)
    layer2.total +
    layer3.total +
    layer4.total
  );

  // ── Service Charge & GST ──────────────────────────────────────
  const billingConfig    = run.tender?.billingConfig;
  const serviceChargeRate = Number(billingConfig?.serviceChargeRate || 0) / 100;
  const serviceCharge     = r2(totalCostToClient * serviceChargeRate);

  const gstMode      = billingConfig?.gstMode || 'INTRA_STATE';
  const gstableAmount = gstMode === 'SERVICE_CHARGE_ONLY' ? serviceCharge : totalCostToClient + serviceCharge;

  const cgstRate  = Number(billingConfig?.cgstRate || 9) / 100;
  const sgstRate  = Number(billingConfig?.sgstRate || 9) / 100;
  const igstRate  = Number(billingConfig?.igstRate || 18) / 100;

  let cgst = 0, sgst = 0, igst = 0;
  if (gstMode === 'INTER_STATE') {
    igst = r2(gstableAmount * igstRate);
  } else {
    cgst = r2(gstableAmount * cgstRate);
    sgst = r2(gstableAmount * sgstRate);
  }
  const totalGST   = r2(cgst + sgst + igst);
  const grandTotal = r2(totalCostToClient + serviceCharge + totalGST);

  // ── Per-employee breakdown ────────────────────────────────────
  const employeeBreakdown = rows.map(row => ({
    sr:                row.employee.sr,
    name:              row.employee.name,
    workDays:          row.workDays,
    grossEarnings:     r2(row.grossEarnings),
    pfEE:              r2(row.pfEE),
    pfER:              r2(row.pfER),
    esicEE:            r2(row.esicEE),
    esicER:            r2(row.esicER),
    pt:                r2(row.pt),
    netPay:            r2(row.netPay),
    bonusProvision:    r2(row.bonusProvision     || 0),
    gratuityProvision: r2(row.gratuityProvision  || 0),
    leaveWage:         r2(row.leaveWageProvision || 0),
    totalCostToClient: r2(
      Number(row.grossEarnings) +
      Number(row.pfER) + Number(row.esicER) +
      Number(row.edli || 0) + Number(row.adminCharge || 0) +
      Number(row.bonusProvision || 0) + Number(row.gratuityProvision || 0) + Number(row.leaveWageProvision || 0)
    ),
  }));

  return {
    run: {
      id:     run.id,
      month:  run.month,
      year:   run.year,
      label:  `${MONTHS[run.month]} ${run.year}`,
      status: run.status,
    },
    tender: {
      name:    run.tender?.name,
      client:  run.tender?.client?.name,
      gstin:   run.tender?.client?.gstin,
    },
    summary: {
      totalEmployees:   rows.length,
      layer1, layer2, layer3, layer4,
      totalCostToClient,
      serviceChargeRate: (serviceChargeRate * 100).toFixed(2) + '%',
      serviceCharge,
      gstMode,
      cgst, sgst, igst,
      totalGST,
      grandTotal,
    },
    employeeBreakdown,
  };
}

module.exports = { getCostSheet };
