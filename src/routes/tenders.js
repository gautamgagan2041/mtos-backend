// src/routes/tenders.js
const express = require('express');
const prisma = require('../config/database');
const { protect, can } = require('../middleware/auth');
const { resolveTenant, requireTenant } = require('../middleware/tenant');
const audit = require('../services/auditService');
const { validate, schemas } = require('../middleware/validate');
const router = express.Router();

router.use(protect, resolveTenant, requireTenant);

// ── STATIC ROUTES PEHLE ──────────────────────────────────────────

router.get('/salary-structures/list', async (req, res, next) => {
  try {
    const structures = await prisma.salaryStructure.findMany({
      where: { tenantId: req.tenantId, isActive: true },
      include: {
        components: {
          where: { isActive: true },
          include: { component: true },
          orderBy: { component: { displayOrder: 'asc' } },
        },
      },
      orderBy: { name: 'asc' },
    });
    res.json({ success: true, data: structures });
  } catch (err) { next(err); }
});

router.get('/pay-components/list', async (req, res, next) => {
  try {
    const components = await prisma.payComponent.findMany({
      where: { tenantId: req.tenantId, isActive: true },
      orderBy: [{ type: 'asc' }, { displayOrder: 'asc' }],
    });
    res.json({ success: true, data: components });
  } catch (err) { next(err); }
});

router.post('/salary-structures', can('canManageTenders'), async (req, res, next) => {
  try {
    const { name, description, components } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Name required' });

    const structure = await prisma.salaryStructure.create({
      data: {
        tenantId: req.tenantId,
        name,
        description,
        components: components ? {
          create: components.map(c => ({
            componentId:     c.componentId,
            calculationType: c.calculationType,
            value:           c.value || null,
            formula:         c.formula || null,
            threshold:       c.threshold || null,
            thresholdBonus:  c.thresholdBonus || null,
          })),
        } : undefined,
      },
      include: { components: { include: { component: true } } },
    });

    res.status(201).json({ success: true, data: structure });
  } catch (err) { next(err); }
});

// ── COLLECTION ROUTES ─────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const tenders = await prisma.tender.findMany({
      where: { tenantId: req.tenantId },
      include: {
        client: { select: { id: true, name: true, shortName: true } },
        legacySalaryStructures: true,
        _count: { select: { employees: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: tenders });
  } catch (err) { next(err); }
});

router.post('/', can('canManageTenders'), validate(schemas.createTender), async (req, res, next) => {
  try {
    const { salaryStructures, ...tenderData } = req.body;
    const tender = await prisma.tender.create({
      data: {
        ...tenderData,
        tenantId: req.tenantId,
        startDate: new Date(tenderData.startDate),
        endDate: new Date(tenderData.endDate),
        legacySalaryStructures: salaryStructures ? { create: salaryStructures } : undefined,
      },
      include: { legacySalaryStructures: true, client: true },
    });
    await audit.log({
      tenantId: req.tenantId, userId: req.user.id,
      action: 'CREATE', entityType: 'TENDER', entityId: tender.id,
      newValues: { name: tender.name, code: tender.code }, req,
    });
    res.status(201).json({ success: true, data: tender });
  } catch (err) { next(err); }
});

// ── DYNAMIC /:id ROUTES ───────────────────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const tender = await prisma.tender.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      include: {
        client: true,
        legacySalaryStructures: true,
        salaryStructure: {
          include: {
            components: {
              where: { isActive: true },
              include: { component: true },
            },
          },
        },
        employees: { where: { isActive: true }, include: { employee: true } },
        _count: { select: { employees: true, payrollRuns: true } },
      },
    });
    if (!tender) return res.status(404).json({ success: false, message: 'Tender not found' });
    res.json({ success: true, data: tender });
  } catch (err) { next(err); }
});

router.put('/:id', can('canManageTenders'), async (req, res, next) => {
  try {
    const existing = await prisma.tender.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
    if (!existing) return res.status(404).json({ success: false, message: 'Tender not found' });

    const { salaryStructures, ...tenderData } = req.body;
    const tender = await prisma.tender.update({
      where: { id: req.params.id },
      data: {
        ...tenderData,
        startDate: tenderData.startDate ? new Date(tenderData.startDate) : undefined,
        endDate: tenderData.endDate ? new Date(tenderData.endDate) : undefined,
      },
    });
    await audit.log({
      tenantId: req.tenantId, userId: req.user.id,
      action: 'UPDATE', entityType: 'TENDER', entityId: tender.id,
      oldValues: { name: existing.name, status: existing.status },
      newValues: { name: tender.name, status: tender.status }, req,
    });
    res.json({ success: true, data: tender });
  } catch (err) { next(err); }
});

router.put('/:id/salary-structure', can('canRunPayroll'), async (req, res, next) => {
  try {
    const tender = await prisma.tender.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
    if (!tender) return res.status(404).json({ success: false, message: 'Tender not found' });

    const { rank, ...structData } = req.body;
    const structure = await prisma.tenderSalaryStructure.upsert({
      where: { tenderId_rank: { tenderId: req.params.id, rank } },
      update: structData,
      create: { tenderId: req.params.id, rank, ...structData },
    });
    res.json({ success: true, data: structure });
  } catch (err) { next(err); }
});

router.put('/:id/assign-structure', can('canManageTenders'), async (req, res, next) => {
  try {
    const tender = await prisma.tender.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } });
    if (!tender) return res.status(404).json({ success: false, message: 'Tender not found' });

    const { salaryStructureId } = req.body;
    if (salaryStructureId) {
      const structure = await prisma.salaryStructure.findFirst({
        where: { id: salaryStructureId, tenantId: req.tenantId },
      });
      if (!structure) return res.status(404).json({ success: false, message: 'Salary structure not found' });
    }

    const updated = await prisma.tender.update({
      where: { id: req.params.id },
      data: { salaryStructureId: salaryStructureId || null },
      include: {
        salaryStructure: {
          include: { components: { where: { isActive: true }, include: { component: true } } },
        },
      },
    });

    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

router.get('/:id/employees', async (req, res, next) => {
  try {
    const { month, year } = req.query;
    const employees = await prisma.tenderEmployee.findMany({
      where: { tenderId: req.params.id, isActive: true },
      include: {
        employee: true,
        attendance: month && year ? { where: { month: parseInt(month), year: parseInt(year) } } : false,
      },
      orderBy: { employee: { sr: 'asc' } },
    });
    res.json({ success: true, data: employees });
  } catch (err) { next(err); }
});

router.get('/:id/payroll-runs', async (req, res, next) => {
  try {
    const runs = await prisma.payrollRun.findMany({
      where: { tenderId: req.params.id },
      include: { runByUser: { select: { name: true } }, _count: { select: { rows: true } } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
    res.json({ success: true, data: runs });
  } catch (err) { next(err); }
});

module.exports = router;
