// src/modules/payroll/payroll.routes.js
'use strict';

const express    = require('express');
const { protect, can } = require('../../middleware/auth');
const { resolveTenant, requireTenant } = require('../../middleware/tenant');
const controller = require('./payroll.controller');

const router = express.Router();
router.use(protect, resolveTenant, requireTenant);

router.post('/run',     can('canRunPayroll'), controller.runPayroll);
router.get('/',                              controller.getRunsByTender);
router.get('/:runId',                        controller.getRun);
router.post('/:runId/lock', can('canRunPayroll'), controller.lockRun);
router.get('/:runId/pf-challan',     controller.getPFChallan);
router.get('/:runId/transfer-sheet', controller.getTransferSheet);

module.exports = router;