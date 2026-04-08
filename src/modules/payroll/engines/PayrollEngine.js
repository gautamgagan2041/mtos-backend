'use strict';

const { calculatePF } = require('./pfEngine');
const { calculateESIC, resolveESICEligibility } = require('./esicEngine');
const { evaluateFormula } = require('../../../utils/formulaParser');
const payrollRepository = require('../payroll.repository');

const r2 = (n) => Math.round((n || 0) * 100) / 100;

// ─────────────────────────────────────────────────────────────
// PT
// ─────────────────────────────────────────────────────────────
function calculatePT(grossEarnings, ptSlabs = []) {
  for (const slab of ptSlabs) {
    if (grossEarnings >= slab.minSalary &&
       (!slab.maxSalary || grossEarnings <= slab.maxSalary)) {
      return r2(slab.ptAmount);
    }
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────
// COMPONENT ENGINE
// ─────────────────────────────────────────────────────────────
function calculateComponents(structureComponents, attendance, esicEligible, ptSlabs = []) {
  const componentBreakdown = [];
  const computed = {};

  let grossEarnings = 0;
  let totalDeductions = 0;

  const presentDays = attendance.presentDays || 0;
  const otHours     = attendance.otHours || 0;
  const nightShifts = attendance.nightShifts || 0;
  const workingDays = 26;

  const sorted = [...structureComponents].sort((a, b) => {
    if (a.component.type === 'EARNING' && b.component.type !== 'EARNING') return -1;
    if (a.component.type !== 'EARNING' && b.component.type === 'EARNING') return 1;
    return (a.component.displayOrder || 0) - (b.component.displayOrder || 0);
  });

  for (const sc of sorted) {
    if (!sc.isActive) continue;

    const comp = sc.component;
    let value = 0;

    switch (sc.calculationType) {

      case 'FIXED':
        if (comp.type === 'EARNING') {
          value = presentDays >= workingDays
            ? sc.value
            : r2((sc.value / workingDays) * presentDays);
        } else {
          value = sc.value || 0;
        }
        break;

      case 'PERCENT_BASIC': {
        const base = computed['BASIC'] ?? computed['BASIC_VDA'] ?? 0;
        value = r2(base * ((sc.value || 0) / 100));
        break;
      }

      case 'PER_DAY':
        value = r2((sc.value || 0) * presentDays);
        break;

      case 'PER_HOUR':
        value = r2((sc.value || 0) * otHours);
        break;

      case 'PER_SHIFT':
        value = r2((sc.value || 0) * (nightShifts || presentDays));
        break;

      case 'OT_BASED': {
        const basic = computed['BASIC'] ?? 0;
        const hourly = (basic / workingDays) / 8;
        value = r2(otHours * hourly * 2);
        break;
      }

      case 'ATTENDANCE_BASED':
        value = presentDays >= (sc.threshold ?? 24)
          ? r2(sc.thresholdBonus || 0)
          : 0;
        break;

      case 'FORMULA':
        try {
          value = r2(evaluateFormula(sc.formula, {
            ...computed,
            presentDays,
            otHours,
            nightShifts,
            workingDays
          }));
        } catch (err) {
          console.error(`[Formula Error] ${comp.code}: ${err.message}`);
          value = 0;
        }
        break;

      case 'MANUAL':
        value = r2(sc.value || 0);
        break;

      default:
        value = r2(sc.value || 0);
    }

    value = r2(Math.max(0, value));
    computed[comp.code] = value;

    componentBreakdown.push({
      componentId: comp.id,
      componentName: comp.name,
      componentCode: comp.code,
      type: comp.type,
      calculationType: sc.calculationType,
      computedValue: value,
    });

    if (comp.type === 'EARNING') {
      grossEarnings += value;
    } else {
      totalDeductions += value;
    }
  }

  grossEarnings   = r2(grossEarnings);
  totalDeductions = r2(totalDeductions);

  // ── PF
  const basic = computed['BASIC'] ?? computed['BASIC_VDA'] ?? 0;
  const vda   = computed['VDA'] ?? 0;
  const pf    = calculatePF(basic, vda, grossEarnings, 'CAPPED', 15000);

  // ── ESIC
  let esicEE = 0, esicER = 0;
  if (esicEligible) {
    const esic = calculateESIC(grossEarnings);
    esicEE = esic.esicEE;
    esicER = esic.esicER;
  }

  // ── PT
  const pt = calculatePT(grossEarnings, ptSlabs);

  // ── Avoid duplication
  const hasPF   = componentBreakdown.some(c => c.componentCode === 'PF_EE');
  const hasESIC = componentBreakdown.some(c => c.componentCode === 'ESIC_EE');
  const hasPT   = componentBreakdown.some(c => c.componentCode === 'PT');

  if (!hasPF && pf.pfEE > 0) totalDeductions += pf.pfEE;
  if (!hasESIC && esicEE > 0) totalDeductions += esicEE;
  if (!hasPT && pt > 0) totalDeductions += pt;

  totalDeductions = r2(totalDeductions);
  const netPay = r2(Math.max(0, grossEarnings - totalDeductions));

  return {
    componentBreakdown,
    grossEarnings,
    totalDeductions,
    netPay,
    pfWage: pf.pfWage,
    pfEE: pf.pfEE,
    pfER: pf.pfER,
    erEPF: pf.erEPF,
    erEPS: pf.erEPS,
    edli: pf.edli,
    adminCharge: pf.adminCharge,
    esicEE,
    esicER,
    pt,
  };
}

// ─────────────────────────────────────────────────────────────
// MAIN RUNNER
// ─────────────────────────────────────────────────────────────
async function runPayroll(tenantId, tenderId, month, year, runByUserId) {

  const monthNum = Number(month);
  const yearNum  = Number(year);

  if (monthNum < 1 || monthNum > 12) throw new Error('Invalid month');
  if (yearNum < 2020) throw new Error('Invalid year');

  const tender = await payrollRepository.getTenderForPayroll(tenderId, monthNum, yearNum);
  if (!tender) throw new Error('Tender not found');

  const ptConfig = await payrollRepository.getPTConfig(tenantId, 'MAHARASHTRA');
  const ptSlabs  = ptConfig?.slabs || [];

  const run = await payrollRepository.createRun(tenantId, tenderId, monthNum, yearNum, runByUserId);

  const rowsToSave = [];

  for (const te of tender.employees) {
    const attendance = te.attendance[0];
    if (!attendance) continue;

    // PASS 1
    const pass1 = calculateComponents(tender.salaryStructure.components, attendance, false, ptSlabs);

    const esicEligible = await resolveESICEligibility(
      tenantId,
      te.employeeId,
      pass1.grossEarnings,
      monthNum,
      yearNum
    );

    // PASS 2
    const result = calculateComponents(
      tender.salaryStructure.components,
      attendance,
      esicEligible,
      ptSlabs
    );

    rowsToSave.push({
      employeeId: te.employeeId,
      attendanceId: attendance.id,
      rank: te.rank,
      grossEarnings: result.grossEarnings,
      totalDeductions: result.totalDeductions,
      netPay: result.netPay,
      pfEE: result.pfEE,
      pfER: result.pfER,
      esicEE: result.esicEE,
      esicER: result.esicER,
      pt: result.pt,
      components: result.componentBreakdown,
    });
  }

  await payrollRepository.savePayrollRows(run.id, rowsToSave);

  return { runId: run.id, rows: rowsToSave.length };
}

module.exports = {
  runPayroll,
  calculateComponents,
  calculatePT
};