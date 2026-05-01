'use strict';

const express      = require('express');
const router       = express.Router();
const asyncHandler = require('../../utils/asyncHandler');
const { protect, can, isCompanyAdmin } = require('../../middleware/auth');
const { resolveTenant, requireTenant } = require('../../middleware/tenant');
const service = require('./users.service');

router.use(protect, resolveTenant, requireTenant);

// GET /api/users
router.get('/', can('canManageUsers'), asyncHandler(async (req, res) => {
  const data = await service.getUsers(req.tenantId);
  res.json({ success: true, data });
}));

// POST /api/users/invite
router.post('/invite', can('canManageUsers'), asyncHandler(async (req, res) => {
  const data = await service.inviteUser(req.tenantId, req.body, req.user.id, req.tenant);
  res.status(201).json({ success: true, data, message: 'User invited. Login credentials sent by email.' });
}));

// PUT /api/users/:id/role
router.put('/:id/role', can('canManageUsers'), asyncHandler(async (req, res) => {
  const data = await service.updateUserRole(req.tenantId, req.params.id, req.body.role, req.user.id);
  res.json({ success: true, data });
}));

// DELETE /api/users/:id
router.delete('/:id', can('canManageUsers'), asyncHandler(async (req, res) => {
  const data = await service.deactivateUser(req.tenantId, req.params.id, req.user.id);
  res.json({ success: true, data });
}));

// POST /api/users/change-password (self-service)
router.post('/change-password', asyncHandler(async (req, res) => {
  const data = await service.changePassword(req.user.id, req.body);
  res.json({ success: true, data, message: 'Password changed successfully' });
}));

// POST /api/users/tender-permissions
router.post('/tender-permissions', can('canManageUsers'), asyncHandler(async (req, res) => {
  const data = await service.setTenderPermission(req.tenantId, req.body, req.user.id);
  res.json({ success: true, data });
}));

// GET /api/users/me/permissions — returns own role's permission list
router.get('/me/permissions', asyncHandler(async (req, res) => {
  const { getUserPermissions } = require('../../middleware/auth');
  const permissions = getUserPermissions(req.user.role);
  res.json({ success: true, data: { role: req.user.role, permissions } });
}));

module.exports = router;
