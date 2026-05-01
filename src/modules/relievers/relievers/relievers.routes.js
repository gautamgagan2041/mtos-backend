'use strict';

// ═══════════════════════════════════════════════════════════════════
// relievers.routes.js
// ═══════════════════════════════════════════════════════════════════

const express       = require('express');
const router        = express.Router();
const asyncHandler  = require('../../utils/asyncHandler');
const { protect, can } = require('../../middleware/auth');
const { resolveTenant, requireTenant } = require('../../middleware/tenant');
const service       = require('./relievers.service');

router.use(protect, resolveTenant, requireTenant);

// GET /api/relievers?specialization=Security&city=Pune&available=true
router.get('/', asyncHandler(async (req, res) => {
  const data = await service.getPool(req.tenantId, req.query);
  res.json({ success: true, data });
}));

// POST /api/relievers  — add employee to pool
router.post('/', can('canManageEmployees'), asyncHandler(async (req, res) => {
  const data = await service.addToPool(req.tenantId, req.body);
  res.status(201).json({ success: true, data });
}));

// GET /api/relievers/find?specialization=Security&city=Pune&count=2
router.get('/find', asyncHandler(async (req, res) => {
  const { specialization, city, count } = req.query;
  const data = await service.findAvailableRelievers(req.tenantId, {
    specialization, city, count: parseInt(count || 1),
  });
  res.json({ success: true, data });
}));

// POST /api/relievers/:id/deploy
router.post('/:id/deploy', can('canManageEmployees'), asyncHandler(async (req, res) => {
  const data = await service.deployReliever(req.tenantId, req.params.id, {
    ...req.body, deployedBy: req.user.id,
  });
  res.json({ success: true, data, message: 'Reliever deployed successfully' });
}));

// POST /api/relievers/:id/return
router.post('/:id/return', can('canManageEmployees'), asyncHandler(async (req, res) => {
  const data = await service.returnToPool(req.tenantId, req.params.id, req.body);
  res.json({ success: true, data, message: 'Reliever returned to pool' });
}));

// DELETE /api/relievers/:id
router.delete('/:id', can('canManageEmployees'), asyncHandler(async (req, res) => {
  await service.removeFromPool(req.tenantId, req.params.id);
  res.json({ success: true, message: 'Removed from reliever pool' });
}));

module.exports = router;
