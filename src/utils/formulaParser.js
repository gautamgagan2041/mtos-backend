'use strict';

function evaluateFormula(formula, context = {}) {
  if (!formula) return 0;

  let expr = formula;

  const keys = Object.keys(context).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const val = Number(context[key]) || 0;
    expr = expr.replace(new RegExp(`\\b${key}\\b`, 'g'), val);
  }

  const clean = expr.replace(/\b(max|min|abs|round)\b/g, '');
  if (!/^[0-9+\-*/()., ]+$/.test(clean)) {
    throw new Error(`Unsafe formula: ${formula}`);
  }

  return r2(parseExpression(expr.replace(/\s+/g, ''), { pos: 0 }));
}

const r2 = (n) => Math.round((n || 0) * 100) / 100;

function parseExpression(expr, s) {
  let val = parseTerm(expr, s);
  while (s.pos < expr.length && /[+-]/.test(expr[s.pos])) {
    const op = expr[s.pos++];
    const right = parseTerm(expr, s);
    val = op === '+' ? val + right : val - right;
  }
  return val;
}

function parseTerm(expr, s) {
  let val = parseFactor(expr, s);
  while (s.pos < expr.length && /[*/]/.test(expr[s.pos])) {
    const op = expr[s.pos++];
    const right = parseFactor(expr, s);
    if (op === '/') {
      if (right === 0) throw new Error('Division by zero');
      val /= right;
    } else val *= right;
  }
  return val;
}

function parseFactor(expr, s) {
  if (expr[s.pos] === '(') {
    s.pos++;
    const val = parseExpression(expr, s);
    s.pos++;
    return val;
  }

  if (/[a-z]/i.test(expr[s.pos])) {
    return parseFunction(expr, s);
  }

  return parseNumber(expr, s);
}

function parseFunction(expr, s) {
  let name = '';
  while (/[a-z]/i.test(expr[s.pos])) name += expr[s.pos++];

  s.pos++; // (

  const args = [];
  while (true) {
    args.push(parseExpression(expr, s));
    if (expr[s.pos] === ',') {
      s.pos++;
      continue;
    }
    if (expr[s.pos] === ')') {
      s.pos++;
      break;
    }
  }

  switch (name) {
    case 'max': return Math.max(...args);
    case 'min': return Math.min(...args);
    case 'abs': return Math.abs(args[0]);
    case 'round': return r2(args[0]);
    default: throw new Error(`Unknown function ${name}`);
  }
}

function parseNumber(expr, s) {
  let num = '';
  if (expr[s.pos] === '-') num += expr[s.pos++];

  while (/[0-9.]/.test(expr[s.pos])) {
    num += expr[s.pos++];
  }

  return parseFloat(num);
}

module.exports = { evaluateFormula };