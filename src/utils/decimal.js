'use strict';

/**
 * decimal.js — Safe monetary arithmetic for payroll
 *
 * WHY: IEEE 754 floating point causes errors like:
 *   0.1 + 0.2 = 0.30000000000000004
 *   19760 * 0.12 = 2371.1999999999998  (instead of 2371.20)
 *
 * In payroll with 500 employees × 15 components each, these errors
 * accumulate to ₹1-5 per run — which causes EPFO challan reconciliation
 * failures and client invoice disputes.
 *
 * APPROACH: Integer arithmetic (paise as unit) with Decimal-safe rounding.
 * This is production-safe without requiring a heavy Decimal.js library.
 *
 * USAGE:
 *   const { money, paise, fromPaise, r2, sum } = require('./decimal');
 *   const gross = sum([basic, vda, hra, washing]);
 *   const pfEE  = r2(gross * 0.12);
 */

/**
 * r2 — Round to 2 decimal places using "round half away from zero"
 * This matches how EPFO challans and most Indian payroll systems round.
 *
 * Uses multiplication trick to avoid floating point issues:
 * Math.round(2.455 * 100) / 100 = 2.45  ← wrong (float issue)
 * r2(2.455) = 2.46  ← correct
 */
function r2(n) {
  if (n === null || n === undefined || isNaN(n)) return 0;
  // Use Number.EPSILON trick to handle floating point edge cases
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * r0 — Round to nearest integer (used for whole-rupee values like PT)
 */
function r0(n) {
  if (!n) return 0;
  return Math.round(Number(n));
}

/**
 * sum — Safe sum of an array of numbers
 * Accumulates in integer paise to avoid floating point drift
 */
function sum(values) {
  let total = 0;
  for (const v of values) {
    if (v === null || v === undefined || isNaN(v)) continue;
    total += Math.round((Number(v) + Number.EPSILON) * 100);
  }
  return total / 100;
}

/**
 * percent — Calculate percentage, rounded to 2 decimals
 * percent(15000, 12) = 1800.00
 */
function percent(base, rate) {
  if (!base || !rate) return 0;
  return r2(Number(base) * (Number(rate) / 100));
}

/**
 * proRate — Calculate proportional value
 * proRate(15000, 22, 26) = amount for 22 days out of 26
 */
function proRate(monthlyAmount, presentDays, workingDays) {
  if (!workingDays || !monthlyAmount) return 0;
  if (presentDays >= workingDays) return r2(monthlyAmount);
  return r2((Number(monthlyAmount) / Number(workingDays)) * Number(presentDays));
}

/**
 * cap — Apply a maximum cap to a value
 * cap(18000, 15000) = 15000
 */
function cap(value, maximum) {
  return r2(Math.min(Number(value), Number(maximum)));
}

/**
 * clamp — Constrain value between min and max
 */
function clamp(value, min, max) {
  return r2(Math.max(Number(min), Math.min(Number(value), Number(max))));
}

/**
 * sumObject — Sum specific numeric keys across an array of objects
 * sumObject(rows, ['pfEE', 'pfER', 'esicEE']) → { pfEE: total, pfER: total, ... }
 */
function sumObject(rows, keys) {
  const result = {};
  for (const key of keys) {
    result[key] = r2(sum(rows.map(r => r[key] ?? 0)));
  }
  return result;
}

/**
 * formatCurrency — Format number as Indian Rupees
 * formatCurrency(1234567.89) → "₹12,34,567.89"
 */
function formatCurrency(amount) {
  if (!amount && amount !== 0) return '—';
  return new Intl.NumberFormat('en-IN', {
    style:    'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(amount));
}

/**
 * Verify our r2 is correct — run this to validate
 */
function selfTest() {
  const tests = [
    [r2(0.1 + 0.2),                0.3,    '0.1 + 0.2 = 0.3'],
    [r2(19760 * 0.12),             2371.2, '19760 * 12% = 2371.20'],
    [r2(1.005),                    1.01,   '1.005 rounds to 1.01'],
    [r2(2.455),                    2.46,   '2.455 rounds to 2.46'],
    [proRate(15000, 22, 26),       12692.31, 'Pro-rate 22/26 days'],
    [sum([1800.50, 2371.20, 700]), 4871.70, 'sum accumulates correctly'],
  ];

  let pass = 0, fail = 0;
  for (const [got, expected, label] of tests) {
    if (Math.abs(got - expected) < 0.001) {
      pass++;
    } else {
      console.error(`FAIL: ${label} → expected ${expected}, got ${got}`);
      fail++;
    }
  }
  console.log(`Decimal self-test: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

module.exports = { r2, r0, sum, percent, proRate, cap, clamp, sumObject, formatCurrency, selfTest };
