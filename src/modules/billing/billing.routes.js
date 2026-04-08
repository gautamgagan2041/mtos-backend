// src/modules/billing/billing.routes.js
// ─────────────────────────────────────────────────────────────────
// Billing Routes — URL definitions only
// All business logic is in billing.controller.js
// ─────────────────────────────────────────────────────────────────

'use strict';

const express    = require('express');
const { protect, can } = require('../../middleware/auth');
const { resolveTenant, requireTenant } = require('../../middleware/tenant');
const controller = require('./billing.controller');

const router = express.Router();

// All billing routes require authentication and a valid tenant
router.use(protect, resolveTenant, requireTenant);

// ── Billing Configuration ─────────────────────────────────────────
// POST   /api/billing/config          → set/update billing config for tender
// GET    /api/billing/config          → get billing config for tender
router.post('/config',  can('canRunPayroll'), controller.setBillingConfig);
router.get('/config',                        controller.getBillingConfig);

// ── Manpower Requirements (Required Posts) ────────────────────────
// POST   /api/billing/requirements    → add/update required posts + rate
// GET    /api/billing/requirements    → list requirements for tender
router.post('/requirements', can('canRunPayroll'), controller.setManpowerRequirement);
router.get('/requirements',                       controller.getManpowerRequirements);

// ── Invoice Preview ───────────────────────────────────────────────
// GET    /api/billing/preview         → calculate invoice without saving
router.get('/preview', controller.previewInvoice);

// ── Invoice Generation and Management ────────────────────────────
// POST   /api/billing/invoices/generate    → generate + save invoice
// GET    /api/billing/invoices             → list invoices for tender
// GET    /api/billing/invoices/:invoiceId  → get single invoice with line items
// PATCH  /api/billing/invoices/:invoiceId/paid → record payment
router.post('/invoices/generate',             can('canRunPayroll'), controller.generateInvoice);
router.get('/invoices',                                             controller.getTenderInvoices);
router.get('/invoices/:invoiceId',                                  controller.getInvoice);
router.patch('/invoices/:invoiceId/paid',     can('canRunPayroll'), controller.markInvoicePaid);

module.exports = router;
