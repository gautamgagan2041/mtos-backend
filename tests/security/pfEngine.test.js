'use strict';

const { calculatePF, calculateHistoricalOverbilling, PF_RATES, r2 } = require('../../src/engines/pfEngine');

// ─── CRIT-06: Admin charge correctness ───────────────────────────────────────

describe('CRIT-06 — PF admin charge (no Math.max floor)', () => {
  test('pfWage=5000: adminCharge must be 0.5% = ₹25, NOT ₹500 (the bug)', () => {
    const result = calculatePF(5000);
    expect(result.adminCharge).toBe(25.00);
    expect(result.adminCharge).not.toBe(500);
  });

  test('pfWage=8000: adminCharge must be ₹40, NOT ₹500', () => {
    const result = calculatePF(8000);
    expect(result.adminCharge).toBe(40.00);
  });

  test('pfWage=10000: adminCharge must be ₹50, NOT ₹500 (boundary)', () => {
    const result = calculatePF(10000);
    expect(result.adminCharge).toBe(50.00);
  });

  test('pfWage=15000 (ceiling): adminCharge must be ₹75 (no change — bug never hit here)', () => {
    const result = calculatePF(15000);
    expect(result.adminCharge).toBe(75.00);
  });

  test('pfWage=20000: wage ceiling applied → pfWage=15000 → adminCharge=₹75', () => {
    const result = calculatePF(20000);
    expect(result.pfWage).toBe(15000);
    expect(result.adminCharge).toBe(75.00);
  });

  test('adminCharge is strictly PF_RATES.ADMIN_RATE * pfWage for all wage bands', () => {
    const wagesToTest = [1000, 3000, 5000, 8000, 9999, 10000, 12000, 15000, 25000];
    for (const wage of wagesToTest) {
      const result    = calculatePF(wage);
      const cappedWage = Math.min(wage, PF_RATES.WAGE_CEILING);
      const expected  = r2(cappedWage * PF_RATES.ADMIN_RATE);
      expect(result.adminCharge).toBe(expected);
    }
  });
});

// ─── Employee contribution correctness ────────────────────────────────────────

describe('Employee PF contributions', () => {
  test('employeeEPF = 12% of pfWage', () => {
    const result = calculatePF(10000);
    expect(result.employeeEPF).toBe(1200);
  });

  test('voluntary PF adds to total deduction', () => {
    const result = calculatePF(10000, { voluntaryRate: 0.04 }); // 4% VPF
    expect(result.voluntaryPF).toBe(400);
    expect(result.totalEmployeeDeduction).toBe(1600);
  });

  test('no VPF when voluntaryRate is 0', () => {
    const result = calculatePF(10000, { voluntaryRate: 0 });
    expect(result.voluntaryPF).toBe(0);
    expect(result.totalEmployeeDeduction).toBe(result.employeeEPF);
  });
});

// ─── Exempt employees ─────────────────────────────────────────────────────────

describe('Exempt employees', () => {
  test('returns all-zero calculation for isExempted=true', () => {
    const result = calculatePF(50000, { isExempted: true });
    expect(result.employeeEPF).toBe(0);
    expect(result.adminCharge).toBe(0);
    expect(result.totalPFCost).toBe(0);
  });
});

// ─── Employer contributions ───────────────────────────────────────────────────

describe('Employer contributions', () => {
  test('employer EPS = 8.33% of pfWage', () => {
    const result = calculatePF(15000);
    expect(result.employerEPS).toBe(r2(15000 * 0.0833));
  });

  test('employer EPF = 3.67% of pfWage', () => {
    const result = calculatePF(15000);
    expect(result.employerEPF).toBe(r2(15000 * 0.0367));
  });

  test('totalPFCost = employer contributions + overhead', () => {
    const result = calculatePF(10000);
    const expectedCost = r2(
      result.totalEmployerContribution + result.totalEmployerOverhead
    );
    expect(result.totalPFCost).toBe(expectedCost);
  });
});

// ─── Historical overbilling calculator ────────────────────────────────────────

describe('calculateHistoricalOverbilling()', () => {
  test('pfWage=5000: overbilling = ₹475 (₹500 - ₹25)', () => {
    const result = calculateHistoricalOverbilling(5000);
    expect(result.wrongAmount).toBe(500);
    expect(result.correctAmount).toBe(25);
    expect(result.overbilling).toBe(475);
  });

  test('pfWage=10000: overbilling = ₹450 (₹500 - ₹50)', () => {
    const result = calculateHistoricalOverbilling(10000);
    expect(result.overbilling).toBe(450);
  });

  test('pfWage=15000: wrongAmount=₹500 (floor hit), correctAmount=₹75, overbilling=₹425', () => {
    const result = calculateHistoricalOverbilling(15000);
    // At pfWage=15000: 0.5% = ₹75, but Math.max(500,75) = ₹500 (floor hit)
    expect(result.wrongAmount).toBe(500);
    expect(result.correctAmount).toBe(75);
    expect(result.overbilling).toBe(425);
  });

  test('pfWage=20000: ceiling applied before both calculations', () => {
    const result = calculateHistoricalOverbilling(20000);
    // Ceiling at 15000 → 0.5% = ₹75, Math.max(500,75) = ₹500 was wrong
    // Wait — 500 > 75 so the old code would have charged ₹500 for pfWage=20000
    // Actually the ceiling reduces 20000 to 15000, then 0.5%×15000=75 < 500
    expect(result.wrongAmount).toBe(500);
    expect(result.correctAmount).toBe(75);
    expect(result.overbilling).toBe(425);
  });
});
