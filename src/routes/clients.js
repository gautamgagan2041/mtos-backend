// src/routes/clients.js
const express = require('express');
const prisma = require('../config/database');
const { protect, can, requireTenant } = require('../middleware/auth');
const audit = require('../services/auditService');
const router = express.Router();

router.use(protect, requireTenant);

router.get('/', async (req, res, next) => {
  try {
    const clients = await prisma.client.findMany({
      where: { tenantId: req.tenantId, isActive: true },
      include: { _count: { select: { tenders: true } } },
      orderBy: { name: 'asc' },
    });
    res.json({ success: true, data: clients });
  } catch (err) { next(err); }
});

router.post('/', can('canManageClients'), async (req, res, next) => {
  try {
    const client = await prisma.client.create({
      data: { ...req.body, tenantId: req.tenantId },
    });
    await audit.log({
      tenantId: req.tenantId, userId: req.user.id,
      action: 'CREATE', entityType: 'CLIENT', entityId: client.id,
      newValues: client, req,
    });
    res.status(201).json({ success: true, data: client });
  } catch (err) { next(err); }
});

router.put('/:id', can('canManageClients'), async (req, res, next) => {
  try {
    const existing = await prisma.client.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
    if (!existing) return res.status(404).json({ success: false, message: 'Client not found' });

    const client = await prisma.client.update({ where: { id: req.params.id }, data: req.body });
    await audit.log({
      tenantId: req.tenantId, userId: req.user.id,
      action: 'UPDATE', entityType: 'CLIENT', entityId: client.id,
      oldValues: existing, newValues: client, req,
    });
    res.json({ success: true, data: client });
  } catch (err) { next(err); }
});

router.delete('/:id', can('canManageClients'), async (req, res, next) => {
  try {
    const existing = await prisma.client.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
    if (!existing) return res.status(404).json({ success: false, message: 'Client not found' });

    await prisma.client.update({ where: { id: req.params.id }, data: { isActive: false } });
    await prisma.tender.updateMany({
      where: { clientId: req.params.id, tenantId: req.tenantId },
      data: { status: 'TERMINATED' },
    });
    await audit.log({
      tenantId: req.tenantId, userId: req.user.id,
      action: 'DELETE', entityType: 'CLIENT', entityId: req.params.id, req,
    });
    res.json({ success: true, message: 'Client deactivated' });
  } catch (err) { next(err); }
});

module.exports = router;