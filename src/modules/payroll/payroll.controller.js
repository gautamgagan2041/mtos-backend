// src/modules/payroll/payroll.controller.js
'use strict';

const payrollService = require('./payroll.service');
const asyncHandler   = require('../../utils/asyncHandler');
const audit          = require('../../services/auditService');

const runPayroll = asyncHandler(async (req, res) => {
  const { tenderId, month, year } = req.body;
  if (!tenderId || !month || !year) {
    return res.status(400).json({ success: false, message: 'tenderId, month, and year are required.' });
  }
  const result = await payrollService.runPayroll(req.tenantId, tenderId, month, year, req.user.id);
  await audit.log({
    tenantId: req.tenantId, userId: req.user.id,
    action: 'PAYROLL_RUN', entityType: 'PAYROLL_RUN', entityId: result.id,
    newValues: { tenderId, month, year, rowCount: result.rowCount, totalGross: result.totalGross, totalNet: result.totalNet },
    req,
  });
  return res.status(200).json({ success: true, message: `Payroll complete. ${result.rowCount} rows processed.`, data: result });
});

const getRunsByTender = asyncHandler(async (req, res) => {
  const { tenderId } = req.query;
  if (!tenderId) {
    return res.status(400).json({ success: false, message: 'tenderId query parameter is required.' });
  }
  const runs = await payrollService.getRunsByTender(tenderId, req.tenantId);
  return res.status(200).json({ success: true, data: runs });
});

const getRun = asyncHandler(async (req, res) => {
  const run = await payrollService.getRun(req.params.runId, req.tenantId);
  return res.status(200).json({ success: true, data: run });
});

const lockRun = asyncHandler(async (req, res) => {
  const run = await payrollService.lockRun(req.params.runId, req.tenantId, req.user.id);
  await audit.log({
    tenantId: req.tenantId, userId: req.user.id,
    action: 'PAYROLL_LOCK', entityType: 'PAYROLL_RUN', entityId: run.id,
    newValues: { month: run.month, year: run.year, tenderId: run.tenderId },
    req,
  });
  return res.status(200).json({ success: true, message: 'Payroll locked successfully.', data: run });
});

const getPFChallan = asyncHandler(async (req, res) => {
  const data = await payrollService.getPFChallan(req.params.runId, req.tenantId);
  return res.status(200).json({ success: true, data });
});

const getTransferSheet = asyncHandler(async (req, res) => {
  const data = await payrollService.getTransferSheet(req.params.runId, req.tenantId);
  return res.status(200).json({ success: true, data });
});

module.exports = {
  runPayroll,
  getRunsByTender,
  getRun,
  lockRun,
  getPFChallan,
  getTransferSheet,
};