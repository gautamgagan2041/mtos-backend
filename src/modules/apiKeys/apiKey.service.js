'use strict';

/**
 * apiKey.service.js — API Key Management for Developer Ecosystem
 *
 * Allows BUSINESS/ENTERPRISE tenants to create API keys for:
 *   - ERP integrations (SAP, Oracle, Tally)
 *   - Custom dashboards
 *   - Mobile apps
 *   - Attendance device integrations (biometric, RFID)
 *
 * Key format: mtos_live_<32 random hex chars>
 *             mtos_test_<32 random hex chars>
 *
 * Security:
 *   - Full key shown ONCE on creation (not stored, only hash stored)
 *   - SHA-256 hash stored in DB
 *   - Keys have optional IP whitelist
 *   - Rate limit: 100 req/min per key
 *   - Scope: granular permissions per key
 *
 * SCHEMA ADDITION NEEDED:
 *   model ApiKey {
 *     id          String   @id @default(uuid())
 *     tenantId    String
 *     name        String
 *     keyHash     String   @unique
 *     keyPrefix   String   // first 12 chars for display: mtos_live_a3f2
 *     scopes      String[] // ["payroll:read", "employees:read", "reports:read"]
 *     ipWhitelist String[] // Optional IP whitelist
 *     isActive    Boolean  @default(true)
 *     lastUsedAt  DateTime?
 *     expiresAt   DateTime?
 *     createdBy   String
 *     createdAt   DateTime @default(now())
 *     @@map("api_keys")
 *   }
 */

const crypto = require('crypto');
const prisma  = require('../../config/database');
const { requireFeature } = require('../../middleware/planGuard');

const VALID_SCOPES = [
  'employees:read',
  'employees:write',
  'attendance:read',
  'attendance:write',
  'payroll:read',
  'reports:read',
  'compliance:read',
];

// ── Create API Key ────────────────────────────────────────────────

async function createApiKey(tenantId, { name, scopes, ipWhitelist, expiresAt }, createdBy) {
  if (!name?.trim()) {
    const e = new Error('API key name is required'); e.statusCode = 400; throw e;
  }

  // Validate scopes
  const invalidScopes = (scopes || []).filter(s => !VALID_SCOPES.includes(s));
  if (invalidScopes.length > 0) {
    const e = new Error(`Invalid scopes: ${invalidScopes.join(', ')}. Valid: ${VALID_SCOPES.join(', ')}`);
    e.statusCode = 400; throw e;
  }

  // Generate key
  const rawKey    = `mtos_live_${crypto.randomBytes(24).toString('hex')}`;
  const keyHash   = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, 18); // "mtos_live_a3f2b1c4"

  const apiKey = await prisma.apiKey.create({
    data: {
      tenantId,
      name:       name.trim(),
      keyHash,
      keyPrefix,
      scopes:     scopes || ['employees:read'],
      ipWhitelist: ipWhitelist || [],
      expiresAt:  expiresAt ? new Date(expiresAt) : null,
      createdBy,
      isActive:   true,
    },
  });

  // Return full key ONCE — never retrievable again
  return {
    id:         apiKey.id,
    name:       apiKey.name,
    key:        rawKey,  // ← shown ONCE
    keyPrefix:  apiKey.keyPrefix,
    scopes:     apiKey.scopes,
    expiresAt:  apiKey.expiresAt,
    createdAt:  apiKey.createdAt,
    WARNING:    'Copy this key now. It will not be shown again.',
  };
}

// ── List API Keys ─────────────────────────────────────────────────

async function listApiKeys(tenantId) {
  return prisma.apiKey.findMany({
    where:   { tenantId, isActive: true },
    select: {
      id: true, name: true, keyPrefix: true, scopes: true,
      ipWhitelist: true, lastUsedAt: true, expiresAt: true, createdAt: true,
      // keyHash is NEVER returned — security boundary
    },
    orderBy: { createdAt: 'desc' },
  });
}

// ── Revoke API Key ────────────────────────────────────────────────

async function revokeApiKey(tenantId, keyId) {
  const key = await prisma.apiKey.findFirst({ where: { id: keyId, tenantId } });
  if (!key) { const e = new Error('API key not found'); e.statusCode = 404; throw e; }

  await prisma.apiKey.update({
    where: { id: keyId },
    data:  { isActive: false },
  });

  return { revoked: true, keyPrefix: key.keyPrefix };
}

// ── Validate API Key (middleware) ─────────────────────────────────

/**
 * authenticateApiKey — middleware to validate API key on incoming requests
 *
 * Usage:
 *   router.get('/employees', authenticateApiKey, requireScope('employees:read'), handler)
 *
 * Header: Authorization: Bearer mtos_live_a3f2b1c4...
 *    OR:  X-API-Key: mtos_live_a3f2b1c4...
 */
const authenticateApiKey = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const xApiKey    = req.headers['x-api-key'];

    let rawKey = xApiKey;
    if (!rawKey && authHeader?.startsWith('Bearer mtos_')) {
      rawKey = authHeader.replace('Bearer ', '');
    }

    if (!rawKey?.startsWith('mtos_')) {
      return next(); // Not an API key request — fall through to JWT auth
    }

    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    const apiKey = await prisma.apiKey.findUnique({
      where:   { keyHash },
      include: { tenant: { select: { id: true, plan: true, status: true } } },
    });

    if (!apiKey || !apiKey.isActive) {
      return res.status(401).json({ success: false, message: 'Invalid or revoked API key' });
    }

    if (apiKey.tenant.status !== 'ACTIVE') {
      return res.status(403).json({ success: false, message: 'Account is not active' });
    }

    if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
      return res.status(401).json({ success: false, message: 'API key has expired' });
    }

    // IP whitelist check
    if (apiKey.ipWhitelist?.length > 0) {
      const clientIP = req.ip || req.connection.remoteAddress;
      if (!apiKey.ipWhitelist.includes(clientIP)) {
        return res.status(403).json({
          success: false,
          message: `IP ${clientIP} is not whitelisted for this API key`,
        });
      }
    }

    // Attach to request (similar to protect middleware)
    req.apiKey   = apiKey;
    req.tenantId = apiKey.tenantId;
    req.tenant   = apiKey.tenant;
    req.user     = { id: null, role: 'API_KEY', name: `API Key: ${apiKey.name}` };

    // Update last used (fire-and-forget)
    prisma.apiKey.update({
      where: { id: apiKey.id },
      data:  { lastUsedAt: new Date() },
    }).catch(() => {});

    next();
  } catch (err) {
    next(err);
  }
};

/**
 * requireScope(scope) — check API key has specific scope permission
 */
const requireScope = (scope) => (req, res, next) => {
  if (!req.apiKey) {
    return next(); // Not an API key request — JWT user has full access
  }
  if (!req.apiKey.scopes?.includes(scope)) {
    return res.status(403).json({
      success: false,
      message: `API key missing required scope: ${scope}`,
      availableScopes: req.apiKey.scopes,
    });
  }
  next();
};

module.exports = {
  createApiKey, listApiKeys, revokeApiKey,
  authenticateApiKey, requireScope, VALID_SCOPES,
};
