'use strict';

// ─────────────────────────────────────────────────────────────
// PF Engine — Production Grade (Compliance Safe)
// ─────────────────────────────────────────────────────────────

const PF_WAGE_CAP     = 15000;
const EPS_WAGE_CAP    = 15000;

const PF_EE_RATE      = 0.12;
const PF_ER_EPF_RATE  = 0.0367;
const PF_ER_EPS_RATE  = 0.0833;

const PF_EDLI_RATE    = 0.005;
const PF_ADMIN_RATE   = 0.005;

const EPS_MAX_AMOUNT  = 1250;

const r2 = (n) => Math.round((n || 0) * 100) / 100;

function calculatePFWage(basic, vda = 0, gross = 0, pfRule = 'CAPPED', pfCap = PF_WAGE_CAP) {
  let wage = 0;

  switch (pfRule) {
    case 'ACTUAL':
      return r2(Math.max(0, gross));  // No cap for ACTUAL rule

    case 'BASIC_ONLY':
      wage = basic;
      break;

    case 'BASIC_VDA':
      wage = basic + vda;
      break;

    case 'CAPPED':
    default:
      wage = basic + vda;
      break;
  }

  return r2(Math.min(Math.max(0, wage), pfCap));
}

function calculatePF(
  basic,
  vda = 0,
  gross = 0,
  pfRule = 'CAPPED',
  pfCap = PF_WAGE_CAP,
  options = {}
) {
  const { isPFApplicable = true } = options;

  if (!isPFApplicable) {
    return zeroPFResult();
  }

  const pfWage = calculatePFWage(basic, vda, gross, pfRule, pfCap);

  // Employee contribution
  const pfEE = r2(pfWage * PF_EE_RATE);

  // EPS (capped at ₹1250)
  const epsWage = Math.min(pfWage, EPS_WAGE_CAP);
  const erEPS   = r2(Math.min(epsWage * PF_ER_EPS_RATE, EPS_MAX_AMOUNT));

  // EPF (remaining from 12%)
  const erEPF = r2(pfWage * PF_ER_EPF_RATE);

  const pfER = r2(erEPF + erEPS);

  const edli        = r2(pfWage * PF_EDLI_RATE);
  const adminCharge = r2(Math.max(500, pfWage * PF_ADMIN_RATE)); // no ₹500 here

  const challanDeposit = r2(pfEE + pfER);

  const totalEmployerCost = r2(pfER + edli + adminCharge);

  return {
    pfWage,
    pfEE,
    pfER,
    erEPF,
    erEPS,
    edli,
    adminCharge,
    challanDeposit,
    totalEmployerCost,
  };
}

function zeroPFResult() {
  return {
    pfWage: 0,
    pfEE: 0,
    pfER: 0,
    erEPF: 0,
    erEPS: 0,
    edli: 0,
    adminCharge: 0,
    challanDeposit: 0,
    totalEmployerCost: 0,
  };
}

function calculatePFForSplitEmployee(
  combinedBasic,
  combinedVDA = 0,
  combinedGross = 0,
  pfRule = 'CAPPED',
  pfCap = PF_WAGE_CAP,
  options = {}
) {
  return calculatePF(
    combinedBasic,
    combinedVDA,
    combinedGross,
    pfRule,
    pfCap,
    options
  );
}

module.exports = {
  calculatePF,
  calculatePFWage,
  calculatePFForSplitEmployee,
};

