'use strict';

/**
 * apiKey.routes.js — Two route groups:
 *
 * 1. /api/developer/* — manage API keys (BUSINESS+ plan required)
 * 2. /api/v1/*        — public REST API (authenticated via API key)
 *
 * This allows third-party apps to integrate with MTOS using API keys.
 */

const express      = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const { protect }  = require('../../middleware/auth');
const { resolveTenant, requireTenant } = require('../../middleware/tenant');
const { requireFeature } = require('../../middleware/planGuard');
const {
  createApiKey, listApiKeys, revokeApiKey,
  authenticateApiKey, requireScope, VALID_SCOPES,
} = require('./apiKey.service');
const prisma = require('../../config/database');
const { decryptPII, maskPII } = require('../../utils/encryption');

// ── DEVELOPER PORTAL — Manage API Keys ───────────────────────────

const developerRouter = express.Router();
developerRouter.use(protect, resolveTenant, requireTenant, requireFeature('api_access'));

// GET /api/developer/keys
developerRouter.get('/keys', asyncHandler(async (req, res) => {
  const data = await listApiKeys(req.tenantId);
  res.json({ success: true, data });
}));

// POST /api/developer/keys
// Body: { name, scopes: ['employees:read', 'payroll:read'], ipWhitelist: [], expiresAt }
developerRouter.post('/keys', asyncHandler(async (req, res) => {
  const data = await createApiKey(req.tenantId, req.body, req.user.id);
  res.status(201).json({ success: true, data });
}));

// DELETE /api/developer/keys/:id
developerRouter.delete('/keys/:id', asyncHandler(async (req, res) => {
  const data = await revokeApiKey(req.tenantId, req.params.id);
  res.json({ success: true, data });
}));

// GET /api/developer/scopes — list all valid scopes
developerRouter.get('/scopes', (req, res) => {
  res.json({ success: true, data: VALID_SCOPES });
});

// ── PUBLIC API v1 — For Third-Party Integrations ─────────────────

const publicApiRouter = express.Router();

// All public API routes: accept EITHER JWT (protect) OR API key (authenticateApiKey)
publicApiRouter.use(authenticateApiKey);

// ── Employees (read-only via API) ─────────────────────────────────

// GET /api/v1/employees
publicApiRouter.get('/employees',
  requireScope('employees:read'),
  asyncHandler(async (req, res) => {
    const { status = 'ACTIVE', page = 1, limit = 100 } = req.query;
    const employees = await prisma.employee.findMany({
      where:   { tenantId: req.tenantId, status },
      select: {
        id: true, sr: true, name: true, uan: true, esicNumber: true,
        status: true, phone: true,
        tenderAssignments: {
          where:   { isActive: true },
          include: { tender: { select: { name: true, code: true } } },
        },
      },
      orderBy: { sr: 'asc' },
      skip:    (parseInt(page) - 1) * Math.min(parseInt(limit), 200),
      take:    Math.min(parseInt(limit), 200),
    });
    res.json({ success: true, count: employees.length, data: employees });
  })
);

// GET /api/v1/employees/:id
publicApiRouter.get('/employees/:id',
  requireScope('employees:read'),
  asyncHandler(async (req, res) => {
    const emp = await prisma.employee.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
    // Mask PII for API consumers
    res.json({ success: true, data: maskPII(decryptPII(emp)) });
  })
);

// POST /api/v1/attendance — write attendance from device/app
publicApiRouter.post('/attendance',
  requireScope('attendance:write'),
  asyncHandler(async (req, res) => {
    const { tenderEmployeeId, month, year, presentDays, otHours } = req.body;
    if (!tenderEmployeeId || !month || !year) {
      return res.status(400).json({ success: false, message: 'tenderEmployeeId, month, year required' });
    }

    // Verify ownership before writing
    const te = await prisma.tenderEmployee.findFirst({
      where:   { id: tenderEmployeeId },
      include: { tender: { select: { tenantId: true } } },
    });
    if (!te || te.tender.tenantId !== req.tenantId) {
      return res.status(404).json({ success: false, message: 'Tender employee not found' });
    }

    const record = await prisma.attendance.upsert({
      where: {
        tenderEmployeeId_month_year: {
          tenderEmployeeId, month: parseInt(month), year: parseInt(year),
        },
      },
      update: { presentDays: parseInt(presentDays) || 0, otHours: parseFloat(otHours) || 0 },
      create: {
        tenantId: req.tenantId,
        tenderEmployeeId,
        month:    parseInt(month),
        year:     parseInt(year),
        presentDays: parseInt(presentDays) || 0,
        otHours:     parseFloat(otHours)  || 0,
      },
    });

    res.json({ success: true, data: record });
  })
);

// GET /api/v1/payroll/:runId — payroll run summary
publicApiRouter.get('/payroll/:runId',
  requireScope('payroll:read'),
  asyncHandler(async (req, res) => {
    const run = await prisma.payrollRun.findFirst({
      where: { id: req.params.runId, tenantId: req.tenantId },
      select: {
        id: true, month: true, year: true, status: true,
        totalGross: true, totalNet: true, totalPFEE: true,
        totalPFER: true, totalESIC: true, totalPT: true,
        _count: { select: { rows: true } },
      },
    });
    if (!run) return res.status(404).json({ success: false, message: 'Payroll run not found' });
    res.json({ success: true, data: run });
  })
);

// GET /api/v1/reports/summary?month=4&year=2026
publicApiRouter.get('/reports/summary',
  requireScope('reports:read'),
  asyncHandler(async (req, res) => {
    const { month, year } = req.query;
    if (!month || !year) return res.status(400).json({ success: false, message: 'month and year required' });
    const { payrollSummary } = require('../reports/reports.service');
    const data = await payrollSummary(req.tenantId, month, year);
    res.json({ success: true, data });
  })
);

module.exports = { developerRouter, publicApiRouter };
