'use strict';

/**
 * payroll.routes.js — v4
 * Adds: ECR, ESIC return, payslip PDF, bulk payslips, job status polling
 */

const express    = require('express');
const router     = express.Router();
const { protect, can } = require('../../middleware/auth');
const { resolveTenant, requireTenant } = require('../../middleware/tenant');
const { validate, schemas } = require('../../middleware/validate');
const controller = require('./payroll.controller');

router.use(protect, resolveTenant, requireTenant);

// ── Async run + status polling ────────────────────────────────────
router.post('/run',
  can('canRunPayroll'),
  validate(schemas.runPayroll),
  controller.runPayroll
);

// Job status polling — no tenant check needed (jobId is opaque)
router.get('/run/status/:jobId', protect, controller.getRunStatus);

// ── Run management ────────────────────────────────────────────────
router.get('/',               controller.getRunsByTender);
router.get('/:runId',         controller.getRun);
router.post('/:runId/lock',   can('canRunPayroll'), controller.lockPayroll);
router.delete('/:runId',      can('canRunPayroll'), controller.deleteRun);

// ── Reports ───────────────────────────────────────────────────────
router.get('/:runId/cost-sheet',     controller.getCostSheet);
router.get('/:runId/pf-challan',     controller.getPFChallan);
router.get('/:runId/transfer-sheet', controller.getTransferSheet);

// ── Export files ──────────────────────────────────────────────────
// GET ?preview=true returns JSON summary; without returns downloadable file
router.get('/:runId/ecr',         can('canRunPayroll'), controller.downloadECR);
router.get('/:runId/esic-return', can('canRunPayroll'), controller.downloadESICReturn);

// GET ?format=html returns HTML preview for browser iframe
router.get('/:runId/payslip/:employeeId', controller.downloadPayslip);
router.get('/:runId/payslips-bulk',       can('canRunPayroll'), controller.downloadAllPayslips);

module.exports = router;
