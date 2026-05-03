/**
 * MTOS PF (Provident Fund) Calculation Engine
 *
 * Fixes: CRIT-06 — PF admin charge bug causing systematic overbilling.
 *
 * Root cause: A Math.max(500, ...) guard remained in production after the
 * decision to remove the ₹500 minimum was made. The comment said the minimum
 * was removed; the code disagreed. For employees with pfWage < ₹10,000 this
 * produced a 20x overbilling scenario (₹500 instead of ₹25 for pfWage=₹5,000).
 * This is also a statutory compliance violation under EPF regulations.
 *
 * Design contract:
 *  - All monetary values are handled as Numbers and rounded with r2() before
 *    storage to prevent floating-point drift accumulating across rows.
 *  - The PF wage ceiling (₹15,000) is applied before all contribution calcs.
 *  - Admin charge has NO floor — it is strictly PF_ADMIN_RATE × pfWage.
 */

'use strict';

// ─── Statutory rates (EPF & MP Act 1952) ─────────────────────────────────────

const PF_RATES = Object.freeze({
  // Employee contribution: 12% of PF wage
  EMPLOYEE_CONTRIBUTION_RATE: 0.12,

  // Employer contribution splits:
  //   8.33% goes to EPS (Employees' Pension Scheme), capped at ₹15,000 PF wage
  //   3.67% goes to EPF (remaining from the 12% employer share)
  EMPLOYER_EPF_RATE:   0.0367,
  EMPLOYER_EPS_RATE:   0.0833,

  // Admin charge: 0.50% of PF wage (no floor — CRIT-06 fix)
  ADMIN_RATE:          0.0050,

  // EDLI (Employees' Deposit Linked Insurance): 0.50% of PF wage
  EDLI_RATE:           0.0050,

  // EDLI admin charge: 0.01% of PF wage
  EDLI_ADMIN_RATE:     0.0001,

  // Statutory PF wage ceiling
  WAGE_CEILING:        15000,
});

// ─── Rounding helper ──────────────────────────────────────────────────────────

/** Round to 2 decimal places (standard accounting rounding). */
const r2 = (n) => Math.round(n * 100) / 100;

// ─── Main calculation ─────────────────────────────────────────────────────────

/**
 * Calculates all PF-related deductions and contributions for an employee.
 *
 * @param {number} grossWage            – employee's gross wage for the period
 * @param {Object} [opts]
 * @param {boolean} opts.isExempted     – true if employee is PF-exempt
 * @param {number}  opts.voluntaryRate  – optional VPF rate (e.g. 0.04 for 4%)
 *
 * @returns {PFCalculation}
 */
function calculatePF(grossWage, opts = {}) {
  const { isExempted = false, voluntaryRate = 0 } = opts;

  if (isExempted) {
    return zeroPFCalculation();
  }

  // Apply statutory wage ceiling
  const pfWage = Math.min(grossWage, PF_RATES.WAGE_CEILING);

  // ── Employee deductions ───────────────────────────────────────────────────
  const employeeEPF  = r2(pfWage * PF_RATES.EMPLOYEE_CONTRIBUTION_RATE);
  const voluntaryPF  = voluntaryRate > 0 ? r2(pfWage * voluntaryRate) : 0;
  const totalEmployeeDeduction = r2(employeeEPF + voluntaryPF);

  // ── Employer contributions ────────────────────────────────────────────────
  const employerEPS  = r2(pfWage * PF_RATES.EMPLOYER_EPS_RATE);
  const employerEPF  = r2(pfWage * PF_RATES.EMPLOYER_EPF_RATE);
  const totalEmployerContribution = r2(employerEPS + employerEPF);

  // ── Employer overhead ─────────────────────────────────────────────────────

  /**
   * CRIT-06 FIX:
   *   Before (WRONG): const adminCharge = r2(Math.max(500, pfWage * PF_ADMIN_RATE));
   *   After  (FIXED): const adminCharge = r2(pfWage * PF_RATES.ADMIN_RATE);
   *
   * The ₹500 floor was statutorily removed but remained in the code.
   * Removing Math.max(500, ...) corrects the calculation for all wage bands.
   *
   * Example impact:
   *   pfWage = ₹5,000  → was ₹500 (Math.max floor), now ₹25.00  (0.5%)
   *   pfWage = ₹10,000 → was ₹500 (Math.max floor), now ₹50.00  (0.5%)
   *   pfWage = ₹15,000 → was ₹75  (no floor hit),   now ₹75.00  (no change)
   */
  const adminCharge = r2(pfWage * PF_RATES.ADMIN_RATE);   // CRIT-06: no Math.max(500, ...)

  const edli      = r2(pfWage * PF_RATES.EDLI_RATE);
  const edliAdmin = r2(pfWage * PF_RATES.EDLI_ADMIN_RATE);

  const totalEmployerOverhead = r2(adminCharge + edli + edliAdmin);

  return {
    pfWage,
    employeeEPF,
    voluntaryPF,
    totalEmployeeDeduction,
    employerEPS,
    employerEPF,
    totalEmployerContribution,
    adminCharge,
    edli,
    edliAdmin,
    totalEmployerOverhead,
    totalPFCost: r2(totalEmployerContribution + totalEmployerOverhead),
  };
}

/**
 * Returns a zero-value PF calculation for exempt employees.
 * @returns {PFCalculation}
 */
function zeroPFCalculation() {
  return {
    pfWage:                    0,
    employeeEPF:               0,
    voluntaryPF:               0,
    totalEmployeeDeduction:    0,
    employerEPS:               0,
    employerEPF:               0,
    totalEmployerContribution: 0,
    adminCharge:               0,
    edli:                      0,
    edliAdmin:                 0,
    totalEmployerOverhead:     0,
    totalPFCost:               0,
  };
}

/**
 * Calculates the corrected admin charge for historical audit/refund purposes.
 *
 * Use this to determine how much was overbilled for a past period so the
 * finance team can issue refund credit notes to affected clients.
 *
 * @param {number} pfWage       – employee PF wage for the period
 * @returns {{ wrongAmount: number, correctAmount: number, overbilling: number }}
 */
function calculateHistoricalOverbilling(pfWage) {
  const cappedWage  = Math.min(pfWage, PF_RATES.WAGE_CEILING);
  const wrongAmount = r2(Math.max(500, cappedWage * PF_RATES.ADMIN_RATE));
  const correctAmount = r2(cappedWage * PF_RATES.ADMIN_RATE);
  return {
    wrongAmount,
    correctAmount,
    overbilling: r2(wrongAmount - correctAmount),
  };
}

module.exports = {
  calculatePF,
  calculateHistoricalOverbilling,
  zeroPFCalculation,
  PF_RATES,
  r2,
};
