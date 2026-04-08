// src/routes/audit.js
// ── Audit Trail API ───────────────────────────────────────────
// Read-only endpoint for viewing who did what, when.
// Accessible only to SUPER_ADMIN and COMPANY_ADMIN.

const express = require('express');
const { protect, can } = require('../middleware/auth');
const { resolveTenant, requireTenant } = require('../middleware/tenant');
const auditService = require('../services/auditService');
const router = express.Router();

router.use(protect, resolveTenant, requireTenant);

/**
 * GET /api/audit
 * 
 * Query params:
 *   entityType  - filter by entity (EMPLOYEE, PAYROLL_RUN, etc.)
 *   entityId    - filter to a specific record
 *   userId      - filter by who performed the action
 *   action      - filter by AuditAction enum
 *   page        - pagination page (default 1)
 *   limit       - results per page (default 50, max 200)
 */
router.get('/', can('canViewAuditLog'), async (req, res, next) => {
  try {
    const {
      entityType, entityId, userId, action,
      page = 1, limit = 50,
    } = req.query;

    const result = await auditService.getAuditTrail({
      tenantId: req.tenantId,
      entityType,
      entityId,
      userId,
      action,
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 200),
    });

    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

/**
 * GET /api/audit/entity/:type/:id
 * 
 * Get the full audit history for a specific record.
 * e.g. GET /api/audit/entity/EMPLOYEE/uuid
 */
router.get('/entity/:type/:id', can('canViewAuditLog'), async (req, res, next) => {
  try {
    const result = await auditService.getAuditTrail({
      tenantId: req.tenantId,
      entityType: req.params.type,
      entityId: req.params.id,
      page: 1,
      limit: 200,
    });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

/**
 * GET /api/audit/actions
 * 
 * List all possible audit action types (for filter dropdowns).
 */
router.get('/actions', can('canViewAuditLog'), (req, res) => {
  const actions = [
    'CREATE', 'UPDATE', 'DELETE',
    'LOGIN', 'LOGOUT', 'PASSWORD_CHANGE',
    'PAYROLL_RUN', 'PAYROLL_LOCK',
    'INVOICE_GENERATE',
    'DOCUMENT_UPLOAD', 'DOCUMENT_DELETE',
    'EMPLOYEE_EXIT', 'EMPLOYEE_REPLACE',
    'COMPLIANCE_RESOLVE',
  ];
  res.json({ success: true, data: actions });
});

module.exports = router;
