// src/modules/disbursement/disbursement.routes.js
'use strict';

const express    = require('express');
const { protect, can } = require('../../middleware/auth');
const { resolveTenant, requireTenant } = require('../../middleware/tenant');
const controller = require('./disbursement.controller');

const router = express.Router();
router.use(protect, resolveTenant, requireTenant);

// Initialize disbursements after payroll lock
router.post('/initialize',     can('canRunPayroll'), controller.initializeDisbursements);

// Get disbursements for a run
router.get('/',                                      controller.getDisbursements);

// Mark individual payment
router.patch('/:id/transferred', can('canRunPayroll'), controller.markTransferred);
router.patch('/:id/failed',      can('canRunPayroll'), controller.markFailed);

// Bulk transfer all pending
router.post('/bulk-transfer',  can('canRunPayroll'), controller.bulkMarkTransferred);

module.exports = router;
