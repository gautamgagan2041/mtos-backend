'use strict';

/**
 * client.routes.js — standalone route file for client module
 */

const express      = require('express');
const router       = express.Router();
const asyncHandler = require('../../utils/asyncHandler');
const { protect, can } = require('../../middleware/auth');
const { resolveTenant, requireTenant } = require('../../middleware/tenant');
const service      = require('./client.service');

router.use(protect, resolveTenant, requireTenant);

// GET /api/clients?search=&isActive=true
router.get('/', asyncHandler(async (req, res) => {
  const data = await service.getClients(req.tenantId, req.query);
  res.json({ success: true, data });
}));

// POST /api/clients
router.post('/', can('canManageClients'), asyncHandler(async (req, res) => {
  const data = await service.createClient(req.tenantId, req.body, req.user.id);
  res.status(201).json({ success: true, data });
}));

// GET /api/clients/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const data = await service.getClient(req.tenantId, req.params.id);
  res.json({ success: true, data });
}));

// PUT /api/clients/:id
router.put('/:id', can('canManageClients'), asyncHandler(async (req, res) => {
  const data = await service.updateClient(req.tenantId, req.params.id, req.body, req.user.id);
  res.json({ success: true, data });
}));

// DELETE /api/clients/:id
router.delete('/:id', can('canManageClients'), asyncHandler(async (req, res) => {
  const data = await service.deactivateClient(req.tenantId, req.params.id, req.user.id);
  res.json({ success: true, data, message: 'Client deactivated. All active tenders terminated.' });
}));

module.exports = router;
