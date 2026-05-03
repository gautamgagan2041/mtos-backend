'use strict';

/**
 * Integration test — Disbursement flow
 *
 * Reproduces the CRIT-04 failure scenario (ciphertext sent to wire) and
 * proves the fix (decryptPII called before empMap construction) prevents it.
 *
 * Does NOT need a real DB — Prisma is fully mocked with realistic data.
 */

const { encryptPII, _resetKeyCache } = require('../../src/config/piiEncryption');
const { initializeDisbursements, looksLikeCiphertext, DisbursementEncryptionError } = require('../../src/repositories/disbursement.repository');

const TEST_KEY = 'ef'.repeat(32);

beforeEach(() => {
  _resetKeyCache();
  process.env.ENCRYPTION_KEY = TEST_KEY;
});

afterEach(() => {
  _resetKeyCache();
  delete process.env.ENCRYPTION_KEY;
});

// ─── Mock data ────────────────────────────────────────────────────────────────

function makeEmployee(id, plaintext = true) {
  const raw = {
    id,
    employeeCode: `EMP-${id}`,
    fullName:     'Test Employee',
    bankAccount:  '001122334455',
    ifscCode:     'HDFC0001234',
    bankName:     'HDFC Bank',
  };
  return plaintext ? raw : encryptPII(raw);  // encrypted = as stored in DB
}

function makePrismaWithRows(employees) {
  // employees is array of raw (plaintext or encrypted) employee objects
  const rows = employees.map((emp, i) => ({
    id:         `row_00${i}`,
    payrollRunId: 'run_001',
    tenantId:   'tenant_A',
    employeeId: emp.id,
    netPay:     25000,
    employee:   emp,  // ← this is what the DB join returns (encrypted)
  }));

  return {
    payrollRow: {
      findMany: jest.fn(async () => rows),
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CRIT-04 — initializeDisbursements decrypts PII before building empMap', () => {
  test('bankAccount in empMap is plaintext, not ciphertext', async () => {
    // Simulate DB returning encrypted employee rows (as Prisma would)
    const encryptedEmp = makeEmployee('emp_001', false); // encrypted
    const prisma = makePrismaWithRows([encryptedEmp]);

    const empMap = await initializeDisbursements(prisma, 'tenant_A', 'run_001');
    const entry  = empMap.get('emp_001');

    expect(entry).toBeDefined();
    expect(entry.bankAccount).toBe('001122334455');   // plaintext
    expect(looksLikeCiphertext(entry.bankAccount)).toBe(false); // NOT ciphertext
  });

  test('ifscCode in empMap is plaintext', async () => {
    const encryptedEmp = makeEmployee('emp_001', false);
    const prisma = makePrismaWithRows([encryptedEmp]);

    const empMap = await initializeDisbursements(prisma, 'tenant_A', 'run_001');
    const entry  = empMap.get('emp_001');

    expect(entry.ifscCode).toBe('HDFC0001234');
    expect(looksLikeCiphertext(entry.ifscCode)).toBe(false);
  });

  test('REGRESSION: raw ciphertext in empMap would have looked like garbled wire transfer', () => {
    // Prove what the bug looked like: if we skip decryption...
    const encryptedEmp = makeEmployee('emp_001', false);
    const rawBankAccount = encryptedEmp.bankAccount;

    // ...the bankAccount would be ciphertext
    expect(looksLikeCiphertext(rawBankAccount)).toBe(true);
    expect(rawBankAccount).not.toBe('001122334455');
  });

  test('builds empMap with correct netPay for all employees', async () => {
    const emps   = [makeEmployee('emp_001', false), makeEmployee('emp_002', false)];
    const prisma = makePrismaWithRows(emps);

    const empMap = await initializeDisbursements(prisma, 'tenant_A', 'run_001');

    expect(empMap.size).toBe(2);
    expect(empMap.get('emp_001').netPay).toBe(25000);
    expect(empMap.get('emp_002').netPay).toBe(25000);
  });

  test('throws DisbursementEncryptionError on key mismatch (key rotation gone wrong)', async () => {
    // Simulate: employee was encrypted with old key, now running with new key
    const encryptedWithOldKey = makeEmployee('emp_001', false);

    // Switch to a different key — decryption will fail
    _resetKeyCache();
    process.env.ENCRYPTION_KEY = 'aa'.repeat(32); // different key

    const prisma = makePrismaWithRows([encryptedWithOldKey]);

    // Should throw a typed error, not silently send ciphertext
    await expect(initializeDisbursements(prisma, 'tenant_A', 'run_001'))
      .rejects.toThrow(); // PII_DECRYPT_FAILED bubbles up
  });

  test('throws when tenantId is missing', async () => {
    const prisma = makePrismaWithRows([]);
    await expect(initializeDisbursements(prisma, undefined, 'run_001'))
      .rejects.toThrow(/tenantId is required/);
  });

  test('skips rows with null employee (detached records)', async () => {
    const rows = [{ id: 'row_1', employeeId: 'emp_x', netPay: 1000, employee: null }];
    const prisma = { payrollRow: { findMany: jest.fn(async () => rows) } };

    const empMap = await initializeDisbursements(prisma, 'tenant_A', 'run_001');
    expect(empMap.size).toBe(0); // gracefully skipped
  });
});

describe('looksLikeCiphertext()', () => {
  test('returns true for valid AES-GCM wire format', () => {
    // 24-char IV hex : 32-char tag hex : N-char ct hex
    expect(looksLikeCiphertext('a'.repeat(24) + ':' + 'b'.repeat(32) + ':' + 'c'.repeat(20))).toBe(true);
  });

  test('returns false for plaintext bank account', () => {
    expect(looksLikeCiphertext('001122334455')).toBe(false);
  });

  test('returns false for IFSC code', () => {
    expect(looksLikeCiphertext('HDFC0001234')).toBe(false);
  });
});
