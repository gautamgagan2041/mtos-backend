// tests/payrollEngine.test.js
// Tests the pure calculation engine — no DB, no Prisma

const { calculateComponents, calculatePT } = require('../src/modules/payroll/engines/PayrollEngine');
const { calculatePF, calculatePFWage }     = require('../src/modules/payroll/engines/pfEngine');
const { calculateESIC, getESICPeriod }     = require('../src/modules/payroll/engines/esicEngine');

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Build a minimal structureComponents array matching what the DB returns.
 * Mirrors what getTenderForPayroll returns via salaryStructure.components.
 */
function makeComponents(overrides = {}) {
  const cfg = {
    basic:       19760,
    vda:         0,
    hraValue:    8,    // % of basic
    hraMinimum:  1800,
    washingRate: 3,    // % of basic
    bonusRate:   8.33, // % of basic
    bonusEnabled: true,
    uniformRate: 5,    // % of basic
    ...overrides,
  };

  const comps = [
    {
      isActive: true,
      calculationType: 'FIXED',
      value: cfg.basic,
      formula: null,
      component: { id: 'c1', code: 'BASIC', name: 'Basic', type: 'EARNING', displayOrder: 1 },
    },
    {
      isActive: true,
      calculationType: 'FIXED',
      value: cfg.vda,
      formula: null,
      component: { id: 'c2', code: 'VDA', name: 'VDA', type: 'EARNING', displayOrder: 2 },
    },
    {
      isActive: true,
      calculationType: 'PERCENT_BASIC',
      value: cfg.hraValue,
      formula: null,
      component: { id: 'c3', code: 'HRA', name: 'HRA', type: 'EARNING', displayOrder: 3 },
    },
    {
      isActive: true,
      calculationType: 'PERCENT_BASIC',
      value: cfg.washingRate,
      formula: null,
      component: { id: 'c4', code: 'WASHING', name: 'Washing', type: 'EARNING', displayOrder: 4 },
    },
    {
      isActive: true,
      calculationType: 'PERCENT_BASIC',
      value: cfg.bonusEnabled ? cfg.bonusRate : 0,
      formula: null,
      component: { id: 'c5', code: 'BONUS', name: 'Bonus', type: 'EARNING', displayOrder: 5 },
    },
  ];
  return comps;
}

function makeAttendance(presentDays, extraDutyDays = 0, otHours = 0) {
  return { presentDays, extraDutyDays, otHours, nightShifts: 0 };
}

// ── calculateComponents ───────────────────────────────────────────

describe('calculateComponents()', () => {

  test('full month (26 days) — gross and net are positive', () => {
    const comps  = makeComponents();
    const result = calculateComponents(comps, makeAttendance(26), false);
    expect(result.grossEarnings).toBeGreaterThan(0);
    expect(result.netPay).toBeGreaterThan(0);
    expect(result.netPay).toBeLessThan(result.grossEarnings);
  });

  test('full month basic = 19760 prorated correctly', () => {
    const comps  = makeComponents({ basic: 19760 });
    const result = calculateComponents(comps, makeAttendance(26), false);
    const basicComp = result.componentBreakdown.find(c => c.componentCode === 'BASIC');
    expect(basicComp.computedValue).toBe(19760);
  });

  test('partial month (13/26) prorates basic to half', () => {
    const comps = makeComponents({ basic: 19760 });
    const full  = calculateComponents(comps, makeAttendance(26), false);
    const half  = calculateComponents(comps, makeAttendance(13), false);
    const fullBasic = full.componentBreakdown.find(c => c.componentCode === 'BASIC').computedValue;
    const halfBasic = half.componentBreakdown.find(c => c.componentCode === 'BASIC').computedValue;
    expect(halfBasic).toBeCloseTo(fullBasic / 2, 0);
    expect(half.grossEarnings).toBeCloseTo(full.grossEarnings / 2, 0);
  });

  test('zero days returns zero gross and net', () => {
    const comps  = makeComponents();
    const result = calculateComponents(comps, makeAttendance(0), false);
    expect(result.grossEarnings).toBe(0);
    expect(result.netPay).toBe(0);
  });

  test('net pay = gross - deductions', () => {
    const comps  = makeComponents();
    const result = calculateComponents(comps, makeAttendance(20), true);
    expect(result.netPay).toBeCloseTo(
      result.grossEarnings - result.totalDeductions, 1
    );
  });

  test('ESIC applied when esicEligible=true', () => {
    const comps  = makeComponents({ basic: 8000 }); // low salary → eligible
    const result = calculateComponents(comps, makeAttendance(26), true);
    expect(result.esicEE).toBeGreaterThan(0);
    expect(result.esicER).toBeGreaterThan(0);
  });

  test('ESIC NOT applied when esicEligible=false', () => {
    const comps  = makeComponents({ basic: 30000 });
    const result = calculateComponents(comps, makeAttendance(26), false);
    expect(result.esicEE).toBe(0);
    expect(result.esicER).toBe(0);
  });

  test('disabled component (isActive=false) is skipped', () => {
    const comps = makeComponents();
    comps[4].isActive = false; // disable BONUS
    const result = calculateComponents(comps, makeAttendance(26), false);
    const bonus = result.componentBreakdown.find(c => c.componentCode === 'BONUS');
    expect(bonus).toBeUndefined();
  });

});

// ── calculatePT ───────────────────────────────────────────────────

describe('calculatePT()', () => {
  const slabs = [
    { minSalary: 0,     maxSalary: 7500,  ptAmount: 0 },
    { minSalary: 7501,  maxSalary: 10000, ptAmount: 175 },
    { minSalary: 10001, maxSalary: null,  ptAmount: 200 },
  ];

  test('gross < 7500 → PT = 0', () => {
    expect(calculatePT(6000, slabs)).toBe(0);
  });

  test('gross 8000 → PT = 175', () => {
    expect(calculatePT(8000, slabs)).toBe(175);
  });

  test('gross 15000 → PT = 200', () => {
    expect(calculatePT(15000, slabs)).toBe(200);
  });

  test('no slabs → PT = 0', () => {
    expect(calculatePT(20000, [])).toBe(0);
  });
});

// ── PF Engine ─────────────────────────────────────────────────────

describe('calculatePF()', () => {

  test('CAPPED rule caps wage at 15000', () => {
    const result = calculatePF(19760, 0, 22000, 'CAPPED', 15000);
    expect(result.pfWage).toBe(15000);
  });

  test('CAPPED — EE = 12% of pfWage', () => {
    const result = calculatePF(19760, 0, 22000, 'CAPPED', 15000);
    expect(result.pfEE).toBeCloseTo(15000 * 0.12, 1); // 1800
  });

  test('ACTUAL rule uses full gross (no cap)', () => {
    const result = calculatePF(25000, 0, 25000, 'ACTUAL', 15000);
    expect(result.pfWage).toBe(25000);
  });

  test('BASIC_ONLY rule uses only basic, capped', () => {
    const result = calculatePF(12000, 3000, 18000, 'BASIC_ONLY', 15000);
    expect(result.pfWage).toBe(12000); // basic only, under cap
  });

  test('BASIC_VDA caps (basic+vda) at pfCap', () => {
    const result = calculatePF(12000, 5000, 20000, 'BASIC_VDA', 15000);
    expect(result.pfWage).toBe(15000); // 17000 capped to 15000
  });

  test('erEPF + erEPS = pfER (12% total)', () => {
    const result = calculatePF(10000, 0, 10000, 'ACTUAL', 15000);
    expect(result.erEPF + result.erEPS).toBeCloseTo(result.pfER, 1);
  });

  test('zero basic returns zero PF', () => {
    const result = calculatePF(0, 0, 0);
    expect(result.pfEE).toBe(0);
    expect(result.pfER).toBe(0);
  });

});

// ── ESIC Engine ───────────────────────────────────────────────────

describe('calculateESIC()', () => {

  test('EE = 0.75% of gross', () => {
    const result = calculateESIC(20000);
    expect(result.esicEE).toBeCloseTo(20000 * 0.0075, 2);
  });

  test('ER = 3.25% of gross', () => {
    const result = calculateESIC(20000);
    expect(result.esicER).toBeCloseTo(20000 * 0.0325, 2);
  });

  test('zero gross returns zero ESIC', () => {
    const result = calculateESIC(0);
    expect(result.esicEE).toBe(0);
    expect(result.esicER).toBe(0);
  });

});

describe('getESICPeriod()', () => {

  test('April falls in Period 1 (Apr–Sep)', () => {
    const period = getESICPeriod(new Date('2026-04-01'));
    expect(period.start.getUTCMonth()).toBe(3); // April = 3
    expect(period.end.getUTCMonth()).toBe(8);   // Sep = 8
  });

  test('October falls in Period 2 (Oct–Mar)', () => {
    const period = getESICPeriod(new Date('2026-10-15'));
    expect(period.start.getUTCMonth()).toBe(9); // Oct = 9
    expect(period.end.getUTCFullYear()).toBe(2027);
  });

  test('February falls in Period 2 (previous Oct – Mar)', () => {
    const period = getESICPeriod(new Date('2026-02-15'));
    expect(period.start.getUTCFullYear()).toBe(2025);
    expect(period.start.getUTCMonth()).toBe(9); // Oct 2025
  });

  test('throws on invalid date', () => {
    expect(() => getESICPeriod('not-a-date')).toThrow();
  });

});

// ── Formula Parser ────────────────────────────────────────────────

const { evaluateFormula } = require('../src/utils/formulaParser');

describe('evaluateFormula()', () => {

  test('basic arithmetic', () => {
    expect(evaluateFormula('100 + 200')).toBe(300);
    expect(evaluateFormula('500 - 100')).toBe(400);
    expect(evaluateFormula('50 * 2')).toBe(100);
    expect(evaluateFormula('100 / 4')).toBe(25);
  });

  test('operator precedence (* before +)', () => {
    expect(evaluateFormula('100 + 50 * 2')).toBe(200);
  });

  test('parentheses override precedence', () => {
    expect(evaluateFormula('(100 + 50) * 2')).toBe(300);
  });

  test('context substitution — component codes', () => {
    expect(evaluateFormula('BASIC * 0.08', { BASIC: 19760 })).toBeCloseTo(1580.8, 1);
  });

  test('max() function', () => {
    expect(evaluateFormula('max(BASIC * 0.08, 1800)', { BASIC: 19760 })).toBe(1800);
    expect(evaluateFormula('max(BASIC * 0.08, 1800)', { BASIC: 30000 })).toBe(2400);
  });

  test('min() function', () => {
    expect(evaluateFormula('min(BASIC, 15000)', { BASIC: 19760 })).toBe(15000);
    expect(evaluateFormula('min(BASIC, 15000)', { BASIC: 10000 })).toBe(10000);
  });

  test('abs() function', () => {
    expect(evaluateFormula('abs(-500)')).toBe(500);
  });

  test('nested functions', () => {
    expect(evaluateFormula('max(min(BASIC, 15000) * 0.12, 0)', { BASIC: 19760 })).toBeCloseTo(1800, 1);
  });

  test('division by zero throws', () => {
    expect(() => evaluateFormula('100 / 0')).toThrow();
  });

  test('unknown function throws', () => {
    expect(() => evaluateFormula('eval(1)')).toThrow();
    expect(() => evaluateFormula('require(fs)')).toThrow();
  });

  test('unsafe context key throws', () => {
    expect(() => evaluateFormula('x', { '__proto__': 999 })).toThrow();
    expect(() => evaluateFormula('x', { 'constructor': 1 })).toThrow();
  });

  test('empty formula returns 0', () => {
    expect(evaluateFormula('')).toBe(0);
    expect(evaluateFormula(null)).toBe(0);
  });

  test('all context keys provided evaluates correctly', () => {
    expect(evaluateFormula('BASIC + BONUS', { BASIC: 10000, BONUS: 0 })).toBe(10000);
  });

  test('unresolved variable (not in context) throws — prevents silent zero bugs', () => {
    // Unresolved codes remain as alphabetic chars → safety check rejects them.
    // Callers must always pass a complete context. This is intentional.
    expect(() => evaluateFormula('BASIC + UNKNOWN_CODE', { BASIC: 10000 })).toThrow();
  });

});
