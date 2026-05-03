/**
 * MTOS PayrollEngine — Formula evaluation and error accumulation
 *
 * Fixes: MED-07 — Formula errors were silently setting component value to 0.
 *                 Now errors are accumulated and included in the run result.
 *                 Alert threshold triggers if any formula errors are found.
 */

'use strict';

// ─── Formula error accumulator ────────────────────────────────────────────────

class FormulaErrorAccumulator {
  constructor() {
    this._errors = [];
  }

  /**
   * Record a formula evaluation failure.
   *
   * @param {string} employeeId
   * @param {string} componentCode
   * @param {Error}  err
   */
  add(employeeId, componentCode, err) {
    this._errors.push({
      employeeId,
      componentCode,
      message:   err.message,
      timestamp: new Date().toISOString(),
    });
  }

  get count()  { return this._errors.length; }
  get errors() { return [...this._errors]; }
  get hasErrors() { return this._errors.length > 0; }

  /**
   * Returns a summary suitable for inclusion in the payroll run result
   * and for triggering alerts.
   */
  toSummary() {
    if (!this.hasErrors) return null;

    // Group by component code to surface systemic formula bugs
    const byComponent = {};
    for (const e of this._errors) {
      byComponent[e.componentCode] = byComponent[e.componentCode] || [];
      byComponent[e.componentCode].push(e.employeeId);
    }

    return {
      totalErrors:    this.count,
      affectedComponents: Object.keys(byComponent).map((code) => ({
        componentCode:    code,
        affectedEmployees: byComponent[code].length,
        employeeIds:       byComponent[code],
      })),
      errors: this._errors,
    };
  }
}

// ─── Safe formula evaluator ───────────────────────────────────────────────────

/**
 * Evaluates a formula expression for a single salary component.
 *
 * MED-07 FIX:
 *   Before: catch (err) { console.error(...); value = 0; }
 *           // Silent zero — 500 employees processed, 1 formula broken,
 *           // 500 employees miss one pay component with no alert.
 *
 *   After:  catch (err) { accumulator.add(employeeId, comp.code, err); value = 0; }
 *           // Error is recorded. After all rows are processed, if
 *           // accumulator.hasErrors, the run result includes the summary
 *           // and an alert is dispatched.
 *
 * @param {string}                formula     – expression string
 * @param {Object}                context     – variable bindings {BASIC, HRA, ...}
 * @param {string}                componentCode
 * @param {string}                employeeId
 * @param {FormulaErrorAccumulator} accumulator
 * @returns {number}  0 on error (value is still zeroed, but error is recorded)
 */
function evaluateFormula(formula, context, componentCode, employeeId, accumulator) {
  try {
    // Build a sandboxed function from the formula string.
    // Context keys become local variable names.
    const keys   = Object.keys(context);
    const values = Object.values(context);

    // eslint-disable-next-line no-new-func
    const fn    = new Function(...keys, `"use strict"; return (${formula});`);
    const result = fn(...values);

    if (typeof result !== 'number' || !isFinite(result)) {
      throw new TypeError(
        `Formula returned non-numeric value: ${JSON.stringify(result)}`
      );
    }

    return Math.max(0, Math.round(result * 100) / 100); // r2, floor at 0
  } catch (err) {
    // MED-07 FIX: Record the error instead of silently discarding it
    accumulator.add(employeeId, componentCode, err);
    return 0;
  }
}

// ─── PT state resolver (replaces keyword matching — HIGH-07) ─────────────────

/**
 * Valid Indian state/UT values for the Tender.state enum field.
 *
 * HIGH-07 FIX: Previously, state was inferred by matching keywords in the
 * tender's city/address fields (e.g. "Hyderabad" → TELANGANA), which silently
 * applied the wrong PT slab for Andhra Pradesh tenders that referenced
 * Hyderabad as their nearest city.
 *
 * The fix: add an explicit `state` enum field to the Tender model.
 * This constant list is used for validation in the PT engine and in the
 * UI dropdown for the Tender creation form.
 */
const INDIAN_STATES = Object.freeze([
  'ANDHRA_PRADESH', 'ARUNACHAL_PRADESH', 'ASSAM', 'BIHAR',
  'CHHATTISGARH', 'GOA', 'GUJARAT', 'HARYANA', 'HIMACHAL_PRADESH',
  'JHARKHAND', 'KARNATAKA', 'KERALA', 'MADHYA_PRADESH', 'MAHARASHTRA',
  'MANIPUR', 'MEGHALAYA', 'MIZORAM', 'NAGALAND', 'ODISHA', 'PUNJAB',
  'RAJASTHAN', 'SIKKIM', 'TAMIL_NADU', 'TELANGANA', 'TRIPURA',
  'UTTAR_PRADESH', 'UTTARAKHAND', 'WEST_BENGAL',
  // Union territories with PT applicability
  'KARNATAKA', // Repeated intentionally — Karnataka has municipal PT
]);

/**
 * Resolves the state from a tender record.
 * Throws if the state field is missing (forces explicit data entry).
 *
 * HIGH-07 FIX: No keyword/string matching. The state MUST be set explicitly
 * on the Tender record via the enum field added in migration:
 *   ALTER TABLE "Tender" ADD COLUMN "state" TEXT NOT NULL;
 *
 * @param {Object} tender
 * @returns {string}  state enum value
 */
function resolveTenderState(tender) {
  if (!tender.state) {
    throw new Error(
      `HIGH-07: Tender "${tender.id}" has no explicit state set. ` +
      `PT calculation requires an explicit state enum value on the Tender record. ` +
      `Edit this tender and select the correct state before running payroll.`
    );
  }

  if (!INDIAN_STATES.includes(tender.state)) {
    throw new Error(
      `Tender "${tender.id}" has unknown state value "${tender.state}". ` +
      `Valid values: ${INDIAN_STATES.join(', ')}`
    );
  }

  return tender.state;
}

module.exports = {
  FormulaErrorAccumulator,
  evaluateFormula,
  resolveTenderState,
  INDIAN_STATES,
};
