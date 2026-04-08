// src/routes/reports.js
const express = require('express');
const prisma = require('../config/database');
const { protect, can } = require('../middleware/auth');
const { resolveTenant, requireTenant } = require('../middleware/tenant');
const router = express.Router();

router.use(protect, resolveTenant, requireTenant);

router.get('/payroll-summary', can('canViewReports'), async (req, res, next) => {
  try {
    const { year } = req.query;
    const runs = await prisma.payrollRun.findMany({
      where: {
        tender: { tenantId: req.tenantId },
        ...(year && { year: parseInt(year) }),
        status: { not: 'DRAFT' },
      },
      include: { tender: { select: { name: true, code: true } } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
    res.json({ success: true, data: runs });
  } catch (err) { next(err); }
});

router.get('/pf-status', can('canViewReports'), async (req, res, next) => {
  try {
    const { tenderId } = req.query;
    const employees = await prisma.tenderEmployee.findMany({
      where: {
        isActive: true,
        tender: { tenantId: req.tenantId },
        ...(tenderId && { tenderId }),
      },
      include: {
        employee: { select: { name: true, uan: true, pfNumber: true, esicNumber: true } },
        tender: { select: { name: true } },
      },
    });
    res.json({ success: true, data: employees });
  } catch (err) { next(err); }
});

router.get('/turnover', can('canViewReports'), async (req, res, next) => {
  try {
    const { year } = req.query;
    const y = parseInt(year) || new Date().getFullYear();
    const exits = await prisma.tenderEmployee.findMany({
      where: {
        isActive: false,
        exitDate: {
          gte: new Date(`${y}-01-01`),
          lte: new Date(`${y}-12-31`),
        },
        tender: { tenantId: req.tenantId },
      },
      include: {
        employee: { select: { name: true, uan: true } },
        tender: { select: { name: true } },
      },
      orderBy: { exitDate: 'desc' },
    });
    res.json({ success: true, data: exits });
  } catch (err) { next(err); }
});

module.exports = router;
