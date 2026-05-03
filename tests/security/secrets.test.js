'use strict';

const path = require('path');
const { validateSecrets, detectDuplicateEnvKeys, validateCorsOrigins, buildConfig } = require('../../src/config/secrets');

// ─── Baseline valid env (all required fields present) ─────────────────────────

function validEnv(overrides = {}) {
  return {
    JWT_SECRET:                'a'.repeat(32),
    ENCRYPTION_KEY:            'ab'.repeat(32),   // 64 hex chars
    DATABASE_URL:              'postgresql://user:pass@host/db',
    REDIS_HOST:                'redis.internal',
    REDIS_PORT:                '6379',
    REDIS_PASSWORD:            'strongpassword123!',
    RAZORPAY_KEY_ID:           'rzp_live_testkey',
    RAZORPAY_KEY_SECRET:       'secretvalue12345678901',
    RAZORPAY_WEBHOOK_SECRET:   'webhooksecret12345678',
    NODE_ENV:                  'production',
    API_CORS_ORIGIN:           'https://app.mtos.in',
    ...overrides,
  };
}

// ─── CRIT-01: leaked value detection ─────────────────────────────────────────

describe('CRIT-01 — leaked credential detection', () => {
  test('rejects JWT_SECRET that starts with the known-leaked value', () => {
    const env = validEnv({ JWT_SECRET: '1FPFm/IDSimSomethingMore' });
    expect(() => validateSecrets(env, '/nonexistent/.env'))
      .toThrow(/known-compromised default value/);
  });

  test('rejects ENCRYPTION_KEY that equals the committed value', () => {
    const env = validEnv({
      ENCRYPTION_KEY: 'cce08dfbbe556f511435fbaed575c751bd0728a8d4f5b8880a2b904dbfb8e2dc',
    });
    expect(() => validateSecrets(env, '/nonexistent/.env'))
      .toThrow(/known-compromised default value/);
  });

  test('accepts a freshly-rotated ENCRYPTION_KEY', () => {
    const env = validEnv({ ENCRYPTION_KEY: 'ff'.repeat(32) });
    expect(() => validateSecrets(env, '/nonexistent/.env')).not.toThrow();
  });
});

// ─── CRIT-02: duplicate key detection ────────────────────────────────────────

describe('CRIT-02 — duplicate env key detection', () => {
  test('detects a key declared twice in .env content', () => {
    const tmpFile = require('os').tmpdir() + '/test.env.' + Date.now();
    require('fs').writeFileSync(tmpFile, [
      'JWT_SECRET=first',
      'ENCRYPTION_KEY=val',
      'JWT_SECRET=second',   // duplicate
    ].join('\n'));

    const dups = detectDuplicateEnvKeys(tmpFile);
    expect(dups).toContain('JWT_SECRET');
    expect(dups).not.toContain('ENCRYPTION_KEY');
    require('fs').unlinkSync(tmpFile);
  });

  test('validateSecrets throws when duplicates are detected', () => {
    const tmpFile = require('os').tmpdir() + '/test2.env.' + Date.now();
    require('fs').writeFileSync(tmpFile, [
      'ENCRYPTION_KEY=abc',
      'ENCRYPTION_KEY=def',
    ].join('\n'));

    expect(() => validateSecrets(validEnv(), tmpFile))
      .toThrow(/CRIT-02/);
    require('fs').unlinkSync(tmpFile);
  });

  test('returns empty array for a clean .env file', () => {
    const tmpFile = require('os').tmpdir() + '/test3.env.' + Date.now();
    require('fs').writeFileSync(tmpFile, 'A=1\nB=2\nC=3\n');
    expect(detectDuplicateEnvKeys(tmpFile)).toHaveLength(0);
    require('fs').unlinkSync(tmpFile);
  });

  test('returns empty array when .env file does not exist', () => {
    expect(detectDuplicateEnvKeys('/tmp/does_not_exist_xyz.env')).toHaveLength(0);
  });
});

// ─── MED-03: CORS origin validation ──────────────────────────────────────────

describe('MED-03 — CORS origin validation in production', () => {
  test('rejects localhost origin in production', () => {
    const errors = validateCorsOrigins('http://localhost:5173', true);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/localhost/);
  });

  test('rejects 127.0.0.1 origin in production', () => {
    const errors = validateCorsOrigins('http://127.0.0.1:3000', true);
    expect(errors.length).toBeGreaterThan(0);
  });

  test('accepts localhost in development', () => {
    const errors = validateCorsOrigins('http://localhost:5173', false);
    expect(errors).toHaveLength(0);
  });

  test('accepts valid production origin', () => {
    const errors = validateCorsOrigins('https://app.mtos.in', true);
    expect(errors).toHaveLength(0);
  });

  test('rejects malformed URL', () => {
    const errors = validateCorsOrigins('not-a-url', true);
    expect(errors.length).toBeGreaterThan(0);
  });

  test('validateSecrets throws for localhost CORS in production', () => {
    const env = validEnv({ API_CORS_ORIGIN: 'http://localhost:5173', NODE_ENV: 'production' });
    expect(() => validateSecrets(env, '/nonexistent/.env'))
      .toThrow(/localhost/);
  });
});

// ─── Required field validation ────────────────────────────────────────────────

describe('Required field validation', () => {
  test('throws listing ALL missing fields, not just the first', () => {
    const env = { NODE_ENV: 'production' }; // missing almost everything
    let error;
    try { validateSecrets(env, '/nonexistent/.env'); }
    catch (e) { error = e; }

    expect(error).toBeDefined();
    expect(error.message).toMatch(/JWT_SECRET/);
    expect(error.message).toMatch(/ENCRYPTION_KEY/);
    expect(error.message).toMatch(/DATABASE_URL/);
    expect(error.message).toMatch(/REDIS_PASSWORD/);
    expect(error.message).toMatch(/RAZORPAY_WEBHOOK_SECRET/);
  });

  test('ENCRYPTION_KEY must be exactly 64 hex chars', () => {
    expect(() => validateSecrets(validEnv({ ENCRYPTION_KEY: 'tooshort' }), '/nonexistent/.env'))
      .toThrow(/ENCRYPTION_KEY/);
  });

  test('ENCRYPTION_KEY must be hex only', () => {
    expect(() => validateSecrets(validEnv({ ENCRYPTION_KEY: 'zz'.repeat(32) }), '/nonexistent/.env'))
      .toThrow(/ENCRYPTION_KEY/);
  });

  test('NODE_ENV must be a valid value', () => {
    expect(() => validateSecrets(validEnv({ NODE_ENV: 'banana' }), '/nonexistent/.env'))
      .toThrow(/NODE_ENV/);
  });

  test('REDIS_PASSWORD must be at least 16 chars', () => {
    expect(() => validateSecrets(validEnv({ REDIS_PASSWORD: 'short' }), '/nonexistent/.env'))
      .toThrow(/REDIS_PASSWORD/);
  });
});

// ─── buildConfig ──────────────────────────────────────────────────────────────

describe('buildConfig()', () => {
  test('returns a frozen config object with typed fields', () => {
    const config = buildConfig(validEnv());
    expect(config.redis.port).toBe(6379);
    expect(config.cors.origins).toEqual(['https://app.mtos.in']);
    expect(config.isProduction).toBe(true);
    // Object.freeze prevents adding/deleting properties; in non-strict mode
    // assignment silently fails rather than throwing, so check immutability via isFrozen
    expect(Object.isFrozen(config)).toBe(true);
  });

  test('parses multiple CORS origins correctly', () => {
    const config = buildConfig(validEnv({ API_CORS_ORIGIN: 'https://a.com,https://b.com' }));
    expect(config.cors.origins).toEqual(['https://a.com', 'https://b.com']);
  });
});
