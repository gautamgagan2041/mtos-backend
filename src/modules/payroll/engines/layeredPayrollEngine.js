'use strict';

const { calculatePF } = require('./pfEngine');
const { calculateESIC } = require('./esicEngine');
const { evaluateFormula } = require('../../../utils/formulaParser');

const r2 = (n) => Math.round((n || 0) * 100) / 100;

const NATURE = {
  EARNING: 'EARNING',
  DEDUCTION: 'DEDUCTION',
  EMPLOYER_COST: 'EMPLOYER_COST',
  PROVISION: 'PROVISION',
  TENDER_COST: 'TENDER_COST',
};

// 🔥 NEW BASE ENGINE (MOST IMPORTANT)
function getBaseValue(sc, computed) {
  if (sc.baseCode && computed[sc.baseCode] !== undefined) {
    return computed[sc.baseCode];
  }

  if (sc.baseGroup === 'GROSS') {
    return Object.values(computed).reduce((s, v) => s + v, 0);
  }

  return computed['BASIC'] ?? computed['BASIC_VDA'] ?? 0;
}

function calculateLayered(input) {
  const {
    structureComponents,
    attendance,
    esicEligible,
    ptSlabs = [],
    workingDays = 26,
  } = input;

  const presentDays = attendance.presentDays || 0;
  const otHours = attendance.otHours || 0;

  const earnings = {};
  const deductions = {};
  const employer = {};
  const provisions = {};
  const tenderCost = {};

  const computed = {};

  for (const sc of structureComponents) {
    if (!sc.isActive) continue;

    const comp = sc.component;
    const nature = comp.nature;

    let value = 0;

    switch (sc.calculationType) {
      case 'FIXED':
        value = presentDays >= workingDays
          ? sc.value
          : r2((sc.value / workingDays) * presentDays);
        break;

      case 'PERCENT_BASIC':
      case 'PERCENTAGE':
        const base = getBaseValue(sc, computed);
        value = r2(base * ((sc.value || 0) / 100));
        break;

      case 'FORMULA':
        value = r2(evaluateFormula(sc.formula, {
          ...computed,
          presentDays,
          otHours,
          workingDays,
          GROSS: Object.values(computed).reduce((s, v) => s + v, 0),
        }));
        break;

      case 'PER_DAY':
        value = r2((sc.value || 0) * presentDays);
        break;

      case 'OT_BASED':
        const basic = computed['BASIC'] || 0;
        const hourly = (basic / workingDays) / 8;
        value = r2(otHours * hourly * 2);
        break;

      default:
        value = r2(sc.value || 0);
    }

    computed[comp.code] = value;

    if (nature === NATURE.EARNING) earnings[comp.code] = value;
    if (nature === NATURE.DEDUCTION) deductions[comp.code] = value;
    if (nature === NATURE.EMPLOYER_COST) employer[comp.code] = value;
    if (nature === NATURE.PROVISION) provisions[comp.code] = value;
    if (nature === NATURE.TENDER_COST) tenderCost[comp.code] = value;
  }

  const gross = r2(Object.values(earnings).reduce((s, v) => s + v, 0));

  const pf = calculatePF(computed.BASIC || 0, 0, gross, 'CAPPED', 15000);

  deductions['PF_EE'] = pf.pfEE;

  if (esicEligible) {
    const esic = calculateESIC(gross);
    deductions['ESIC_EE'] = esic.esicEE;
    employer['ESIC_ER'] = esic.esicER;
  }

  employer['PF_ER'] = pf.pfER;
  employer['EDLI'] = pf.edli;
  employer['ADMIN'] = pf.adminCharge;

  const totalDed = r2(Object.values(deductions).reduce((s, v) => s + v, 0));
  const net = r2(gross - totalDed);

  const totalEmployer = r2(Object.values(employer).reduce((s, v) => s + v, 0));
  const totalProv = r2(Object.values(provisions).reduce((s, v) => s + v, 0));
  const totalTender = r2(Object.values(tenderCost).reduce((s, v) => s + v, 0));

  const costToClient = r2(gross + totalEmployer + totalProv + totalTender);

  return {
    grossEarnings: gross,
    totalDeductions: totalDed,
    netPay: net,
    layer1Earnings: earnings,
    layer1Deductions: deductions,
    layer2Employer: employer,
    layer3Provisions: provisions,
    layer4Tender: tenderCost,
    totalCostToClient: costToClient,
  };
}

module.exports = { calculateLayered, NATURE };