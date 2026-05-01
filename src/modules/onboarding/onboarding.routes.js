'use strict';

// ═══════════════════════════════════════════════════════════════════
// onboarding.routes.js
// ═══════════════════════════════════════════════════════════════════

const express      = require('express');
const router       = express.Router();
const asyncHandler = require('../../utils/asyncHandler');
const { protect }  = require('../../middleware/auth');
const { resolveTenant, requireTenant } = require('../../middleware/tenant');
const service      = require('./onboarding.service');

// POST /api/onboarding/register — public, no auth needed
router.post('/register', asyncHandler(async (req, res) => {
  const data = await service.registerCompany(req.body);
  res.status(201).json({ success: true, data });
}));

// POST /api/onboarding/setup — requires login
router.post('/setup', protect, resolveTenant, requireTenant, asyncHandler(async (req, res) => {
  const data = await service.completeSetup(req.tenantId, req.body, req.user.id);
  res.json({ success: true, data });
}));

// GET /api/onboarding/progress — setup checklist
router.get('/progress', protect, resolveTenant, requireTenant, asyncHandler(async (req, res) => {
  const data = await service.getProgress(req.tenantId);
  res.json({ success: true, data });
}));

module.exports = router;
