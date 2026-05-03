'use strict';

const {
  encryptField, decryptField,
  encryptPII, decryptPII,
  PII_FIELDS, _resetKeyCache,
} = require('../../src/config/piiEncryption');

// ─── Test key (64 valid hex chars) ────────────────────────────────────────────

const TEST_KEY = 'ab'.repeat(32);

beforeEach(() => {
  _resetKeyCache();
  process.env.ENCRYPTION_KEY = TEST_KEY;
});

afterEach(() => {
  _resetKeyCache();
  delete process.env.ENCRYPTION_KEY;
});

// ─── Field-level encrypt / decrypt ───────────────────────────────────────────

describe('encryptField / decryptField', () => {
  test('round-trips a plaintext string correctly', () => {
    const plain = '987654321098';   // simulated Aadhaar
    const wire  = encryptField(plain);
    expect(decryptField(wire)).toBe(plain);
  });

  test('produces different ciphertext each call (IV randomness)', () => {
    const plain = 'ABCDE1234F';
    const wire1 = encryptField(plain);
    const wire2 = encryptField(plain);
    expect(wire1).not.toBe(wire2);
  });

  test('wire format is <iv>:<tag>:<ct> (all hex, colon-separated)', () => {
    const wire = encryptField('test');
    const parts = wire.split(':');
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(part).toMatch(/^[0-9a-f]+$/);
    }
  });

  test('decryptField is idempotent — returns plaintext unchanged', () => {
    const plain = 'alreadyDecrypted';
    // plain string does not match wire format — must be returned as-is
    expect(decryptField(plain)).toBe(plain);
  });

  test('handles null and undefined without throwing', () => {
    expect(encryptField(null)).toBeNull();
    expect(encryptField(undefined)).toBeUndefined();
    expect(decryptField(null)).toBeNull();
    expect(decryptField(undefined)).toBeUndefined();
  });

  test('decryptField throws PII_DECRYPT_FAILED on wrong key', () => {
    const wire = encryptField('secret');

    _resetKeyCache();
    process.env.ENCRYPTION_KEY = 'cd'.repeat(32); // different key

    expect(() => decryptField(wire)).toThrow(
      expect.objectContaining({ code: 'PII_DECRYPT_FAILED' })
    );
  });

  test('throws on missing ENCRYPTION_KEY', () => {
    _resetKeyCache();
    delete process.env.ENCRYPTION_KEY;
    expect(() => encryptField('test')).toThrow(/ENCRYPTION_KEY/);
  });

  test('throws on malformed ENCRYPTION_KEY (not hex)', () => {
    _resetKeyCache();
    process.env.ENCRYPTION_KEY = 'zz'.repeat(32);
    expect(() => encryptField('test')).toThrow(/ENCRYPTION_KEY/);
  });
});

// ─── Object-level encryptPII / decryptPII ─────────────────────────────────────

describe('encryptPII / decryptPII', () => {
  const rawEmployee = {
    id:            'emp_001',
    fullName:      'Ravi Kumar',
    aadhaarNumber: '123412341234',
    panNumber:     'ABCDE1234F',
    bankAccount:   '00112233445566',
    ifscCode:      'SBIN0001234',
    phone:         '9876543210',  // NOT a PII_FIELD — should pass through
  };

  test('encrypts exactly PII_FIELDS and leaves others unchanged', () => {
    const encrypted = encryptPII(rawEmployee);
    for (const field of PII_FIELDS) {
      // Should differ from plaintext (encrypted)
      expect(encrypted[field]).not.toBe(rawEmployee[field]);
      // Should look like wire format
      expect(encrypted[field]).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    }
    // Non-PII fields untouched
    expect(encrypted.id).toBe(rawEmployee.id);
    expect(encrypted.fullName).toBe(rawEmployee.fullName);
    expect(encrypted.phone).toBe(rawEmployee.phone);
  });

  test('decryptPII recovers exact plaintext for all PII_FIELDS', () => {
    const encrypted = encryptPII(rawEmployee);
    const decrypted = decryptPII(encrypted);
    for (const field of PII_FIELDS) {
      expect(decrypted[field]).toBe(rawEmployee[field]);
    }
  });

  test('decryptPII is idempotent — safe to call on already-decrypted object', () => {
    const encrypted  = encryptPII(rawEmployee);
    const decrypted1 = decryptPII(encrypted);
    const decrypted2 = decryptPII(decrypted1); // second call on plaintext
    expect(decrypted2.bankAccount).toBe(rawEmployee.bankAccount);
  });

  test('does NOT mutate the input object', () => {
    const original = { ...rawEmployee };
    encryptPII(rawEmployee);
    expect(rawEmployee.aadhaarNumber).toBe(original.aadhaarNumber);
  });

  test('handles employee with null PII fields gracefully', () => {
    const emp = { id: 'emp_002', bankAccount: null, ifscCode: null };
    const encrypted = encryptPII(emp);
    expect(encrypted.bankAccount).toBeNull();
    const decrypted = decryptPII(encrypted);
    expect(decrypted.bankAccount).toBeNull();
  });

  test('handles non-object input gracefully', () => {
    expect(decryptPII(null)).toBeNull();
    expect(decryptPII(undefined)).toBeUndefined();
  });
});

// ─── CRIT-04 regression: bankAccount must not be ciphertext after decryptPII ──

describe('CRIT-04 regression — disbursement bank detail safety', () => {
  test('bankAccount after decryptPII is not wire-format ciphertext', () => {
    const emp = { bankAccount: '00112233445566', ifscCode: 'HDFC0001234' };
    const encrypted = encryptPII(emp);

    // Simulate the bug: reading raw DB value (encrypted)
    const ciphertextBankAccount = encrypted.bankAccount;
    expect(ciphertextBankAccount).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);

    // After decryptPII — must be plaintext
    const decrypted = decryptPII(encrypted);
    expect(decrypted.bankAccount).toBe('00112233445566');
    expect(decrypted.bankAccount).not.toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
  });
});
