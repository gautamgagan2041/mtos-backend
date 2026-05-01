'use strict';

/**
 * auditService.js — v4: Structured audit logging with pagination
 *
 * IMPROVEMENTS over v3:
 *  1. Graceful fail — audit failures NEVER crash the main operation
 *  2. Structured metadata (IP, userAgent, changes diff)
 *  3. getAuditLogs() with pagination + filtering
 *  4. getEntityHistory() for a specific record
 *  5. Automatic PII field masking in audit log values
 */

const prisma = require('../config/database');
const logger = require('../utils/logger');

// Fields that must be masked in audit logs
const PII_AUDIT_FIELDS = new Set(['aadhaar', 'pan', 'bankAccount', 'ifscCode', 'password', 'passwordHash']);

// ── Write Audit Log ───────────────────────────────────────────────

/**
 * log — record an audit event
 *
 * ALWAYS wraps in try-catch — audit failures must never affect the main operation.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.userId        — actor who performed the action
 * @param {string} params.action        — CREATE | UPDATE | DELETE | LOGIN | RUN_PAYROLL | etc.
 * @param {string} params.entityType    — EMPLOYEE | TENDER | PAYROLL_RUN | etc.
 * @param {string} params.entityId      — ID of the affected record
 * @param {Object} params.oldValues     — values before change (for UPDATE)
 * @param {Object} params.newValues     — values after change
 * @param {Object} params.metadata      — any extra context
 * @param {Object} params.req           — Express request (optional, for IP/UA)
 */
async function log({
  tenantId,
  userId,
  action,
  entityType,
  entityId,
  oldValues  = null,
  newValues  = null,
  metadata   = null,
  req        = null,
}) {
  try {
    const ipAddress = req ? (req.ip || req.connection?.remoteAddress) : null;
    const userAgent = req ? req.headers?.['user-agent'] : null;

    await prisma.auditLog.create({
      data: {
        tenantId,
        userId:     userId || null,
        action,
        entityType,
        entityId:   entityId  || null,
        oldValues:  oldValues ? _maskPII(oldValues)  : undefined,
        newValues:  newValues ? _maskPII(newValues)  : undefined,
        metadata:   metadata  ? metadata              : undefined,
        ipAddress,
        userAgent,
      },
    });
  } catch (err) {
    // NEVER let audit failure propagate — log to console only
    logger.error(`[Audit] Failed to write audit log: ${err.message}`, {
      tenantId, action, entityType, entityId,
    });
  }
}

// ── Read Audit Logs (Admin UI) ────────────────────────────────────

/**
 * getAuditLogs — paginated audit log viewer
 *
 * @param {string} tenantId
 * @param {Object} filters — { entityType, action, userId, entityId, from, to }
 * @param {Object} pagination — { page, limit }
 */
async function getAuditLogs(tenantId, filters = {}, { page = 1, limit = 50 } = {}) {
  const where = { tenantId };

  if (filters.entityType) where.entityType = filters.entityType;
  if (filters.action)     where.action     = filters.action;
  if (filters.userId)     where.userId     = filters.userId;
  if (filters.entityId)   where.entityId   = filters.entityId;

  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = new Date(filters.from);
    if (filters.to)   where.createdAt.lte = new Date(filters.to);
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: {
        user: { select: { name: true, email: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return {
    logs,
    total,
    page:       parseInt(page),
    limit:      take,
    totalPages: Math.ceil(total / take),
  };
}

/**
 * getEntityHistory — all audit events for a specific record
 * e.g. all changes to Employee ID xyz
 */
async function getEntityHistory(tenantId, entityType, entityId) {
  return prisma.auditLog.findMany({
    where:   { tenantId, entityType, entityId },
    include: { user: { select: { name: true, email: true, role: true } } },
    orderBy: { createdAt: 'desc' },
    take:    100, // Cap at 100 for UI
  });
}

/**
 * getRecentActivity — last N actions for a tenant (dashboard widget)
 */
async function getRecentActivity(tenantId, limit = 20) {
  return prisma.auditLog.findMany({
    where:   { tenantId },
    include: { user: { select: { name: true, role: true } } },
    orderBy: { createdAt: 'desc' },
    take:    limit,
    select: {
      id: true, action: true, entityType: true, entityId: true,
      createdAt: true, ipAddress: true,
      user: { select: { name: true, role: true } },
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────

function _maskPII(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const masked = { ...obj };
  for (const key of Object.keys(masked)) {
    if (PII_AUDIT_FIELDS.has(key) && masked[key]) {
      masked[key] = '*** REDACTED ***';
    }
  }
  return masked;
}

// ── Audit Route ───────────────────────────────────────────────────
// Add these to your audit routes file:

function buildAuditRouter() {
  const express    = require('express');
  const router     = express.Router();
  const asyncHandler = require('../utils/asyncHandler');
  const { protect, can } = require('../middleware/auth');
  const { resolveTenant, requireTenant } = require('../middleware/tenant');
  const { requireFeature } = require('../middleware/planGuard');

  router.use(protect, resolveTenant, requireTenant, requireFeature('audit_logs'), can('canViewAuditLog'));

  router.get('/', asyncHandler(async (req, res) => {
    const { entityType, action, userId, entityId, from, to, page, limit } = req.query;
    const result = await getAuditLogs(
      req.tenantId,
      { entityType, action, userId, entityId, from, to },
      { page, limit }
    );
    res.json({ success: true, ...result });
  }));

  router.get('/recent', asyncHandler(async (req, res) => {
    const data = await getRecentActivity(req.tenantId, parseInt(req.query.limit || 20));
    res.json({ success: true, data });
  }));

  router.get('/entity/:entityType/:entityId', asyncHandler(async (req, res) => {
    const data = await getEntityHistory(req.tenantId, req.params.entityType, req.params.entityId);
    res.json({ success: true, data });
  }));

  return router;
}

module.exports = { log, getAuditLogs, getEntityHistory, getRecentActivity, buildAuditRouter };
