'use strict';

// ── Allowed component code pattern ───────────────────────────────
// Component codes are uppercase letters, digits, and underscores only.
// This is enforced both here and should be enforced on component creation.
const SAFE_CODE_RE = /^[A-Z][A-Z0-9_]*$/;

// Allowed function names — whitelist only
const ALLOWED_FUNCTIONS = new Set(['max', 'min', 'abs', 'round']);

/**
 * evaluateFormula(formula, context)
 *
 * Safely evaluates a payroll formula string.
 * - Context keys must be uppercase alphanumeric+underscore (component codes or
 *   well-known names like presentDays, otHours, workingDays, GROSS).
 * - After substitution the expression may only contain digits, operators,
 *   parens, commas, spaces, and the four whitelisted function names.
 * - A custom recursive descent parser executes the expression — no eval().
 *
 * @param {string} formula   - e.g. "max(BASIC * 0.08, 1800)"
 * @param {Object} context   - e.g. { BASIC: 19760, presentDays: 26, ... }
 * @returns {number}
 * @throws  if formula is structurally invalid or contains unsafe tokens
 */
function evaluateFormula(formula, context = {}) {
  if (!formula || typeof formula !== 'string') return 0;

  // ── 1. Validate every context key before substitution ──────────
  for (const key of Object.keys(context)) {
    if (!SAFE_CODE_RE.test(key) && !_isSafeBuiltinName(key)) {
      throw new Error(
        `[FormulaParser] Unsafe context key: "${key}". ` +
        `Keys must be UPPER_SNAKE_CASE component codes or known built-ins.`
      );
    }
  }

  // ── 2. Substitute context values (longest key first → no partial matches)
  let expr = formula;
  const keys = Object.keys(context).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const val = Number(context[key]) || 0;
    // \b word boundary — prevents BASIC matching inside BASIC_VDA etc.
    expr = expr.replace(new RegExp(`\\b${key}\\b`, 'g'), String(val));
  }

  // ── 3. Strip whitelisted function names, then check the remainder ──
  const stripped = expr.replace(/\b(max|min|abs|round)\b/g, '');
  if (!/^[0-9+\-*/().,\s]+$/.test(stripped)) {
    throw new Error(
      `[FormulaParser] Unsafe expression after substitution: "${expr}". ` +
      `Original formula: "${formula}"`
    );
  }

  // ── 4. Parse & evaluate with the recursive descent parser ──────
  const state = { pos: 0, src: expr.replace(/\s+/g, '') };
  const result = _parseExpression(state);

  // Guard: the parser should have consumed everything
  if (state.pos < state.src.length) {
    throw new Error(`[FormulaParser] Unexpected token at position ${state.pos} in "${formula}"`);
  }

  return r2(result);
}

// ── Helpers ───────────────────────────────────────────────────────

const r2 = (n) => Math.round((n || 0) * 100) / 100;

// Known safe lowercase context names (attendance/payroll built-ins)
const SAFE_BUILTINS = new Set([
  'presentDays', 'otHours', 'workingDays', 'nightShifts', 'GROSS',
]);
function _isSafeBuiltinName(key) {
  return SAFE_BUILTINS.has(key);
}

// ── Recursive descent parser ──────────────────────────────────────

function _parseExpression(s) {
  let val = _parseTerm(s);
  while (s.pos < s.src.length && /[+\-]/.test(s.src[s.pos])) {
    const op = s.src[s.pos++];
    const right = _parseTerm(s);
    val = op === '+' ? val + right : val - right;
  }
  return val;
}

function _parseTerm(s) {
  let val = _parseFactor(s);
  while (s.pos < s.src.length && /[*/]/.test(s.src[s.pos])) {
    const op = s.src[s.pos++];
    const right = _parseFactor(s);
    if (op === '/') {
      if (right === 0) throw new Error('[FormulaParser] Division by zero');
      val /= right;
    } else {
      val *= right;
    }
  }
  return val;
}

function _parseFactor(s) {
  if (s.src[s.pos] === '(') {
    s.pos++; // consume '('
    const val = _parseExpression(s);
    if (s.src[s.pos] !== ')') {
      throw new Error(`[FormulaParser] Expected ')' at position ${s.pos}`);
    }
    s.pos++; // consume ')'
    return val;
  }

  if (/[a-z]/i.test(s.src[s.pos])) {
    return _parseFunction(s);
  }

  return _parseNumber(s);
}

function _parseFunction(s) {
  let name = '';
  while (s.pos < s.src.length && /[a-zA-Z_]/.test(s.src[s.pos])) {
    name += s.src[s.pos++];
  }

  if (!ALLOWED_FUNCTIONS.has(name)) {
    throw new Error(`[FormulaParser] Unknown function "${name}". Allowed: ${[...ALLOWED_FUNCTIONS].join(', ')}`);
  }

  if (s.src[s.pos] !== '(') {
    throw new Error(`[FormulaParser] Expected '(' after function name "${name}"`);
  }
  s.pos++; // consume '('

  const args = [];
  while (true) {
    args.push(_parseExpression(s));
    if (s.pos >= s.src.length) {
      throw new Error(`[FormulaParser] Unterminated function call "${name}"`);
    }
    if (s.src[s.pos] === ',') { s.pos++; continue; }
    if (s.src[s.pos] === ')') { s.pos++; break; }
    throw new Error(`[FormulaParser] Unexpected character "${s.src[s.pos]}" in function "${name}"`);
  }

  switch (name) {
    case 'max':   return Math.max(...args);
    case 'min':   return Math.min(...args);
    case 'abs':   return Math.abs(args[0]);
    case 'round': return r2(args[0]);
    default:      throw new Error(`[FormulaParser] Unknown function "${name}"`);
  }
}

function _parseNumber(s) {
  let num = '';

  // Handle unary minus
  if (s.src[s.pos] === '-') num += s.src[s.pos++];

  while (s.pos < s.src.length && /[0-9.]/.test(s.src[s.pos])) {
    num += s.src[s.pos++];
  }

  if (num === '' || num === '-') {
    throw new Error(`[FormulaParser] Expected number at position ${s.pos}`);
  }

  const val = parseFloat(num);
  if (isNaN(val)) {
    throw new Error(`[FormulaParser] Invalid number "${num}"`);
  }
  return val;
}

module.exports = { evaluateFormula };
