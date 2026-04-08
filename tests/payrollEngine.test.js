// tests/payrollEngine.test.js
const { calculateRow } = require('../src/services/payrollEngine');

const mockStructureSG = {
  basicSalary: 19760,
  vda: 0,
  hraType: 'percentage',
  hraValue: 0.08,
  hraMinimum: 1800,
  washingRate: 0.03,
  bonusRate: 0.0833,
  bonusEnabled: true,
  uniformRate: 0.05,
  pfRule: 'CAPPED',
  pfCap: 15000,
  pfEERate: 0.12,
  pfERRate: 0.13,
  esicEnabled: true,
  esicThreshold: 21000,
  esicEERate: 0.0075,
  esicERRate: 0.0325,
  baseDivisor: 26,
};

describe('Payroll Engine — calculateRow()', () => {
  test('Full month (26 days) calculation is accurate', () => {
    const result = calculateRow(mockStructureSG, 26, 0);
    expect(result.payableBasic).toBe(19760);
    expect(result.pfWage).toBe(15000); // capped at 15000
    expect(result.pfEE).toBe(1800);    // 15000 * 0.12
    expect(result.pfER).toBe(1950);    // 15000 * 0.13
    expect(result.netPay).toBeGreaterThan(0);
    expect(result.netPay).toBeLessThan(result.totalPayable);
  });

  test('Partial month (13 days) calculates proportionally', () => {
    const full = calculateRow(mockStructureSG, 26, 0);
    const half = calculateRow(mockStructureSG, 13, 0);
    expect(half.payableBasic).toBeCloseTo(full.payableBasic / 2, 0);
    expect(half.netPay).toBeCloseTo(full.netPay / 2, 0);
  });

  test('ESIC not applied when salary exceeds threshold (21000)', () => {
    const highSalaryStructure = {
      ...mockStructureSG,
      basicSalary: 30000,
      esicEnabled: true,
      esicThreshold: 21000,
    };
    const result = calculateRow(highSalaryStructure, 26, 0);
    // totalPayable will exceed 21000, so ESIC should be 0
    if (result.totalPayable > 21000) {
      expect(result.esicEE).toBe(0);
      expect(result.esicER).toBe(0);
    }
  });

  test('Bonus disabled returns 0 bonus', () => {
    const noBonusStructure = { ...mockStructureSG, bonusEnabled: false };
    const result = calculateRow(noBonusStructure, 26, 0);
    expect(result.bonus).toBe(0);
  });

  test('Extra duty days add to total payable', () => {
    const withED  = calculateRow(mockStructureSG, 26, 2);
    const without = calculateRow(mockStructureSG, 26, 0);
    const perDay  = mockStructureSG.basicSalary / mockStructureSG.baseDivisor;
    expect(withED.extraDutyAmt).toBeCloseTo(perDay * 2, 0);
    expect(withED.totalPayable).toBeGreaterThan(without.totalPayable);
  });

  test('Net pay = total payable - deductions', () => {
    const result = calculateRow(mockStructureSG, 20, 1);
    expect(result.netPay).toBeCloseTo(result.totalPayable - result.totalDeductions, 1);
  });

  test('Zero days returns zeros for variable components', () => {
    const result = calculateRow(mockStructureSG, 0, 0);
    expect(result.payableBasic).toBe(0);
    expect(result.hra).toBe(0);
    expect(result.netPay).toBe(0);
  });
});
