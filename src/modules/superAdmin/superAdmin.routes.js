'use strict';

/**
 * superAdmin.routes.js — All routes require SUPER_ADMIN role.
 * These are platform-level operations across ALL tenants.
 */

const express      = require('express');
const router       = express.Router();
const asyncHandler = require('../../utils/asyncHandler');
const { protect, isSuperAdmin } = require('../../middleware/auth');
const service      = require('./superAdmin.service');

// All super admin routes require authentication + SUPER_ADMIN role
router.use(protect, isSuperAdmin);

// ── Platform Overview ─────────────────────────────────────────────

// GET /api/super/stats
router.get('/stats', asyncHandler(async (req, res) => {
  const data = await service.getPlatformStats();
  res.json({ success: true, data });
}));

// GET /api/super/health
router.get('/health', asyncHandler(async (req, res) => {
  const data = await service.getSystemHealth();
  res.status(data.status === 'healthy' ? 200 : 503).json({ success: true, data });
}));

// ── Tenant Management ─────────────────────────────────────────────

// GET /api/super/tenants?status=ACTIVE&plan=STARTER&page=1&limit=50
router.get('/tenants', asyncHandler(async (req, res) => {
  const data = await service.listTenants(req.query);
  res.json({ success: true, ...data });
}));

// GET /api/super/tenants/:tenantId
router.get('/tenants/:tenantId', asyncHandler(async (req, res) => {
  const data = await service.getTenantDetail(req.params.tenantId);
  res.json({ success: true, data });
}));

// POST /api/super/tenants/:tenantId/impersonate
// Returns short-lived JWT as if you are that tenant's admin
router.post('/tenants/:tenantId/impersonate', asyncHandler(async (req, res) => {
  const data = await service.generateImpersonationToken(req.user.id, req.params.tenantId);
  res.json({ success: true, data });
}));

// PUT /api/super/tenants/:tenantId/plan
// Body: { plan: 'BUSINESS', maxEmployees: 500, reason: 'Sales deal Q2' }
router.put('/tenants/:tenantId/plan', asyncHandler(async (req, res) => {
  const data = await service.overridePlan(req.params.tenantId, req.body, req.user.id);
  res.json({ success: true, data });
}));

// POST /api/super/tenants/:tenantId/suspend
// Body: { reason: 'Non-payment after 30 days' }
router.post('/tenants/:tenantId/suspend', asyncHandler(async (req, res) => {
  if (!req.body.reason) {
    return res.status(400).json({ success: false, message: 'reason is required for suspension' });
  }
  const data = await service.suspendTenant(req.params.tenantId, req.body.reason, req.user.id);
  res.json({ success: true, data });
}));

// POST /api/super/tenants/:tenantId/reactivate
router.post('/tenants/:tenantId/reactivate', asyncHandler(async (req, res) => {
  const data = await service.reactivateTenant(req.params.tenantId, req.user.id);
  res.json({ success: true, data });
}));

// ── Maintenance ───────────────────────────────────────────────────

// POST /api/super/maintenance/cleanup-trials
router.post('/maintenance/cleanup-trials', asyncHandler(async (req, res) => {
  const data = await service.cleanupExpiredTrials();
  res.json({ success: true, data });
}));

module.exports = router;
