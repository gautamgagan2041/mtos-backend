// src/modules/payroll/engines/pfEngine.js
// ─────────────────────────────────────────────────────────────────
// PF Engine — Statutory PF calculation per Indian law
//
// CHALLAN BREAKDOWN (what you deposit):
//   EE contribution : 12% of PF wage → goes to employee EPF account
//   ER EPF          : 3.67% of PF wage → goes to employee EPF account
//   ER EPS          : 8.33% of PF wage → goes to pension scheme
//   Total challan   : 24% (EE 12% + ER 12%)
//
// EMPLOYER COST (what it costs the company):
//   ER contribution : 12% (EPF 3.67% + EPS 8.33%)
//   EDLI            : 0.50% (insurance)
//   Admin charge    : 0.50% (EPF admin)
//   Total ER cost   : 13%
//
// UI must show EE 12% in salary slip deductions
// UI must show ER 13% in cost/profitability reports
// Challan must show EE + ER EPF + ER EPS separately
// ─────────────────────────────────────────────────────────────────

'use strict';

const PF_WAGE_CAP     = 15000; // statutory ceiling for PF calculation
const PF_EE_RATE      = 0.12;  // employee contribution
const PF_ER_EPF_RATE  = 0.0367;// employer EPF share
const PF_ER_EPS_RATE  = 0.0833;// employer EPS (pension) share
const PF_EDLI_RATE    = 0.005; // employer EDLI (insurance)
const PF_ADMIN_RATE   = 0.005; // employer admin charge

const r2 = (n) => Math.round((n || 0) * 100) / 100;

/**
 * Calculate PF wage based on pfRule
 * @param {number} basic    - Basic salary (monthly, prorated)
 * @param {number} vda      - VDA (monthly, prorated) — used in BASIC_VDA rule
 * @param {number} gross    - Total gross — used in ACTUAL rule
 * @param {string} pfRule   - CAPPED | BASIC_ONLY | BASIC_VDA | ACTUAL
 * @param {number} pfCap    - Override cap (default 15000)
 * @returns {number}        - PF wage to use for contribution calculation
 */
function calculatePFWage(basic, vda = 0, gross = 0, pfRule = 'CAPPED', pfCap = PF_WAGE_CAP) {
  let pfWage;

  switch (pfRule) {
    case 'ACTUAL':
      // Full gross — no cap
      pfWage = gross;
      break;

    case 'BASIC_ONLY':
      // Basic only, capped
      pfWage = Math.min(basic, pfCap);
      break;

    case 'BASIC_VDA':
      // Basic + VDA, capped
      pfWage = Math.min(basic + vda, pfCap);
      break;

    case 'CAPPED':
    default:
      // Basic + VDA capped at 15000 (standard industry practice)
      pfWage = Math.min(basic + vda, pfCap);
      break;
  }

  return r2(Math.max(0, pfWage));
}

/**
 * Full PF calculation — returns complete breakdown
 *
 * @param {number} basic    - Prorated basic salary
 * @param {number} vda      - Prorated VDA
 * @param {number} gross    - Total gross earnings
 * @param {string} pfRule   - PF calculation rule
 * @param {number} pfCap    - PF wage ceiling
 * @returns {Object}        - Complete PF breakdown
 */
function calculatePF(basic, vda = 0, gross = 0, pfRule = 'CAPPED', pfCap = PF_WAGE_CAP) {
  const pfWage = calculatePFWage(basic, vda, gross, pfRule, pfCap);

  // Employee contribution — deducted from salary
  const pfEE = r2(pfWage * PF_EE_RATE);

  // Employer EPF share — deposited to employee EPF account
  const erEPF = r2(pfWage * PF_ER_EPF_RATE);

  // Employer EPS share — deposited to pension scheme
  const erEPS = r2(pfWage * PF_ER_EPS_RATE);

  // Total employer contribution to challan (EPF + EPS = 12%)
  const pfER = r2(erEPF + erEPS);

  // EDLI — employer insurance contribution (not in challan EE/ER split)
  const edli = r2(pfWage * PF_EDLI_RATE);

  // Admin charge — EPF admin fee
  const adminCharge = r2(pfWage * PF_ADMIN_RATE);

  // What gets deposited in PF challan
  const challanDeposit = r2(pfEE + pfER);

  // Total cost to employer (ER contribution + EDLI + admin)
  const totalEmployerCost = r2(pfER + edli + adminCharge);

  return {
    pfWage,           // wage used for PF calculation
    pfEE,             // employee deduction (show in salary slip)
    pfER,             // employer challan contribution (12%)
    erEPF,            // breakdown: 3.67% to EPF account
    erEPS,            // breakdown: 8.33% to pension
    edli,             // 0.50% EDLI insurance
    adminCharge,      // 0.50% admin fee
    challanDeposit,   // pfEE + pfER = total to deposit
    totalEmployerCost,// pfER + edli + adminCharge = true employer cost
  };
}

/**
 * Calculate PF for split-role employee
 * PF must be calculated on COMBINED monthly wage, not per-split
 * This prevents double PF deduction when employee works two roles
 *
 * @param {number} combinedBasic  - Sum of basic from both splits
 * @param {number} combinedVDA    - Sum of VDA from both splits
 * @param {number} combinedGross  - Sum of gross from both splits
 * @param {string} pfRule
 * @param {number} pfCap
 * @returns {Object}
 */
function calculatePFForSplitEmployee(
  combinedBasic,
  combinedVDA   = 0,
  combinedGross = 0,
  pfRule        = 'CAPPED',
  pfCap         = PF_WAGE_CAP
) {
  // Same calculation — just uses combined amounts
  // Caller is responsible for passing combined values
  return calculatePF(combinedBasic, combinedVDA, combinedGross, pfRule, pfCap);
}

module.exports = {
  calculatePF,
  calculatePFWage,
  calculatePFForSplitEmployee,
  PF_WAGE_CAP,
  PF_EE_RATE,
  PF_ER_EPF_RATE,
  PF_ER_EPS_RATE,
};