// src/modules/billing/billing.controller.js
// ─────────────────────────────────────────────────────────────────
// Billing Controller — HTTP layer only
// Reads req → calls service → writes res
// No business logic. No DB calls. No calculations.
// ─────────────────────────────────────────────────────────────────

'use strict';

const billingService = require('./billing.service');
const asyncHandler   = require('../../utils/asyncHandler');

// ── POST /billing/config ──────────────────────────────────────────
// Set up or update billing configuration for a tender
const setBillingConfig = asyncHandler(async (req, res) => {
  const { tenderId } = req.body;

  if (!tenderId) {
    return res.status(400).json({
      success: false,
      message: 'tenderId is required.',
    });
  }

  const config = await billingService.setBillingConfig(
    tenderId,
    req.tenantId,
    req.body
  );

  return res.status(200).json({
    success: true,
    message: 'Billing configuration saved.',
    data:    config,
  });
});

// ── GET /billing/config?tenderId=xxx ─────────────────────────────
const getBillingConfig = asyncHandler(async (req, res) => {
  const { tenderId } = req.query;

  if (!tenderId) {
    return res.status(400).json({
      success: false,
      message: 'tenderId query parameter is required.',
    });
  }

  const config = await billingService.getBillingConfig(tenderId, req.tenantId);

  return res.status(200).json({
    success: true,
    data:    config,
  });
});

// ── POST /billing/requirements ────────────────────────────────────
// Add or update manpower requirement (required posts + rate)
const setManpowerRequirement = asyncHandler(async (req, res) => {
  const {
    tenderId,
    categoryCode,
    categoryName,
    requiredPosts,
    monthlyRate,
    effectiveFrom,
  } = req.body;

  // Validate required fields
  const missing = [];
  if (!tenderId)      missing.push('tenderId');
  if (!categoryCode)  missing.push('categoryCode');
  if (!categoryName)  missing.push('categoryName');
  if (!requiredPosts) missing.push('requiredPosts');
  if (!monthlyRate)   missing.push('monthlyRate');

  if (missing.length) {
    return res.status(400).json({
      success: false,
      message: `Missing required fields: ${missing.join(', ')}`,
    });
  }

  const requirement = await billingService.setManpowerRequirement(
    req.tenantId,
    tenderId,
    {
      categoryCode,
      categoryName,
      requiredPosts: parseInt(requiredPosts),
      monthlyRate:   parseFloat(monthlyRate),
      effectiveFrom: effectiveFrom || new Date().toISOString(),
    }
  );

  return res.status(201).json({
    success: true,
    message: 'Manpower requirement saved.',
    data:    requirement,
  });
});

// ── GET /billing/requirements?tenderId=xxx ────────────────────────
const getManpowerRequirements = asyncHandler(async (req, res) => {
  const { tenderId } = req.query;

  if (!tenderId) {
    return res.status(400).json({
      success: false,
      message: 'tenderId query parameter is required.',
    });
  }

  const requirements = await billingService.getManpowerRequirements(
    tenderId,
    req.tenantId
  );

  return res.status(200).json({
    success: true,
    data:    requirements,
  });
});

// ── GET /billing/preview?tenderId=xxx&month=3&year=2026 ───────────
// Preview invoice without saving — used by frontend before confirm
const previewInvoice = asyncHandler(async (req, res) => {
  const { tenderId, month, year } = req.query;

  if (!tenderId || !month || !year) {
    return res.status(400).json({
      success: false,
      message: 'tenderId, month, and year are required query parameters.',
    });
  }

  const preview = await billingService.previewInvoice(
    req.tenantId,
    tenderId,
    parseInt(month),
    parseInt(year)
  );

  return res.status(200).json({
    success: true,
    data:    preview,
  });
});

// ── POST /billing/invoices/generate ──────────────────────────────
// Generate and save invoice
const generateInvoice = asyncHandler(async (req, res) => {
  const { tenderId, month, year, invoiceNo } = req.body;

  if (!tenderId || !month || !year) {
    return res.status(400).json({
      success: false,
      message: 'tenderId, month, and year are required.',
    });
  }

  const result = await billingService.generateInvoice(
    req.tenantId,
    tenderId,
    parseInt(month),
    parseInt(year),
    { invoiceNo }   // optional custom invoice number
  );

  return res.status(201).json({
    success: true,
    message: `Invoice ${result.invoice.invoiceNo} generated successfully.`,
    data:    result,
  });
});

// ── GET /billing/invoices?tenderId=xxx ────────────────────────────
const getTenderInvoices = asyncHandler(async (req, res) => {
  const { tenderId } = req.query;

  if (!tenderId) {
    return res.status(400).json({
      success: false,
      message: 'tenderId query parameter is required.',
    });
  }

  const invoices = await billingService.getTenderInvoices(
    tenderId,
    req.tenantId
  );

  return res.status(200).json({
    success: true,
    data:    invoices,
  });
});

// ── GET /billing/invoices/:invoiceId ──────────────────────────────
const getInvoice = asyncHandler(async (req, res) => {
  const invoice = await billingService.getInvoice(
    req.params.invoiceId,
    req.tenantId
  );

  return res.status(200).json({
    success: true,
    data:    invoice,
  });
});

// ── PATCH /billing/invoices/:invoiceId/paid ───────────────────────
const markInvoicePaid = asyncHandler(async (req, res) => {
  const { paidAmount, paidOn } = req.body;

  if (!paidAmount || !paidOn) {
    return res.status(400).json({
      success: false,
      message: 'paidAmount and paidOn are required.',
    });
  }

  const invoice = await billingService.markInvoicePaid(
    req.params.invoiceId,
    req.tenantId,
    parseFloat(paidAmount),
    paidOn
  );

  return res.status(200).json({
    success: true,
    message: 'Invoice payment recorded.',
    data:    invoice,
  });
});

module.exports = {
  setBillingConfig,
  getBillingConfig,
  setManpowerRequirement,
  getManpowerRequirements,
  previewInvoice,
  generateInvoice,
  getTenderInvoices,
  getInvoice,
  markInvoicePaid,
};
