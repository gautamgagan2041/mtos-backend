 'use strict';

// ─────────────────────────────────────────────────────────────
// Billing Engine — Core Calculation
// ─────────────────────────────────────────────────────────────

const r2 = (n) => Math.round((n || 0) * 100) / 100;

const GST_MODE = {
  NORMAL: 'NORMAL',
  IGST: 'IGST',
  REVERSE: 'REVERSE_CHARGE',
  EXEMPT: 'EXEMPT',
};

function generateBilling({ costSummary, config }) {

  const {
    totalCostToClient
  } = costSummary;

  const serviceChargeRate = config.serviceChargeRate ?? 0.10;
  const gstRate = config.gstRate ?? 0.18;
  const gstMode = config.gstMode ?? GST_MODE.NORMAL;

  // ── Service Charge ─────────────────────────────
  const serviceCharge = r2(totalCostToClient * serviceChargeRate);

  const taxableValue = r2(totalCostToClient + serviceCharge);

  // ── GST Calculation ───────────────────────────
  let cgst = 0, sgst = 0, igst = 0;

  switch (gstMode) {
    case GST_MODE.NORMAL:
      cgst = r2(taxableValue * (gstRate / 2));
      sgst = r2(taxableValue * (gstRate / 2));
      break;

    case GST_MODE.IGST:
      igst = r2(taxableValue * gstRate);
      break;

    case GST_MODE.REVERSE:
      // No GST charged, but note required
      break;

    case GST_MODE.EXEMPT:
      break;
  }

  const totalGST = r2(cgst + sgst + igst);
  const grandTotal = r2(taxableValue + totalGST);

  return {
    baseCost: totalCostToClient,
    serviceCharge,
    taxableValue,
    gst: { cgst, sgst, igst, totalGST },
    grandTotal,
    gstMode,
  };
}


function getFinancialYear(month, year) {
  const m = parseInt(month);
  const y = parseInt(year);
  if (m >= 4) return y + '-' + (y + 1).toString().slice(-2);
  return (y - 1) + '-' + y.toString().slice(-2);
}

module.exports = { generateBilling, getFinancialYear };

