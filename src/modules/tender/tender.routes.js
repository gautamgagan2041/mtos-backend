'use strict';

/**
 * tender.routes.js — Complete replacement for src/routes/tenders.js
 *
 * NEW vs old:
 *  1. All Prisma calls moved to service/repository layers
 *  2. GET /:id/profitability  → tender P&L dashboard (NEW)
 *  3. POST /:id/simulate-revision → wage revision impact (NEW)
 *  4. POST /pay-components/validate-formula → formula tester (NEW)
 *  5. POST /:id/employees → add employee to tender (was missing)
 */

const express       = require('express');
const router        = express.Router();
const asyncHandler  = require('../../utils/asyncHandler');
const { protect, can } = require('../../middleware/auth');
const { resolveTenant, requireTenant } = require('../../middleware/tenant');
const { requireFeature } = require('../../middleware/planGuard');
const service       = require('./tender.service');

router.use(protect, resolveTenant, requireTenant);

// ════════════════════════════════════════════════════════════════
// PAY COMPONENTS
// ════════════════════════════════════════════════════════════════

// GET /api/tenders/pay-components/list
router.get('/pay-components/list', asyncHandler(async (req, res) => {
  const data = await service.listPayComponents(req.tenantId);
  res.json({ success: true, data });
}));

// POST /api/tenders/pay-components
router.post('/pay-components', can('canManageTenders'), asyncHandler(async (req, res) => {
  const data = await service.createPayComponent(req.tenantId, req.body, req.user.id);
  res.status(201).json({ success: true, data });
}));

// POST /api/tenders/pay-components/validate-formula ← NEW
router.post('/pay-components/validate-formula', asyncHandler(async (req, res) => {
  const { formula, testValues } = req.body;
  if (!formula) return res.status(400).json({ success: false, message: 'formula is required' });
  const result = service.validateFormula(formula, testValues);
  res.json({ success: true, data: result });
}));

// ════════════════════════════════════════════════════════════════
// SALARY STRUCTURES
// ════════════════════════════════════════════════════════════════

// GET /api/tenders/salary-structures/list
router.get('/salary-structures/list', asyncHandler(async (req, res) => {
  const data = await service.listSalaryStructures(req.tenantId);
  res.json({ success: true, data });
}));

// POST /api/tenders/salary-structures
router.post('/salary-structures', can('canManageTenders'), asyncHandler(async (req, res) => {
  const data = await service.createSalaryStructure(req.tenantId, req.body, req.user.id);
  res.status(201).json({ success: true, data });
}));

// ════════════════════════════════════════════════════════════════
// TENDERS
// ════════════════════════════════════════════════════════════════

// GET /api/tenders
router.get('/', asyncHandler(async (req, res) => {
  const { status, clientId, search } = req.query;
  const data = await service.getTenders(req.tenantId, { status, clientId, search });
  res.json({ success: true, data });
}));

// POST /api/tenders
router.post('/', can('canManageTenders'), asyncHandler(async (req, res) => {
  const data = await service.createTender(req.tenantId, req.body, req.user.id);
  res.status(201).json({ success: true, data });
}));

// GET /api/tenders/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const data = await service.getTender(req.tenantId, req.params.id);
  res.json({ success: true, data });
}));

// PUT /api/tenders/:id
router.put('/:id', can('canManageTenders'), asyncHandler(async (req, res) => {
  const data = await service.updateTender(req.tenantId, req.params.id, req.body, req.user.id);
  res.json({ success: true, data });
}));

// PUT /api/tenders/:id/assign-structure
router.put('/:id/assign-structure', can('canManageTenders'), asyncHandler(async (req, res) => {
  const { salaryStructureId } = req.body;
  const data = await service.assignSalaryStructure(
    req.tenantId, req.params.id, salaryStructureId, req.user.id
  );
  res.json({ success: true, data });
}));

// GET /api/tenders/:id/employees
router.get('/:id/employees', asyncHandler(async (req, res) => {
  const { month, year } = req.query;
  const repo = require('./tender.repository');
  // Verify ownership before fetching
  await service.getTender(req.tenantId, req.params.id);
  const data = await repo.getEmployees(req.params.id, { month, year });
  res.json({ success: true, data });
}));

// POST /api/tenders/:id/employees ← NEW (was missing)
router.post('/:id/employees', can('canManageEmployees'), asyncHandler(async (req, res) => {
  const data = await service.addEmployeeToTender(
    req.tenantId, req.params.id, req.body, req.user.id
  );
  res.status(201).json({ success: true, data });
}));

// GET /api/tenders/:id/payroll-runs
router.get('/:id/payroll-runs', asyncHandler(async (req, res) => {
  const prisma = require('../../config/database');
  // Verify ownership
  await service.getTender(req.tenantId, req.params.id);
  const runs = await prisma.payrollRun.findMany({
    where:   { tenderId: req.params.id },
    include: { runByUser: { select: { name: true } }, _count: { select: { rows: true } } },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
  });
  res.json({ success: true, data: runs });
}));

// ════════════════════════════════════════════════════════════════
// PROFITABILITY & INTELLIGENCE (Your moat)
// ════════════════════════════════════════════════════════════════

// GET /api/tenders/:id/profitability ← NEW
router.get('/:id/profitability', requireFeature('reports_basic'), asyncHandler(async (req, res) => {
  const data = await service.getTenderProfitability(req.tenantId, req.params.id);
  res.json({ success: true, data });
}));

// POST /api/tenders/:id/simulate-revision ← NEW (Manpower Industry Moat)
// Body: { increaseType: 'FIXED_AMOUNT', increaseValue: 500, effectiveFrom: '2026-04-01' }
router.post('/:id/simulate-revision', requireFeature('reports_basic'), asyncHandler(async (req, res) => {
  const data = await service.simulateWageRevision(
    req.tenantId, req.params.id, req.body
  );
  res.json({ success: true, data });
}));

module.exports = router;
