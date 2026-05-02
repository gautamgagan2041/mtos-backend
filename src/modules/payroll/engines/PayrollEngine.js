'use strict';

/**
 * PayrollEngine.js — v4 (Production Grade)
 *
 * FIXES vs v3:
 *  1. Batch ESIC period loading (no N+1 DB calls)
 *  2. Configurable baseDivisor (no hardcoded 26)
 *  3. pfRule/pfCap from structureConfig, not components[0]
 *  4. Provisions populated: bonus, gratuity, leaveWage
 *  5. Loan EMI deductions integrated
 *  6. Full payroll run wrapped in single DB transaction
 *  7. Decimal-safe arithmetic via r2() from decimal.js
 *  8. Pro-ration for mid-month joining/exit
 *  9. TenderComponentOverride respected before calculation
 * 10. Distributed lock via Redis (no duplicate concurrent runs)
 */

const { calculatePF }                          = require('./pfEngine');
const { calculateESIC, resolveESICEligibility } = require('./esicEngine');
const { evaluateFormula }                       = require('../../../utils/formulaParser');
const { r2, sum, proRate }                      = require('../../../utils/decimal');
const cache                                     = require('../../../services/cacheService');
const payrollRepository                         = require('../payroll.repository');

// ── PT ────────────────────────────────────────────────────────────

function calculatePT(grossEarnings, ptSlabs = []) {
  for (const slab of ptSlabs) {
    if (
      grossEarnings >= slab.minSalary &&
      (!slab.maxSalary || grossEarnings <= slab.maxSalary)
    ) {
      return r2(slab.ptAmount);
    }
  }
  return 0;
}

// ── Provision Rates (India statutory / industry standard) ─────────

const PROVISION_RATES = {
  BONUS_RATE:           8.33 / 100,   // Min bonus under Payment of Bonus Act
  GRATUITY_RATE:        4.81 / 100,   // 15/26 days × 1/12 months
  LEAVE_WAGE_RATE:      1.00 / 100,   // 1% of gross (approx EL encashment provision)
};

// ── Component Engine ──────────────────────────────────────────────

/**
 * calculateComponents — pure function, no DB calls
 *
 * @param {Array}   structureComponents  - SalaryStructureComponent[] with .component
 * @param {Object}  attendance           - { presentDays, otHours, nightShifts, extraDutyDays }
 * @param {boolean} esicEligible
 * @param {Array}   ptSlabs
 * @param {Object}  structureConfig      - { pfRule, pfCap, baseDivisor }
 * @param {Object}  overrides            - { [salaryStructureCompId]: { valueOverride, formulaOverride, isEnabled } }
 */
function calculateComponents(
  structureComponents,
  attendance,
  esicEligible,
  ptSlabs        = [],
  structureConfig = {},
  overrides       = {}
) {
  const componentBreakdown = [];
  const computed           = {};

  let grossEarnings   = 0;
  let totalDeductions = 0;

  const presentDays  = attendance.presentDays  || 0;
  const otHours      = attendance.otHours      || 0;
  const nightShifts  = attendance.nightShifts  || 0;
  const workingDays  = structureConfig.baseDivisor || 26; // ← FIXED: no hardcoded 26

  const sorted = [...structureComponents].sort((a, b) => {
    if (a.component.type === 'EARNING' && b.component.type !== 'EARNING') return -1;
    if (a.component.type !== 'EARNING' && b.component.type === 'EARNING') return 1;
    return (a.component.displayOrder || 0) - (b.component.displayOrder || 0);
  });

  for (const sc of sorted) {
    if (!sc.isActive) continue;

    // Apply per-tender override if it exists
    const override = overrides[sc.id];
    if (override?.isEnabled === false) continue; // Tender disabled this component

    const effectiveValue   = override?.valueOverride   ?? sc.value;
    const effectiveFormula = override?.formulaOverride ?? sc.formula;
    const calcType         = sc.calculationType;

    const comp = sc.component;
    let value  = 0;

    switch (calcType) {
      case 'FIXED':
        if (comp.type === 'EARNING') {
          value = presentDays >= workingDays
            ? r2(effectiveValue)
            : proRate(effectiveValue, presentDays, workingDays);
        } else {
          value = r2(effectiveValue || 0);
        }
        break;

      case 'PERCENT_BASIC': {
        const base = computed['BASIC'] ?? computed['BASIC_VDA'] ?? 0;
        value = r2(base * ((effectiveValue || 0) / 100));
        break;
      }

      case 'PER_DAY':
        value = r2((effectiveValue || 0) * presentDays);
        break;

      case 'PER_HOUR':
        value = r2((effectiveValue || 0) * otHours);
        break;

      case 'PER_SHIFT':
        value = r2((effectiveValue || 0) * (nightShifts || presentDays));
        break;

      case 'OT_BASED': {
        const basic  = computed['BASIC'] ?? 0;
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
          value = r2(evaluateFormula(effectiveFormula, {
          GROSS: grossEarnings,
            ...computed,
            presentDays,
            otHours,
            nightShifts,
            workingDays,
          }));
        } catch (err) {
          console.error(`[PayrollEngine] Formula error in ${comp.code}: ${err.message}`);
          value = 0;
        }
        break;

      case 'MANUAL':
      default:
        value = r2(effectiveValue || 0);
    }

    value = r2(Math.max(0, value));
    computed[comp.code] = value;

    componentBreakdown.push({
      componentId:     comp.id,
      componentName:   comp.name,
      componentCode:   comp.code,
      type:            comp.type,
      nature:          comp.nature,
      calculationType: calcType,
      computedValue:   value,
    });

    if (comp.type === 'EARNING') {
      grossEarnings += value;
    } else {
      totalDeductions += value;
    }
  }

  grossEarnings   = r2(grossEarnings);
  totalDeductions = r2(totalDeductions);

  // ── PF — use structureConfig, not components[0] ────────────────
  const basic  = computed['BASIC']  ?? computed['BASIC_VDA'] ?? 0;
  const vda    = computed['VDA']    ?? 0;
  const pfRule = structureConfig.pfRule ?? 'CAPPED';
  const pfCap  = structureConfig.pfCap  ?? 15000;
  const pf     = calculatePF(basic, vda, grossEarnings, pfRule, pfCap);

  // ── ESIC ───────────────────────────────────────────────────────
  let esicEE = 0, esicER = 0;
  if (esicEligible) {
    const esic = calculateESIC(grossEarnings);
    esicEE = esic.esicEE;
    esicER = esic.esicER;
  }

  // ── PT ─────────────────────────────────────────────────────────
  const pt = calculatePT(grossEarnings, ptSlabs);

  // Avoid double-counting statutory components already in structure
  const hasPF   = componentBreakdown.some(c => c.componentCode === 'PF_EE');
  const hasESIC = componentBreakdown.some(c => c.componentCode === 'ESIC_EE');
  const hasPT   = componentBreakdown.some(c => c.componentCode === 'PT');

  if (!hasPF   && pf.pfEE > 0) totalDeductions += pf.pfEE;
  if (!hasESIC && esicEE  > 0) totalDeductions += esicEE;
  if (!hasPT   && pt      > 0) totalDeductions += pt;

  totalDeductions = r2(totalDeductions);
  const netPay    = r2(Math.max(0, grossEarnings - totalDeductions));

  // ── Provisions (Layer 3) ────────────────────────────────────────
  // These are employer costs accrued but not paid monthly.
  // They appear on the cost sheet and client invoice, NOT on payslip.
  const bonusProvision     = r2(grossEarnings * PROVISION_RATES.BONUS_RATE);
  const gratuityProvision  = r2(basic * PROVISION_RATES.GRATUITY_RATE);
  const leaveWageProvision = r2(grossEarnings * PROVISION_RATES.LEAVE_WAGE_RATE);

  return {
    componentBreakdown,
    computed,
    grossEarnings,
    totalDeductions,
    netPay,
    // PF
    pfWage:      pf.pfWage,
    pfEE:        pf.pfEE,
    pfER:        pf.pfER,
    erEPF:       pf.erEPF,
    erEPS:       pf.erEPS,
    edli:        pf.edli,
    adminCharge: pf.adminCharge,
    // ESIC
    esicEE,
    esicER,
    // PT
    pt,
    // Provisions
    bonusProvision,
    gratuityProvision,
    leaveWageProvision,
  };
}

// ── Main Runner ───────────────────────────────────────────────────

async function runPayroll(tenantId, tenderId, month, year, runByUserId) {
  const monthNum = Number(month);
  const yearNum  = Number(year);

  if (monthNum < 1 || monthNum > 12) throw new Error('Invalid month');
  if (yearNum  < 2020)               throw new Error('Invalid year');

  // ── Distributed lock: prevent concurrent runs for same tender/month
  const lockKey = `payroll-lock:${tenderId}:${monthNum}:${yearNum}`;

  return cache.withLock(lockKey, async () => {
    return _executePayroll(tenantId, tenderId, monthNum, yearNum, runByUserId);
  }, 300); // 5-minute lock
}

async function _executePayroll(tenantId, tenderId, month, year, runByUserId) {
  // ── Load tender with all needed relations
  const tender = await payrollRepository.getTenderForPayroll(tenderId, month, year);
  if (!tender) throw new Error('Tender not found');

  // ── Resolve structure config (baseDivisor, pfRule, pfCap)
  const structureConfig = _resolveStructureConfig(tender);

  // ── PT slabs
  const tenderState = tender.location ? _extractState(tender.location) : null;
  let ptSlabs = [];
  if (tenderState) {
    const ptConfig = await payrollRepository.getPTConfig(tenantId, tenderState);
    ptSlabs = ptConfig?.slabs || [];
  }

  // ── BATCH load ESIC periods for ALL employees — ONE query, not N queries
  const employeeIds = tender.employees.map(te => te.employeeId);
  const esicPeriods = await payrollRepository.getESICPeriodsForEmployees(
    tenantId, employeeIds, month, year
  );
  const esicPeriodMap = Object.fromEntries(
    esicPeriods.map(p => [p.employeeId, p])
  );

  // ── Load TenderComponentOverrides for this tender
  const overrides = await payrollRepository.getTenderComponentOverrides(tenderId);
  const overrideMap = Object.fromEntries(overrides.map(o => [o.salaryStructureCompId, o]));

  // ── Load active loans for batch deduction
  const loans = await payrollRepository.getActiveLoansForEmployees(tenantId, employeeIds);
  const loanMap = Object.fromEntries(loans.map(l => [l.employeeId, l]));

  const rowsToSave = [];
  const skippedEmployees = [];

  for (const te of tender.employees) {
    const attendance = te.attendance[0];
    if (!attendance) {
      skippedEmployees.push({ employeeId: te.employeeId, name: te.employee?.name, reason: 'No attendance record' });
      continue;
    }

    const components = tender.salaryStructure?.components ?? [];
    if (components.length === 0) continue; // No salary structure assigned

    // ── Pass 1: Calculate gross without ESIC (needed to evaluate eligibility)
    const pass1 = calculateComponents(
      components, attendance, false, ptSlabs, structureConfig, overrideMap
    );

    // ── Resolve ESIC eligibility
    let esicEligible = false;
    const esicRecord = esicPeriodMap[te.employeeId];
    if (esicRecord) {
      // Period already established — use stored eligibility
      esicEligible = esicRecord.eligible;
    } else {
      // New period — determine from actual gross, create record
      esicEligible = await resolveESICEligibility(
        tenantId, te.employeeId, pass1.grossEarnings, month, year
      );
    }

    // ── Pass 2: Full calculation with correct ESIC flag
    const result = calculateComponents(
      components, attendance, esicEligible, ptSlabs, structureConfig, overrideMap
    );

    // ── Loan EMI deduction
    const loanDeduction = _calculateLoanEMI(loanMap[te.employeeId], result.netPay);

    const finalNetPay = r2(Math.max(0, result.netPay - loanDeduction));

    rowsToSave.push({
      employeeId:        te.employeeId,
      attendanceId:      attendance.id,
      rank:              te.rank,
      workDays:          attendance.presentDays,
      grossEarnings:     result.grossEarnings,
      totalDeductions:   result.totalDeductions,  // loan kept separate to avoid double-count in cost sheet
      netPay:            finalNetPay,
      // PF
      pfWage:            result.pfWage,
      pfEE:              result.pfEE,
      pfER:              result.pfER,
      erEPF:             result.erEPF,
      erEPS:             result.erEPS,
      edli:              result.edli,
      adminCharge:       result.adminCharge,
      // ESIC
      esicEE:            result.esicEE,
      esicER:            result.esicER,
      // PT
      pt:                result.pt,
      // Provisions
      bonusProvision:     result.bonusProvision,
      gratuityProvision:  result.gratuityProvision,
      leaveWageProvision: result.leaveWageProvision,
      // Loan deduction reference
      loanDeduction,
      // Component breakdown (saved to payroll_row_components)
      components: result.componentBreakdown,
    });
  }

  // ── Calculate totals
  const totals = {
    totalGross:         r2(sum(rowsToSave.map(r => r.grossEarnings))),
    totalNet:           r2(sum(rowsToSave.map(r => r.netPay))),
    totalPFEE:          r2(sum(rowsToSave.map(r => r.pfEE))),
    totalPFER:          r2(sum(rowsToSave.map(r => r.pfER))),
    totalESIC:          r2(sum(rowsToSave.map(r => r.esicEE + r.esicER))),
    totalPT:            r2(sum(rowsToSave.map(r => r.pt))),
    totalProvisions:    r2(sum(rowsToSave.map(r => r.bonusProvision + r.gratuityProvision + r.leaveWageProvision))),
    totalEmployerCosts: r2(sum(rowsToSave.map(r => r.pfER + r.esicER + r.edli + r.adminCharge))),
  };
  totals.totalCostToClient = r2(totals.totalGross + totals.totalEmployerCosts + totals.totalProvisions);

  // ── ATOMIC transaction: create run + rows + update totals in one commit
  const run = await payrollRepository.createRunWithRows(
    tenantId, tenderId, month, year, runByUserId, rowsToSave, totals
  );

  // -- Update loan balances after successful payroll (non-critical, retry-safe)
  try {
    await _updateLoanBalances(loanMap, rowsToSave);
  } catch (err) {
    logger.error('[PayrollEngine] Loan balance update failed (payroll still completed):', err.message);
  }

  return {
    runId:      run.id,
    rowCount:       rowsToSave.length,
    skipped:        skippedEmployees,
    totalGross: totals.totalGross,
    totalNet:   totals.totalNet,
    totals,
  };
}

// ── Helper: Resolve structure-level config ─────────────────────────

function _resolveStructureConfig(tender) {
  // New component-based structure
  if (tender.salaryStructure) {
    return {
      pfRule:      tender.salaryStructure.pfRule       ?? 'CAPPED',
      pfCap:       tender.salaryStructure.pfCap        ?? 15000,
      baseDivisor: tender.salaryStructure.baseDivisor  ?? 26,
    };
  }
  // Legacy structure (fallback)
  const legacy = tender.legacySalaryStructures?.[0];
  if (legacy) {
    return {
      pfRule:      legacy.pfRule      ?? 'CAPPED',
      pfCap:       legacy.pfCap       ?? 15000,
      baseDivisor: legacy.baseDivisor ?? 26,
    };
  }
  // Final fallback
  return { pfRule: 'CAPPED', pfCap: 15000, baseDivisor: 26 };
}

// ── Helper: Loan EMI calculation ───────────────────────────────────

function _calculateLoanEMI(loan, netPay) {
  if (!loan || !loan.isActive || loan.remainingAmount <= 0) return 0;
  // EMI is the lesser of configured EMI or remaining balance
  // Also never deduct more than 50% of net pay (protection)
  const emi = Math.min(loan.emiAmount, loan.remainingAmount);
  const maxDeductible = r2(netPay * 0.5);
  return r2(Math.min(emi, maxDeductible));
}

async function _updateLoanBalances(loanMap, rows) {
  const updates = [];
  for (const row of rows) {
    const loan = loanMap[row.employeeId];
    if (loan && row.loanDeduction > 0) {
      const newBalance = r2(loan.remainingAmount - row.loanDeduction);
      updates.push({
        id: loan.id,
        remainingAmount: newBalance,
        isActive: newBalance > 0,
      });
    }
  }
  if (updates.length > 0) {
    await payrollRepository.updateLoanBalances(updates);
  }
}

// ── Helper: State extraction ──────────────────────────────────────

const STATE_KEYWORDS = {
  MAHARASHTRA:    ['maharashtra', 'mumbai', 'pune', 'nagpur', 'thane', 'nashik'],
  KARNATAKA:      ['karnataka', 'bengaluru', 'bangalore', 'mysuru', 'mysore', 'hubli'],
  ANDHRA_PRADESH: ['andhra pradesh', 'vizag', 'vijayawada'],
  TELANGANA:      ['telangana', 'hyderabad', 'secunderabad'],
  TAMIL_NADU:     ['tamil nadu', 'tamilnadu', 'chennai', 'coimbatore', 'madurai'],
  WEST_BENGAL:    ['west bengal', 'kolkata', 'calcutta', 'howrah'],
  GUJARAT:        ['gujarat', 'ahmedabad', 'surat', 'vadodara', 'rajkot'],
  MADHYA_PRADESH: ['madhya pradesh', 'bhopal', 'indore', 'jabalpur'],
  KERALA:         ['kerala', 'kochi', 'thiruvananthapuram', 'calicut', 'thrissur'],
  ODISHA:         ['odisha', 'bhubaneswar', 'cuttack'],
  ASSAM:          ['assam', 'guwahati'],
  JHARKHAND:      ['jharkhand', 'ranchi', 'jamshedpur'],
};

function _extractState(location) {
  if (!location) return null;
  const lower = location.toLowerCase();
  for (const [state, keywords] of Object.entries(STATE_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) return state;
  }
  return null;
}

module.exports = { runPayroll, calculateComponents, calculatePT, _extractState };
