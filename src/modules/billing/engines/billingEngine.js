// src/modules/billing/engines/billingEngine.js
// ─────────────────────────────────────────────────────────────────
// Billing Engine — Pure calculation, zero side effects
// Input:  manpowerRequirements[], billingConfig, workingDays, year
// Output: invoice-ready data with line items and GST breakdown
//
// GOLDEN RULE: Billing is calculated from REQUIRED POSTS × RATE
// This engine NEVER receives or uses payroll/employee data
// ─────────────────────────────────────────────────────────────────

'use strict';

// Round to 2 decimal places — all financial calculations use this
const r2 = (n) => Math.round((n || 0) * 100) / 100;

/**
 * Get number of days in a given month/year
 */
function getDaysInMonth(month, year) {
  return new Date(year, month, 0).getDate(); // month is 1-12
}

/**
 * Get financial year string from month and year
 * e.g. month=3, year=2026 → "2025-26"
 *      month=4, year=2025 → "2025-26"
 */
function getFinancialYear(month, year) {
  // FY starts April (month 4)
  const fyStart = month >= 4 ? year : year - 1;
  const fyEnd   = String(fyStart + 1).slice(-2); // last 2 digits
  return `${fyStart}-${fyEnd}`;
}

/**
 * Get period start and end dates for a billing month
 */
function getBillingPeriod(month, year) {
  // Use UTC explicitly to prevent IST offset shifting the date back one day
  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  const periodEnd   = new Date(Date.UTC(year, month, 0));
  return { periodStart, periodEnd };
}

/**
 * Calculate billing amount for a single category
 *
 * Formula: requiredPosts × monthlyRate
 * (We bill for full month based on required posts, not working days)
 * This matches real manpower billing — client pays for posts, not attendance
 */
function calculateCategoryAmount(requirement) {
  const { requiredPosts, monthlyRate } = requirement;

  if (requiredPosts <= 0) {
    throw new Error(
      `[BillingEngine] requiredPosts must be > 0 for category: ${requirement.categoryCode}`
    );
  }
  if (monthlyRate <= 0) {
    throw new Error(
      `[BillingEngine] monthlyRate must be > 0 for category: ${requirement.categoryCode}`
    );
  }

  return r2(requiredPosts * monthlyRate);
}

/**
 * Apply GST logic based on gstMode
 *
 * EXCLUDED:       GST added on top of taxableValue
 * INCLUDED:       GST already in rate — back-calculate to show breakdown
 * REVERSE_CHARGE: GST shown but paid by recipient — grandTotal = taxableValue
 * NONE:           No GST — grandTotal = taxableValue
 */
function applyGST(taxableValue, config) {
  const {
    gstMode      = 'REVERSE_CHARGE',
    cgstRate     = 0.09,
    sgstRate     = 0.09,
    igstRate     = 0,
  } = config;

  let cgst = 0, sgst = 0, igst = 0, grandTotal = 0;

  switch (gstMode) {
    case 'EXCLUDED':
      // GST added on top — client pays taxableValue + GST
      cgst       = r2(taxableValue * cgstRate);
      sgst       = r2(taxableValue * sgstRate);
      igst       = r2(taxableValue * igstRate);
      grandTotal = r2(taxableValue + cgst + sgst + igst);
      break;

    case 'INCLUDED': {
      // GST baked into the rate — extract it for display
      const totalGSTRate = cgstRate + sgstRate + igstRate;
      const baseValue    = r2(taxableValue / (1 + totalGSTRate));
      cgst       = r2(baseValue * cgstRate);
      sgst       = r2(baseValue * sgstRate);
      igst       = r2(baseValue * igstRate);
      grandTotal = taxableValue; // no addition — GST already inside
      break;
    }

    case 'REVERSE_CHARGE':
      // GST shown on invoice — client pays it separately to govt
      // Our receivable = taxableValue only
      cgst       = r2(taxableValue * cgstRate);
      sgst       = r2(taxableValue * sgstRate);
      igst       = r2(taxableValue * igstRate);
      grandTotal = taxableValue; // we receive only taxableValue
      break;

    case 'NONE':
    default:
      grandTotal = taxableValue;
      break;
  }

  return { cgst, sgst, igst, grandTotal };
}

/**
 * Main billing calculation function
 *
 * @param {Array}  requirements - ManpowerRequirement[] from DB
 * @param {Object} config       - BillingConfig from DB
 * @param {number} month        - 1-12
 * @param {number} year         - e.g. 2025
 * @returns {Object}            - Complete invoice calculation
 */
function calculateBilling(requirements, config, month, year) {
  // ── Input Validation ─────────────────────────────────────────
  if (!requirements || requirements.length === 0) {
    throw new Error(
      '[BillingEngine] No manpower requirements found. ' +
      'Cannot generate invoice without required posts. ' +
      'Add ManpowerRequirements for this tender before billing.'
    );
  }
  if (!config) {
    throw new Error(
      '[BillingEngine] No billing config found for this tender. ' +
      'Set up BillingConfig (GST mode, service charge) before billing.'
    );
  }
  if (!month || month < 1 || month > 12) {
    throw new Error(`[BillingEngine] Invalid month: ${month}. Must be 1-12.`);
  }
  if (!year || year < 2020 || year > 2100) {
    throw new Error(`[BillingEngine] Invalid year: ${year}.`);
  }

  const {
    serviceChargeRate    = 0.10,
    includeServiceCharge = true,
    sacCode              = '998525',
  } = config;

  const workingDays  = getDaysInMonth(month, year);
  const standardDays = workingDays; // for this business, billing is monthly full
  const { periodStart, periodEnd } = getBillingPeriod(month, year);
  const fy = getFinancialYear(month, year);

  // ── Step 1: Calculate each category line item ────────────────
  const lineItems = requirements.map((req) => {
    const amount = calculateCategoryAmount(req);

    return {
      categoryCode:  req.categoryCode,
      categoryName:  req.categoryName,
      requiredPosts: req.requiredPosts,
      monthlyRate:   req.monthlyRate,
      workingDays,
      standardDays,
      amount,
      sacCode:       req.sacCode || sacCode,
    };
  });

  // ── Step 2: Subtotal — sum of all category amounts ───────────
  const subtotal = r2(lineItems.reduce((sum, item) => sum + item.amount, 0));

  if (subtotal <= 0) {
    throw new Error(
      `[BillingEngine] Calculated subtotal is ${subtotal}. ` +
      'Check that monthlyRate and requiredPosts are set correctly.'
    );
  }

  // ── Step 3: Service charge on subtotal ───────────────────────
  const serviceCharge = includeServiceCharge
    ? r2(subtotal * serviceChargeRate)
    : 0;

  const taxableValue = r2(subtotal + serviceCharge);

  // ── Step 4: Apply GST logic ───────────────────────────────────
  const { cgst, sgst, igst, grandTotal } = applyGST(taxableValue, config);

  // ── Return complete invoice data ─────────────────────────────
  return {
    // Period
    month,
    year,
    fy,
    periodStart,
    periodEnd,
    workingDays,

    // Line items — one per category
    lineItems,

    // Totals
    subtotal,
    serviceCharge,
    serviceChargeRate: includeServiceCharge ? serviceChargeRate : 0,
    taxableValue,

    // GST
    cgst,
    sgst,
    igst,
    grandTotal,
    gstMode: config.gstMode,

    // Meta
    categoryCount: lineItems.length,
    totalPosts:    lineItems.reduce((sum, i) => sum + i.requiredPosts, 0),
  };
}

module.exports = {
  calculateBilling,
  getFinancialYear,
  getBillingPeriod,
  getDaysInMonth,
};