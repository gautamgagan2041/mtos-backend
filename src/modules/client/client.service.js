'use strict';

// ═══════════════════════════════════════════════════════════════════
// client.service.js
// ═══════════════════════════════════════════════════════════════════

const repo  = require('./client.repository');
const audit = require('../../services/auditService');

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

async function getClients(tenantId, query) {
  return repo.findAll(tenantId, query);
}

async function getClient(tenantId, id) {
  const client = await repo.findById(id, tenantId);
  if (!client) { const e = new Error('Client not found'); e.statusCode = 404; throw e; }
  return client;
}

async function createClient(tenantId, data, actorUserId) {
  // Normalize
  if (data.gstin) {
    data.gstin = data.gstin.toUpperCase().trim();
    if (!GSTIN_RE.test(data.gstin)) {
      const e = new Error(`Invalid GSTIN format: ${data.gstin}`); e.statusCode = 400; throw e;
    }
    const existing = await repo.findByGSTIN(tenantId, data.gstin);
    if (existing) {
      const e = new Error(`A client with GSTIN ${data.gstin} already exists: ${existing.name}`);
      e.statusCode = 409; throw e;
    }
  }

  const client = await repo.create(tenantId, data);
  await audit.log({
    tenantId, userId: actorUserId,
    action: 'CREATE', entityType: 'CLIENT', entityId: client.id,
    newValues: { name: client.name, gstin: client.gstin },
  });
  return client;
}

async function updateClient(tenantId, id, data, actorUserId) {
  const existing = await getClient(tenantId, id);

  if (data.gstin && data.gstin !== existing.gstin) {
    data.gstin = data.gstin.toUpperCase().trim();
    if (!GSTIN_RE.test(data.gstin)) {
      const e = new Error(`Invalid GSTIN: ${data.gstin}`); e.statusCode = 400; throw e;
    }
    const conflict = await repo.findByGSTIN(tenantId, data.gstin);
    if (conflict && conflict.id !== id) {
      const e = new Error(`GSTIN ${data.gstin} is already used by ${conflict.name}`);
      e.statusCode = 409; throw e;
    }
  }

  const client = await repo.update(id, tenantId, data);
  await audit.log({
    tenantId, userId: actorUserId,
    action: 'UPDATE', entityType: 'CLIENT', entityId: id,
    oldValues: { name: existing.name, state: existing.state },
    newValues:  { name: client.name,  state: client.state  },
  });
  return client;
}

async function deactivateClient(tenantId, id, actorUserId) {
  const existing = await getClient(tenantId, id);

  // Guard: cannot deactivate client with active invoices
  const prisma = require('../../config/database');
  const pendingInvoices = await prisma.invoice.count({
    where: { tender: { clientId: id }, status: { in: ['DRAFT', 'SENT'] } },
  });
  if (pendingInvoices > 0) {
    const e = new Error(
      `Cannot deactivate client "${existing.name}" — ${pendingInvoices} pending invoice(s) exist. ` +
      'Settle or cancel all invoices first.'
    );
    e.statusCode = 409; throw e;
  }

  await repo.deactivate(id, tenantId);
  await audit.log({
    tenantId, userId: actorUserId,
    action: 'DELETE', entityType: 'CLIENT', entityId: id,
    oldValues: { name: existing.name },
  });
  return { deactivated: true, terminatedTenders: true };
}

module.exports = { getClients, getClient, createClient, updateClient, deactivateClient };

// ═══════════════════════════════════════════════════════════════════
// client.routes.js  (export separately in real project)
// ═══════════════════════════════════════════════════════════════════

const express      = require('express');
const router       = express.Router();
const asyncHandler = require('../../utils/asyncHandler');
const { protect, can } = require('../../middleware/auth');
const { resolveTenant, requireTenant } = require('../../middleware/tenant');
const service      = module.exports; // self-ref for inline routes

const clientService = { getClients, getClient, createClient, updateClient, deactivateClient };

router.use(protect, resolveTenant, requireTenant);

router.get('/', asyncHandler(async (req, res) => {
  const data = await clientService.getClients(req.tenantId, req.query);
  res.json({ success: true, data });
}));

router.post('/', can('canManageClients'), asyncHandler(async (req, res) => {
  const data = await clientService.createClient(req.tenantId, req.body, req.user.id);
  res.status(201).json({ success: true, data });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const data = await clientService.getClient(req.tenantId, req.params.id);
  res.json({ success: true, data });
}));

router.put('/:id', can('canManageClients'), asyncHandler(async (req, res) => {
  const data = await clientService.updateClient(req.tenantId, req.params.id, req.body, req.user.id);
  res.json({ success: true, data });
}));

router.delete('/:id', can('canManageClients'), asyncHandler(async (req, res) => {
  const data = await clientService.deactivateClient(req.tenantId, req.params.id, req.user.id);
  res.json({ success: true, data, message: 'Client deactivated. All active tenders terminated.' });
}));

// Dedicated export for routes file
module.exports.router = router;
