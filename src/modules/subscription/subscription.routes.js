'use strict';

const express      = require('express');
const router       = express.Router();
const asyncHandler = require('../../utils/asyncHandler');
const { protect }  = require('../../middleware/auth');
const { resolveTenant, requireTenant } = require('../../middleware/tenant');
const service      = require('./subscription.service');

// GET /api/subscription  — current plan + usage info
router.get('/', protect, resolveTenant, requireTenant, asyncHandler(async (req, res) => {
  const data = await service.getSubscription(req.tenantId);
  res.json({ success: true, data });
}));

// POST /api/subscription/create — initiate Razorpay subscription
// Body: { plan: 'PROFESSIONAL', billingCycle: 'MONTHLY', contactName, contactEmail }
router.post('/create', protect, resolveTenant, requireTenant, asyncHandler(async (req, res) => {
  // Only COMPANY_ADMIN can change billing
  if (!['COMPANY_ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Only company admin can change subscription' });
  }
  const data = await service.createSubscription(req.tenantId, req.body);
  res.status(201).json({ success: true, data });
}));

// POST /api/subscription/cancel
router.post('/cancel', protect, resolveTenant, requireTenant, asyncHandler(async (req, res) => {
  if (!['COMPANY_ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Only company admin can cancel subscription' });
  }
  const data = await service.cancelSubscription(req.tenantId, req.body.reason);
  res.json({ success: true, data });
}));

// NOTE: POST /api/subscription/webhook is registered in index.js
// BEFORE body-parser (needs raw body for signature verification)

module.exports = router;
