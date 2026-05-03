/**
 * MTOS Secrets & Environment Configuration
 *
 * Fixes: CRIT-01 (credentials in git), CRIT-02 (duplicate ENCRYPTION_KEY),
 *        MED-03 (CORS hardcoded to localhost)
 *
 * Design contract:
 *  - Called once at process startup, before any other module initialises.
 *  - Throws a descriptive Error listing ALL missing/invalid vars so the
 *    operator sees the complete picture in one restart, not one-by-one.
 *  - Detects duplicate declarations in the raw .env text so CRIT-02 can
 *    never silently regress.
 *  - Never logs secret values — only key names and structural problems.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Schema ──────────────────────────────────────────────────────────────────

/**
 * Each entry:
 *   key      – exact env var name
 *   required – must be present and non-empty
 *   minLen   – optional minimum character length (for cryptographic material)
 *   notValue – value that must NOT appear (catches copy-paste defaults)
 *   pattern  – optional RegExp the value must satisfy
 */
const SECRET_SCHEMA = [
  // Cryptographic material
  { key: 'JWT_SECRET',       required: true, minLen: 32,
    notValue: '1FPFm/IDSim',  // the leaked value from CRIT-01
    description: 'HS256/RS256 signing secret — min 32 chars' },

  { key: 'ENCRYPTION_KEY',   required: true, minLen: 64,
    notValue: 'cce08dfbbe556f511435fbaed575c751bd0728a8d4f5b8880a2b904dbfb8e2dc',
    pattern: /^[0-9a-fA-F]{64}$/,
    description: 'AES-256-GCM key — exactly 64 hex chars (32 bytes)' },

  // Database
  { key: 'DATABASE_URL',     required: true,
    description: 'Prisma PostgreSQL connection string' },

  // Redis (Upstash or self-hosted)
  { key: 'REDIS_HOST',       required: true,
    description: 'Redis hostname' },
  { key: 'REDIS_PORT',       required: true,
    pattern: /^\d+$/,
    description: 'Redis port (numeric)' },
  { key: 'REDIS_PASSWORD',   required: true, minLen: 16,
    description: 'Redis AUTH password — min 16 chars' },

  // Payment gateway
  { key: 'RAZORPAY_KEY_ID',        required: true },
  { key: 'RAZORPAY_KEY_SECRET',    required: true, minLen: 20 },
  { key: 'RAZORPAY_WEBHOOK_SECRET',required: true, minLen: 20,
    description: 'Required for webhook HMAC-SHA256 verification (HIGH-06)' },

  // Application
  { key: 'NODE_ENV',         required: true,
    pattern: /^(development|test|staging|production)$/,
    description: 'Must be one of: development | test | staging | production' },
  { key: 'PORT',             required: false,
    pattern: /^\d+$/ },
  { key: 'API_CORS_ORIGIN',  required: true,
    notValue: 'http://localhost:5173',
    description: 'Production frontend origin (MED-03 — must not be localhost in prod)' },
];

// ─── Duplicate-declaration detector ──────────────────────────────────────────

/**
 * Reads the raw .env file (if present) and returns an array of key names that
 * are declared more than once.  Fixes CRIT-02.
 */
function detectDuplicateEnvKeys(envFilePath) {
  if (!fs.existsSync(envFilePath)) return [];

  const raw  = fs.readFileSync(envFilePath, 'utf8');
  const seen = new Map();

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    seen.set(key, (seen.get(key) || 0) + 1);
  }

  return [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key);
}

// ─── CORS origin validator ────────────────────────────────────────────────────

/**
 * Parses API_CORS_ORIGIN (comma-separated) and validates each entry.
 * In production, localhost origins are rejected.
 */
function validateCorsOrigins(raw, isProduction) {
  const errors = [];
  if (!raw) return errors;

  const origins = raw.split(',').map(o => o.trim()).filter(Boolean);

  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (isProduction && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
        errors.push(
          `API_CORS_ORIGIN contains localhost origin "${origin}" in production (MED-03)`
        );
      }
    } catch {
      errors.push(`API_CORS_ORIGIN entry "${origin}" is not a valid URL`);
    }
  }

  return errors;
}

// ─── Main validator ───────────────────────────────────────────────────────────

/**
 * Validates all required environment variables.
 *
 * @param {Object} env      – process.env (injectable for testing)
 * @param {string} envFile  – path to .env file for duplicate detection
 * @throws {Error}          – lists ALL violations, never just the first
 */
function validateSecrets(env = process.env, envFile = path.resolve(process.cwd(), '.env')) {
  const errors = [];

  // 1. Check for duplicate declarations in .env file (CRIT-02)
  const duplicates = detectDuplicateEnvKeys(envFile);
  for (const key of duplicates) {
    errors.push(
      `CRIT-02: "${key}" is declared more than once in .env. ` +
      `dotenv silently uses the first value; rotation divergence will cause mass 500 errors. ` +
      `Remove the duplicate.`
    );
  }

  // 2. Schema-driven field validation
  for (const spec of SECRET_SCHEMA) {
    const val = env[spec.key];
    const empty = val === undefined || val === null || val.trim() === '';

    if (spec.required && empty) {
      errors.push(`"${spec.key}" is required but missing. ${spec.description || ''}`);
      continue; // Skip further checks — value doesn't exist
    }
    if (empty) continue; // Optional and absent — fine

    if (spec.notValue && val.startsWith(spec.notValue)) {
      errors.push(
        `"${spec.key}" still contains the known-compromised default value from CRIT-01. ` +
        `Rotate the secret immediately.`
      );
    }

    if (spec.minLen && val.length < spec.minLen) {
      errors.push(
        `"${spec.key}" is too short (${val.length} chars). Minimum: ${spec.minLen}. ` +
        `${spec.description || ''}`
      );
    }

    if (spec.pattern && !spec.pattern.test(val)) {
      errors.push(
        `"${spec.key}" does not match expected format. ${spec.description || ''}`
      );
    }
  }

  // 3. Production-specific CORS check (MED-03)
  if (env.NODE_ENV === 'production') {
    const corsErrors = validateCorsOrigins(env.API_CORS_ORIGIN, true);
    errors.push(...corsErrors);
  }

  // 4. Fail loudly with complete diagnostics
  if (errors.length > 0) {
    const msg = [
      '',
      '╔══════════════════════════════════════════════════════════════╗',
      '║         MTOS — STARTUP CONFIGURATION VALIDATION FAILED       ║',
      '╚══════════════════════════════════════════════════════════════╝',
      '',
      `${errors.length} violation(s) found:`,
      '',
      ...errors.map((e, i) => `  ${i + 1}. ${e}`),
      '',
      'Process will not start until all issues are resolved.',
      'See docs/SECRETS_ROTATION_RUNBOOK.md for remediation steps.',
      '',
    ].join('\n');

    throw new Error(msg);
  }
}

// ─── Parsed, typed config object ─────────────────────────────────────────────

/**
 * Returns a frozen, typed configuration object.
 * Call AFTER validateSecrets() has passed.
 */
function buildConfig(env = process.env) {
  return Object.freeze({
    nodeEnv:    env.NODE_ENV,
    port:       parseInt(env.PORT || '3000', 10),
    isProduction: env.NODE_ENV === 'production',

    jwt: {
      secret:    env.JWT_SECRET,
      expiresIn: env.JWT_EXPIRES_IN || '8h',
    },

    encryption: {
      key: env.ENCRYPTION_KEY,
    },

    database: {
      url: env.DATABASE_URL,
    },

    redis: {
      host:     env.REDIS_HOST,
      port:     parseInt(env.REDIS_PORT || '6379', 10),
      password: env.REDIS_PASSWORD,
      tls:      env.REDIS_TLS === 'true',
    },

    razorpay: {
      keyId:         env.RAZORPAY_KEY_ID,
      keySecret:     env.RAZORPAY_KEY_SECRET,
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
    },

    cors: {
      origins: (env.API_CORS_ORIGIN || '')
        .split(',')
        .map(o => o.trim())
        .filter(Boolean),
    },
  });
}

module.exports = { validateSecrets, buildConfig, detectDuplicateEnvKeys, validateCorsOrigins };
