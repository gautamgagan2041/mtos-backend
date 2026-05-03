'use strict';

const {
  FormulaErrorAccumulator,
  evaluateFormula,
  resolveTenderState,
  INDIAN_STATES,
} = require('../../src/engines/payrollEngine.helpers');

// ─── MED-07: Formula error accumulator ───────────────────────────────────────

describe('FormulaErrorAccumulator', () => {
  test('starts empty', () => {
    const acc = new FormulaErrorAccumulator();
    expect(acc.count).toBe(0);
    expect(acc.hasErrors).toBe(false);
  });

  test('records formula errors with employee and component context', () => {
    const acc = new FormulaErrorAccumulator();
    acc.add('emp_001', 'HRA', new Error('undefined variable X'));
    acc.add('emp_002', 'HRA', new Error('undefined variable X'));
    acc.add('emp_003', 'TRAVEL', new Error('division by zero'));

    expect(acc.count).toBe(3);
    expect(acc.hasErrors).toBe(true);
  });

  test('toSummary() groups errors by component code', () => {
    const acc = new FormulaErrorAccumulator();
    acc.add('emp_001', 'HRA', new Error('err'));
    acc.add('emp_002', 'HRA', new Error('err'));
    acc.add('emp_003', 'TRAVEL', new Error('err'));

    const summary = acc.toSummary();
    expect(summary.totalErrors).toBe(3);

    const hraEntry = summary.affectedComponents.find(c => c.componentCode === 'HRA');
    expect(hraEntry.affectedEmployees).toBe(2);
    expect(hraEntry.employeeIds).toContain('emp_001');

    const travelEntry = summary.affectedComponents.find(c => c.componentCode === 'TRAVEL');
    expect(travelEntry.affectedEmployees).toBe(1);
  });

  test('toSummary() returns null when no errors', () => {
    const acc = new FormulaErrorAccumulator();
    expect(acc.toSummary()).toBeNull();
  });

  test('errors() returns a copy — not the internal array', () => {
    const acc = new FormulaErrorAccumulator();
    acc.add('e1', 'C1', new Error('x'));
    const copy = acc.errors;
    copy.push({ fake: true });
    expect(acc.count).toBe(1); // internal array unchanged
  });
});

// ─── MED-07: evaluateFormula ──────────────────────────────────────────────────

describe('evaluateFormula()', () => {
  let acc;
  beforeEach(() => { acc = new FormulaErrorAccumulator(); });

  test('evaluates valid formula with context variables', () => {
    const result = evaluateFormula(
      'BASIC * 0.4',
      { BASIC: 10000 },
      'HRA', 'emp_001', acc
    );
    expect(result).toBe(4000);
    expect(acc.hasErrors).toBe(false);
  });

  test('returns 0 and records error for broken formula', () => {
    const result = evaluateFormula(
      'UNDEFINED_VAR * 2',
      { BASIC: 10000 },
      'HRA', 'emp_001', acc
    );
    expect(result).toBe(0);
    expect(acc.hasErrors).toBe(true);     // MED-07 fix: error recorded
    expect(acc.errors[0].componentCode).toBe('HRA');
    expect(acc.errors[0].employeeId).toBe('emp_001');
  });

  test('returns 0 and records error for division by zero (Infinity result)', () => {
    const result = evaluateFormula(
      '1 / 0',
      {},
      'BONUS', 'emp_002', acc
    );
    // Infinity is not a finite number — should be caught and zeroed
    expect(result).toBe(0);
    expect(acc.hasErrors).toBe(true);
  });

  test('floors negative results to 0', () => {
    // A formula that returns negative (e.g. deduction exceeds component)
    const result = evaluateFormula('BASIC - 20000', { BASIC: 5000 }, 'NET', 'e1', acc);
    expect(result).toBe(0);
    expect(acc.hasErrors).toBe(false); // No error — formula is valid, result clipped
  });

  test('rounds result to 2 decimal places', () => {
    const result = evaluateFormula('100 / 3', {}, 'COMP', 'e1', acc);
    expect(result).toBe(33.33);
  });

  test('accumulates errors across multiple calls (does not stop on first)', () => {
    for (let i = 0; i < 5; i++) {
      evaluateFormula('BAD_VAR', {}, `COMP_${i}`, `emp_00${i}`, acc);
    }
    expect(acc.count).toBe(5); // all 5 recorded
  });
});

// ─── HIGH-07: State resolver ──────────────────────────────────────────────────

describe('resolveTenderState() — HIGH-07', () => {
  test('returns state from explicit enum field', () => {
    const tender = { id: 't1', state: 'KARNATAKA' };
    expect(resolveTenderState(tender)).toBe('KARNATAKA');
  });

  test('throws when state field is missing (forces explicit data entry)', () => {
    const tender = { id: 't1', city: 'Hyderabad' }; // no state field
    expect(() => resolveTenderState(tender)).toThrow(/HIGH-07/);
    expect(() => resolveTenderState(tender)).toThrow(/explicit state/);
  });

  test('throws when state field is null', () => {
    const tender = { id: 't1', state: null };
    expect(() => resolveTenderState(tender)).toThrow(/HIGH-07/);
  });

  test('throws for unrecognised state value', () => {
    const tender = { id: 't1', state: 'HYDERABAD' }; // city name, not enum
    expect(() => resolveTenderState(tender)).toThrow(/unknown state value/);
  });

  test('TELANGANA and ANDHRA_PRADESH are distinct enum values', () => {
    expect(INDIAN_STATES).toContain('TELANGANA');
    expect(INDIAN_STATES).toContain('ANDHRA_PRADESH');
    // The original bug: keyword matching confused these two states
    const ap = { id: 't1', state: 'ANDHRA_PRADESH' };
    expect(resolveTenderState(ap)).toBe('ANDHRA_PRADESH'); // must NOT return TELANGANA
  });

  test('all INDIAN_STATES values are accepted', () => {
    for (const state of INDIAN_STATES) {
      expect(() => resolveTenderState({ id: 't1', state })).not.toThrow();
    }
  });
});
