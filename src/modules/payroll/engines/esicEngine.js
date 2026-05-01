// src/modules/payroll/engines/esicEngine.js
// ─────────────────────────────────────────────────────────────────
// ESIC Engine — Statutory ESIC calculation per Indian law
//
// KEY STATUTORY RULES:
// 1. ESIC applies only if gross <= ₹21,000/month
// 2. India has 2 contribution periods:
//      Period 1: Apr 1 – Sep 30
//      Period 2: Oct 1 – Mar 31
// 3. Eligibility is determined at PERIOD START using actual gross
// 4. Once eligible, ESIC continues for ENTIRE period
//    even if salary crosses ₹21,000 mid-period
// 5. Once ineligible, ESIC stops for ENTIRE period
//    even if salary drops below ₹21,000 mid-period
//
// RATES:
//   Employee : 0.75% of gross
//   Employer : 3.25% of gross
// ─────────────────────────────────────────────────────────────────

'use strict';

const prisma = require('../../../config/database');

const ESIC_THRESHOLD  = 21000;
const ESIC_EE_RATE    = 0.0075;
const ESIC_ER_RATE    = 0.0325;

const r2 = (n) => Math.round((n || 0) * 100) / 100;

// ── Period Helpers ────────────────────────────────────────────────

/**
 * Get ESIC contribution period for a given date
 * Returns period start and end as UTC dates
 *
 * @param {Date} date - Any date within the period
 * @returns {{ start: Date, end: Date }}
 */
function getESICPeriod(date) {
  if (!date || isNaN(new Date(date).getTime())) {
    throw new Error(`[ESICEngine] Invalid date provided to getESICPeriod: "${date}"`);
  }

  const d     = new Date(date);
  const month = d.getUTCMonth() + 1; // 1-12
  const year  = d.getUTCFullYear();

  if (month >= 4 && month <= 9) {
    // Period 1: Apr 1 – Sep 30
    return {
      start: new Date(Date.UTC(year, 3, 1)),  // Apr 1
      end:   new Date(Date.UTC(year, 8, 30)), // Sep 30
    };
  } else if (month >= 10) {
    // Period 2 (Oct–Dec): Oct 1 this year – Mar 31 next year
    return {
      start: new Date(Date.UTC(year,     9,  1)), // Oct 1
      end:   new Date(Date.UTC(year + 1, 2, 31)), // Mar 31 next year
    };
  } else {
    // Period 2 (Jan–Mar): Oct 1 last year – Mar 31 this year
    return {
      start: new Date(Date.UTC(year - 1, 9,  1)), // Oct 1 last year
      end:   new Date(Date.UTC(year,     2, 31)), // Mar 31 this year
    };
  }
}

// ── Pure Calculation ──────────────────────────────────────────────

/**
 * Calculate ESIC contribution amounts
 * Call this ONLY after eligibility is confirmed
 *
 * @param {number} grossEarnings - Gross earnings for the month
 * @returns {{ esicEE: number, esicER: number }}
 */
function calculateESIC(grossEarnings) {
  return {
    esicEE: r2(grossEarnings * ESIC_EE_RATE),
    esicER: r2(grossEarnings * ESIC_ER_RATE),
  };
}

// ── Eligibility Resolution (DB-backed) ───────────────────────────

/**
 * Resolve ESIC eligibility for an employee in a given month/year
 *
 * TWO-PASS DESIGN — this function must be called AFTER gross is known:
 *   Pass 1: Calculate gross WITHOUT ESIC (esicEligible = false)
 *   Pass 2: Call this function with actual gross
 *   Pass 3: Recalculate with correct esicEligible flag
 *
 * DB behavior:
 *   - If period record exists → return stored eligibility (never re-evaluate)
 *   - If new period → create record using actual gross for eligibility decision
 *
 * @param {string} tenantId
 * @param {string} employeeId
 * @param {number} actualGross   - Real gross from Pass 1 calculation
 * @param {number} month         - 1-12
 * @param {number} year
 * @returns {boolean}            - true = deduct ESIC this month
 */
async function resolveESICEligibility(tenantId, employeeId, actualGross, month, year) {
  // Input validation
  if (!tenantId || !employeeId) {
    throw new Error('[ESICEngine] tenantId and employeeId are required');
  }
  if (typeof actualGross !== 'number' || isNaN(actualGross)) {
    throw new Error(
      `[ESICEngine] actualGross must be a valid number. ` +
      `Got: "${actualGross}" for employeeId=${employeeId}`
    );
  }

  const monthNum = typeof month === 'string' ? parseInt(month) : month;
  const yearNum  = typeof year  === 'string' ? parseInt(year)  : year;

  if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
    throw new Error(`[ESICEngine] Invalid month: "${month}"`);
  }
  if (isNaN(yearNum) || yearNum < 2020) {
    throw new Error(`[ESICEngine] Invalid year: "${year}"`);
  }

  // Get the period this month falls into
  const payDate = new Date(Date.UTC(yearNum, monthNum - 1, 1));
  const period  = getESICPeriod(payDate);

  // Check if period record already exists
  let record = await prisma.eSICPeriod.findUnique({
    where: {
      tenantId_employeeId_periodStart: {
        tenantId,
        employeeId,
        periodStart: period.start,
      },
    },
  });

  if (record) {
    // Period already established — return stored eligibility
    // Statutory rule: eligibility NEVER changes mid-period
    return record.eligible;
  }

  // New period — determine eligibility from ACTUAL gross
  // This is the only time we evaluate the ₹21,000 threshold
  const eligible = actualGross <= ESIC_THRESHOLD;

  await prisma.eSICPeriod.create({
    data: {
      tenantId,
      employeeId,
      periodStart:  period.start,
      periodEnd:    period.end,
      eligible,
      grossAtStart: actualGross, // store actual gross — not 0
    },
  });

  return eligible;
}

/**
 * Get all ESIC period records for an employee
 * Used for compliance reporting
 */
async function getESICHistory(tenantId, employeeId) {
  return prisma.eSICPeriod.findMany({
    where: { tenantId, employeeId },
    orderBy: { periodStart: 'desc' },
  });
}

/**
 * Mark employee as exited from ESIC period
 * Called when employee exits mid-period
 */
async function markESICExit(tenantId, employeeId, exitDate) {
  const period = getESICPeriod(new Date(exitDate));

  return prisma.eSICPeriod.updateMany({
    where: {
      tenantId,
      employeeId,
      periodStart: period.start,
    },
    data: {
      exitDate: new Date(exitDate),
    },
  });
}

module.exports = {
  getESICPeriod,
  calculateESIC,
  resolveESICEligibility,
  getESICHistory,
  markESICExit,
  ESIC_THRESHOLD,
  ESIC_EE_RATE,
  ESIC_ER_RATE,
};
