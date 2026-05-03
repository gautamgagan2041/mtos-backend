/**
 * MTOS PII Encryption Utility
 *
 * Fixes: CRIT-04 (disbursement sending ciphertext to wire)
 *
 * Algorithm : AES-256-GCM
 * Key format : 64 hex chars (32 raw bytes) stored in ENCRYPTION_KEY
 * Wire format: "<hex-iv>:<hex-authTag>:<hex-ciphertext>"
 *
 * Design contract:
 *  - encryptField / decryptField are the ONLY functions that should touch raw
 *    PII bytes anywhere in the codebase. All repositories call these.
 *  - encryptPII / decryptPII operate on a whole employee-shaped object,
 *    touching only the fields listed in PII_FIELDS.
 *  - decryptPII is SAFE to call on an already-decrypted object: if a field
 *    does not match the wire format it is returned as-is (idempotent).
 *  - Both functions are synchronous — Node crypto is synchronous for AES-GCM.
 */

'use strict';

const crypto = require('crypto');

// ─── Constants ────────────────────────────────────────────────────────────────

const ALGORITHM  = 'aes-256-gcm';
const IV_BYTES   = 12;   // 96-bit IV recommended for GCM
const TAG_BYTES  = 16;

/**
 * Fields that are stored as AES-256-GCM ciphertext in the database.
 * This list is the single source of truth — add/remove fields here only.
 */
const PII_FIELDS = Object.freeze([
  'aadhaarNumber',
  'panNumber',
  'bankAccount',
  'ifscCode',
  // NOTE MED-05: "phone" is intentionally omitted pending DPDP Act
  // compliance decision. If added here, update findAll() search to use
  // HMAC token index rather than plaintext LIKE query.
]);

// Wire-format sentinel — allows idempotent decryption detection
const WIRE_FORMAT_RE = /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/;

// ─── Key management ───────────────────────────────────────────────────────────

let _keyBuffer = null;

/**
 * Returns the raw 32-byte key from ENCRYPTION_KEY env var.
 * Cached after first call. Throws if the key is not set or malformed.
 */
function getKeyBuffer() {
  if (_keyBuffer) return _keyBuffer;

  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). ' +
      'Run: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  _keyBuffer = Buffer.from(hex, 'hex');
  return _keyBuffer;
}

/**
 * Clears the cached key buffer. For use in tests only.
 * @internal
 */
function _resetKeyCache() { _keyBuffer = null; }

// ─── Field-level operations ───────────────────────────────────────────────────

/**
 * Encrypts a single string value.
 * @param  {string} plaintext
 * @returns {string}  "<hex-iv>:<hex-tag>:<hex-ciphertext>"
 */
function encryptField(plaintext) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  if (typeof plaintext !== 'string') {
    throw new TypeError(`encryptField expects a string, got ${typeof plaintext}`);
  }

  const iv     = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKeyBuffer(), iv, { authTagLength: TAG_BYTES });

  const ct  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

/**
 * Decrypts a single wire-format string.
 * Idempotent: if the value does not look like wire format, returns it unchanged.
 * This prevents double-decrypt errors when the same row is processed twice.
 *
 * @param  {string} wireValue
 * @returns {string}  plaintext
 */
function decryptField(wireValue) {
  if (wireValue === null || wireValue === undefined) return wireValue;
  if (typeof wireValue !== 'string') return wireValue;

  // Idempotency guard — not encrypted, return as-is
  if (!WIRE_FORMAT_RE.test(wireValue)) return wireValue;

  const parts = wireValue.split(':');
  if (parts.length !== 3) return wireValue;

  const [ivHex, tagHex, ctHex] = parts;

  try {
    const iv      = Buffer.from(ivHex,  'hex');
    const tag     = Buffer.from(tagHex, 'hex');
    const ct      = Buffer.from(ctHex,  'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, getKeyBuffer(), iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return decipher.update(ct) + decipher.final('utf8');
  } catch (err) {
    // Surface as a typed error so callers can distinguish auth failures from
    // programming errors and return a 500 with the correct message.
    const e = new Error(
      `PII decryption failed — possible key rotation mismatch (CRIT-02). ` +
      `Original: ${err.message}`
    );
    e.code = 'PII_DECRYPT_FAILED';
    throw e;
  }
}

// ─── Object-level operations ──────────────────────────────────────────────────

/**
 * Returns a copy of the employee object with all PII_FIELDS encrypted.
 * Does NOT mutate the input.
 *
 * @param  {Object} employee  – raw employee data (plaintext PII)
 * @returns {Object}          – copy with encrypted PII fields
 */
function encryptPII(employee) {
  if (!employee || typeof employee !== 'object') return employee;
  const result = { ...employee };
  for (const field of PII_FIELDS) {
    if (result[field] !== undefined && result[field] !== null) {
      result[field] = encryptField(String(result[field]));
    }
  }
  return result;
}

/**
 * Returns a copy of the employee object with all PII_FIELDS decrypted.
 * Idempotent — safe to call on already-decrypted objects.
 * Does NOT mutate the input.
 *
 * CRIT-04 fix: disbursement.repository.js MUST call this before reading
 * bankAccount / ifscCode, otherwise ciphertext is sent to the wire transfer.
 *
 * @param  {Object} employee  – employee row from DB (encrypted PII)
 * @returns {Object}          – copy with decrypted PII fields
 */
function decryptPII(employee) {
  if (!employee || typeof employee !== 'object') return employee;
  const result = { ...employee };
  for (const field of PII_FIELDS) {
    if (result[field] !== undefined && result[field] !== null) {
      result[field] = decryptField(String(result[field]));
    }
  }
  return result;
}

module.exports = {
  PII_FIELDS,
  encryptField,
  decryptField,
  encryptPII,
  decryptPII,
  _resetKeyCache,   // test-only
};
