'use strict';

/**
 * encryption.js — AES-256-GCM field-level encryption for PII
 *
 * USAGE:
 *   Add ENCRYPTION_KEY to .env:
 *     ENCRYPTION_KEY=<openssl rand -hex 32>   ← 64 hex chars = 32 bytes
 *
 * Encrypted format stored in DB:
 *   <iv:32hex>:<authTag:32hex>:<ciphertext:hex>
 *
 * Fields to encrypt:  aadhaar, pan, bankAccount, ifscCode, phone (optional)
 *
 * HOW TO ADD TO EMPLOYEE CREATION:
 *   import { encryptPII, decryptPII } from '../../utils/encryption';
 *
 *   // Before saving to DB:
 *   const dbData = encryptPII(employeeData);
 *   await prisma.employee.create({ data: dbData });
 *
 *   // After reading from DB:
 *   const employee = await prisma.employee.findUnique({ ... });
 *   return decryptPII(employee);
 */

const crypto = require('crypto');

const ALGORITHM    = 'aes-256-gcm';
const IV_BYTES     = 16;
const TAG_BYTES    = 16;
const SEPARATOR    = ':';

// PII fields that must be encrypted at rest
const PII_FIELDS = ['aadhaar', 'pan', 'bankAccount', 'ifscCode'];

let _key = null;

function _getKey() {
  if (_key) return _key;
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw.length !== 64) {
    throw new Error(
      '[Encryption] ENCRYPTION_KEY must be a 64-character hex string. ' +
      'Generate with: openssl rand -hex 32'
    );
  }
  _key = Buffer.from(raw, 'hex');
  return _key;
}

/**
 * encrypt — encrypt a plaintext string
 * Returns null if plaintext is null/undefined/empty
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') {
    return null;
  }
  const key  = _getKey();
  const iv   = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    iv.toString('hex'),
    tag.toString('hex'),
    encrypted.toString('hex'),
  ].join(SEPARATOR);
}

/**
 * decrypt — decrypt an encrypted string
 * Returns null if ciphertext is null/undefined/empty
 * Throws if ciphertext is malformed or tampered
 */
function decrypt(ciphertext) {
  if (ciphertext === null || ciphertext === undefined || ciphertext === '') {
    return null;
  }

  // Detect already-plaintext values (migration safety)
  // A valid encrypted value always has exactly 2 separators
  const parts = String(ciphertext).split(SEPARATOR);
  if (parts.length !== 3) {
    // Legacy plaintext — return as-is and log warning
    // Remove this branch after migration is complete
    console.warn('[Encryption] decrypt() received non-encrypted value — returning as-is. Run migration.');
    return ciphertext;
  }

  const [ivHex, tagHex, encHex] = parts;

  try {
    const key      = _getKey();
    const iv       = Buffer.from(ivHex, 'hex');
    const tag      = Buffer.from(tagHex, 'hex');
    const enc      = Buffer.from(encHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

    decipher.setAuthTag(tag);

    return decipher.update(enc) + decipher.final('utf8');
  } catch (err) {
    throw new Error(`[Encryption] Decryption failed — data may be tampered: ${err.message}`);
  }
}

/**
 * encryptPII — encrypt all PII fields in an employee data object
 * Safe to call on partial objects (only encrypts fields that exist)
 */
function encryptPII(data) {
  if (!data || typeof data !== 'object') return data;
  const result = { ...data };
  for (const field of PII_FIELDS) {
    if (result[field] !== undefined) {
      result[field] = encrypt(result[field]);
    }
  }
  return result;
}

/**
 * decryptPII — decrypt all PII fields in an employee object from DB
 * Safe to call on partial objects (only decrypts fields that exist)
 */
function decryptPII(data) {
  if (!data || typeof data !== 'object') return data;
  const result = { ...data };
  for (const field of PII_FIELDS) {
    if (result[field] !== undefined) {
      result[field] = decrypt(result[field]);
    }
  }
  return result;
}

/**
 * maskPII — return masked values for display (last 4 digits only)
 * Use in audit logs, list views, non-sensitive contexts
 */
function maskPII(data) {
  if (!data || typeof data !== 'object') return data;
  const result = { ...data };
  if (result.aadhaar)     result.aadhaar     = `XXXX-XXXX-${String(result.aadhaar).slice(-4)}`;
  if (result.pan)         result.pan         = `${String(result.pan).slice(0,2)}XXXXXXX${String(result.pan).slice(-1)}`;
  if (result.bankAccount) result.bankAccount = `XXXX${String(result.bankAccount).slice(-4)}`;
  return result;
}

/**
 * One-time migration: encrypt existing plaintext PII in the database
 * Run as: node -e "require('./src/utils/encryption').migratePIIEncryption()"
 */
async function migratePIIEncryption() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  console.log('[Migration] Starting PII encryption migration...');

  const employees = await prisma.employee.findMany({
    select: { id: true, aadhaar: true, pan: true, bankAccount: true, ifscCode: true },
  });

  let migrated = 0;
  let skipped  = 0;

  for (const emp of employees) {
    // Check if already encrypted (has 2 colons)
    const needsMigration = PII_FIELDS.some(f => {
      const val = emp[f];
      return val && val.split(':').length !== 3;
    });

    if (!needsMigration) { skipped++; continue; }

    const update = {};
    for (const field of PII_FIELDS) {
      if (emp[field] && emp[field].split(':').length !== 3) {
        update[field] = encrypt(emp[field]);
      }
    }

    if (Object.keys(update).length > 0) {
      await prisma.employee.update({ where: { id: emp.id }, data: update });
      migrated++;
    }
  }

  await prisma.$disconnect();
  console.log(`[Migration] Done. Migrated: ${migrated}, Already encrypted: ${skipped}`);
}


// ── HMAC search token — deterministic, safe for DB lookup ──────
// Use this for Aadhaar/PAN duplicate checks instead of encrypted ciphertext
function hmacToken(plainText) {
  if (!plainText) return null;
  const key = process.env.ENCRYPTION_KEY; // reuse same key
  if (!key || key.length !== 64) throw new Error('[Encryption] ENCRYPTION_KEY required for HMAC');
  return crypto.createHmac('sha256', key).update(String(plainText).trim()).digest('hex');
}

module.exports = {
  hmacToken, encrypt, decrypt, encryptPII, decryptPII, maskPII, migratePIIEncryption, PII_FIELDS };
