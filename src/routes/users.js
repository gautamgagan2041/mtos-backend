// src/routes/users.js
const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../config/database');
const { protect, can } = require('../middleware/auth');
const { resolveTenant, requireTenant } = require('../middleware/tenant');
const audit = require('../services/auditService');
const router = express.Router();

router.use(protect, resolveTenant, requireTenant);

// GET all users in this tenant
router.get('/', can('canManageUsers'), async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where: { tenantId: req.tenantId },
      select: {
        id: true, name: true, email: true, role: true,
        phone: true, isActive: true, lastLogin: true, lastIp: true, createdAt: true,
      },
      orderBy: { name: 'asc' },
    });
    res.json({ success: true, data: users });
  } catch (err) { next(err); }
});

// POST create user in this tenant
router.post('/', can('canManageUsers'), async (req, res, next) => {
  try {
    const { name, email, password, role, phone } = req.body;
    if (!password || password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    const hash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { name, email: email.toLowerCase(), passwordHash: hash, role, phone, tenantId: req.tenantId },
      select: { id: true, name: true, email: true, role: true, phone: true, isActive: true },
    });

    await audit.log({
      tenantId: req.tenantId, userId: req.user.id,
      action: 'CREATE', entityType: 'USER', entityId: user.id,
      newValues: { name, email, role }, req,
    });

    res.status(201).json({ success: true, data: user });
  } catch (err) { next(err); }
});

// PUT update user
router.put('/:id', can('canManageUsers'), async (req, res, next) => {
  try {
    const existing = await prisma.user.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!existing) return res.status(404).json({ success: false, message: 'User not found' });

    const { password, ...data } = req.body;
    if (password) {
      if (password.length < 8) return res.status(400).json({ success: false, message: 'Password too short' });
      data.passwordHash = await bcrypt.hash(password, 12);
    }

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data,
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });

    await audit.log({
      tenantId: req.tenantId, userId: req.user.id,
      action: 'UPDATE', entityType: 'USER', entityId: user.id,
      oldValues: { role: existing.role, isActive: existing.isActive },
      newValues: { role: user.role, isActive: user.isActive }, req,
    });

    res.json({ success: true, data: user });
  } catch (err) { next(err); }
});

// DELETE / deactivate user
router.delete('/:id', can('canManageUsers'), async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ success: false, message: 'You cannot deactivate yourself' });
    }
    const existing = await prisma.user.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
    if (!existing) return res.status(404).json({ success: false, message: 'User not found' });

    await prisma.user.update({ where: { id: req.params.id }, data: { isActive: false } });

    await audit.log({
      tenantId: req.tenantId, userId: req.user.id,
      action: 'DELETE', entityType: 'USER', entityId: req.params.id,
      oldValues: { name: existing.name, email: existing.email }, req,
    });

    res.json({ success: true, message: 'User deactivated' });
  } catch (err) { next(err); }
});

module.exports = router;
