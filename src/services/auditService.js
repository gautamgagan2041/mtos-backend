// src/services/auditService.js
// ── Audit Log Service ─────────────────────────────────────────
// Records every sensitive action with before/after values.
// Called from routes directly — never blocks the response.

const prisma = require('../config/database');
const logger = require('../utils/logger');

/**
 * log(options)
 * 
 * Fire-and-forget audit logger. Errors are swallowed — audit
 * failures should never break the main operation.
 * 
 * @param {object} options
 * @param {string} options.tenantId   - Tenant context (null for platform actions)
 * @param {string} options.userId     - User who performed the action
 * @param {string} options.action     - AuditAction enum value
 * @param {string} options.entityType - e.g. 'EMPLOYEE', 'PAYROLL_RUN'
 * @param {string} [options.entityId] - ID of the affected record
 * @param {object} [options.oldValues]- State before the change
 * @param {object} [options.newValues]- State after the change
 * @param {object} [options.metadata] - Any extra context
 * @param {object} [options.req]      - Express req object for IP/UA
 */
async function log({ tenantId, userId, action, entityType, entityId, oldValues, newValues, metadata, req }) {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: tenantId || null,
        userId,
        action,
        entityType,
        entityId: entityId || null,
        oldValues: oldValues ? sanitize(oldValues) : undefined,
        newValues: newValues ? sanitize(newValues) : undefined,
        metadata: metadata || undefined,
        ipAddress: req ? getIP(req) : null,
        userAgent: req ? (req.headers['user-agent'] || null) : null,
      },
    });
  } catch (err) {
    // Never throw — audit failures must not break business operations
    logger.error('Audit log write failed:', err.message);
  }
}

/**
 * sanitize — strip sensitive fields before storing
 */
function sanitize(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const REDACTED = ['passwordHash', 'password', 'aadhaar', 'pan', 'bankAccount'];
  const result = { ...obj };
  REDACTED.forEach(key => {
    if (result[key] !== undefined) result[key] = '[REDACTED]';
  });
  return result;
}

function getIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    null
  );
}

/**
 * getAuditTrail — fetch paginated audit log for a tenant
 */
async function getAuditTrail({ tenantId, entityType, entityId, userId, action, page = 1, limit = 50 }) {
  const where = {
    ...(tenantId && { tenantId }),
    ...(entityType && { entityType }),
    ...(entityId && { entityId }),
    ...(userId && { userId }),
    ...(action && { action }),
  };

  const [total, logs] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return { logs, total, page, limit, pages: Math.ceil(total / limit) };
}

module.exports = { log, getAuditTrail };
