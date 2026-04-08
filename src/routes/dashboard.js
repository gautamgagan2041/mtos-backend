// src/routes/dashboard.js
const express = require('express');
const prisma = require('../config/database');
const { protect } = require('../middleware/auth');
const { resolveTenant, requireTenant } = require('../middleware/tenant');
const router = express.Router();

router.use(protect, resolveTenant, requireTenant);

router.get('/summary', async (req, res, next) => {
  try {
    const now = new Date();
    const ninetyDays = new Date(now);
    ninetyDays.setDate(ninetyDays.getDate() + 90);

    const tid = req.tenantId;

    const [
      totalEmployees, activeEmployees, activeTenders,
      criticalAlerts, unresolvedAlerts, recentPayroll,
      expiringDocs, vacancies, recentAlerts,
    ] = await Promise.all([
      prisma.employee.count({ where: { tenantId: tid } }),
      prisma.employee.count({ where: { tenantId: tid, status: 'ACTIVE' } }),
      prisma.tender.count({ where: { tenantId: tid, status: 'ACTIVE' } }),
      prisma.complianceAlert.count({ where: { tenantId: tid, severity: 'CRITICAL', isResolved: false } }),
      prisma.complianceAlert.count({ where: { tenantId: tid, isResolved: false } }),
      prisma.payrollRun.findMany({
        where: { tender: { tenantId: tid } },
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { tender: { select: { name: true } } },
      }),
      prisma.complianceDocument.findMany({
        where: { tenantId: tid, isActive: true, expiryDate: { gte: now, lte: ninetyDays } },
        include: { tender: { select: { name: true } } },
        orderBy: { expiryDate: 'asc' },
      }),
      prisma.complianceAlert.count({ where: { tenantId: tid, alertType: 'VACANCY_CREATED', isResolved: false } }),
      prisma.complianceAlert.findMany({
        where: { tenantId: tid, isResolved: false },
        take: 10,
        include: { tender: { select: { name: true } } },
        orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
      }),
    ]);

    res.json({
      success: true,
      data: {
        stats: { totalEmployees, activeEmployees, activeTenders, criticalAlerts, unresolvedAlerts, vacancies },
        expiringDocs,
        recentAlerts,
        recentPayroll,
        tenant: {
          name: req.tenant.name,
          plan: req.tenant.plan,
          maxEmployees: req.tenant.maxEmployees,
          currentEmployees: activeEmployees,
        },
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
