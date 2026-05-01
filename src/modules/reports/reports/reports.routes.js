'use strict';

const express       = require('express');
const router        = express.Router();
const asyncHandler  = require('../../utils/asyncHandler');
const { protect, can } = require('../../middleware/auth');
const { resolveTenant, requireTenant } = require('../../middleware/tenant');
const { requireFeature } = require('../../middleware/planGuard');
const service       = require('./reports.service');

router.use(protect, resolveTenant, requireTenant, requireFeature('reports_basic'), can('canViewReports'));

// GET /api/reports/payroll-summary?month=4&year=2026
router.get('/payroll-summary', asyncHandler(async (req, res) => {
  const { month, year } = req.query;
  if (!month || !year) return res.status(400).json({ success: false, message: 'month and year required' });
  const data = await service.payrollSummary(req.tenantId, month, year);
  res.json({ success: true, data });
}));

// GET /api/reports/payroll-summary/export?month=4&year=2026
router.get('/payroll-summary/export', asyncHandler(async (req, res) => {
  const { month, year } = req.query;
  if (!month || !year) return res.status(400).json({ success: false, message: 'month and year required' });
  const buffer = await service.exportPayrollSummaryToExcel(req.tenantId, month, year);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="PayrollSummary_${month}_${year}.xlsx"`);
  res.send(buffer);
}));

// GET /api/reports/tender-comparison/:tenderId?months=6
router.get('/tender-comparison/:tenderId', asyncHandler(async (req, res) => {
  const numMonths = parseInt(req.query.months || 6);
  const data = await service.tenderComparison(req.tenantId, req.params.tenderId, numMonths);
  res.json({ success: true, data });
}));

// GET /api/reports/compliance-dashboard
router.get('/compliance-dashboard', asyncHandler(async (req, res) => {
  const data = await service.complianceDashboard(req.tenantId);
  res.json({ success: true, data });
}));

// GET /api/reports/employee-statement/:employeeId
router.get('/employee-statement/:employeeId', asyncHandler(async (req, res) => {
  const data = await service.employeeStatement(req.tenantId, req.params.employeeId);
  res.json({ success: true, data });
}));

// GET /api/reports/pf-summary?month=4&year=2026
router.get('/pf-summary', asyncHandler(async (req, res) => {
  const { month, year } = req.query;
  if (!month || !year) return res.status(400).json({ success: false, message: 'month and year required' });
  const data = await service.pfChallanSummary(req.tenantId, month, year);
  res.json({ success: true, data });
}));

// GET /api/reports/cost-analytics?months=12
router.get('/cost-analytics', requireFeature('reports_advanced'), asyncHandler(async (req, res) => {
  const numMonths = parseInt(req.query.months || 12);
  const data = await service.costAnalytics(req.tenantId, numMonths);
  res.json({ success: true, data });
}));

module.exports = router;
