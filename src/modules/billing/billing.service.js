// src/modules/billing/billing.service.js
// ─────────────────────────────────────────────────────────────────
// Billing Service — Orchestration layer
// Calls: billing.repository.js (data) + billingEngine.js (math)
// Never touches: req, res, prisma directly
// ─────────────────────────────────────────────────────────────────

'use strict';

const repository     = require('./billing.repository');
const billingEngine  = require('./engines/billingEngine');

// ── Generate Invoice Preview (no save) ───────────────────────────
/**
 * Calculate what an invoice WOULD look like without saving
 * Used by frontend to show preview before confirming
 */
async function previewInvoice(tenantId, tenderId, month, year) {
  _validateMonthYear(month, year);

  // 1. Load tender + client
  const tender = await repository.getTenderWithClient(tenderId, tenantId);
  if (!tender) {
    throw new Error(`Tender not found or does not belong to this tenant.`);
  }

  // 2. Load billing config
  const config = await repository.getBillingConfig(tenderId);
  if (!config) {
    throw new Error(
      `No billing configuration found for tender "${tender.name}". ` +
      `Please set up billing config (GST mode, service charge) first.`
    );
  }

  // 3. Load manpower requirements
  const billingDate    = new Date(year, month - 1, 1);
  const requirements   = await repository.getManpowerRequirements(tenderId, billingDate);
  if (!requirements.length) {
    throw new Error(
      `No active manpower requirements found for tender "${tender.name}" ` +
      `for ${month}/${year}. Add required posts before generating invoice.`
    );
  }

  // 4. Run calculation — pure math, no DB
  const calculation = billingEngine.generateBilling({ costSummary: requirements, config });

  return {
    tender: {
      id:        tender.id,
      name:      tender.name,
      workOrder: tender.workOrder,
    },
    client: {
      id:      tender.client.id,
      name:    tender.client.name,
      gstin:   tender.client.gstin,
      address: tender.client.address,
      state:   tender.client.state,
    },
    config: {
      gstMode:           config.gstMode,
      serviceChargeRate: config.serviceChargeRate,
      cgstRate:          config.cgstRate,
      sgstRate:          config.sgstRate,
      igstRate:          config.igstRate,
    },
    calculation,
  };
}

// ── Generate and Save Invoice ─────────────────────────────────────
/**
 * Full invoice generation flow
 * 1. Check no duplicate invoice exists
 * 2. Calculate billing
 * 3. Get sequential invoice number
 * 4. Save invoice + line items in one transaction
 */
async function generateInvoice(tenantId, tenderId, month, year, options = {}) {
  _validateMonthYear(month, year);

  // 1. Check duplicate
  const existing = await repository.findExistingInvoice(tenderId, month, year);
  if (existing) {
    throw new Error(
      `Invoice already exists for this tender and period: ${existing.invoiceNo}. ` +
      `Cannot generate a second invoice for the same month.`
    );
  }

  // 2. Load tender + client
  const tender = await repository.getTenderWithClient(tenderId, tenantId);
  if (!tender) {
    throw new Error(`Tender not found or does not belong to this tenant.`);
  }

  // 3. Load billing config
  const config = await repository.getBillingConfig(tenderId);
  if (!config) {
    throw new Error(
      `No billing configuration found for tender "${tender.name}". ` +
      `Set up BillingConfig before generating invoice.`
    );
  }

  // 4. Load requirements
  const billingDate  = new Date(year, month - 1, 1);
  const requirements = await repository.getManpowerRequirements(tenderId, billingDate);
  if (!requirements.length) {
    throw new Error(
      `No active manpower requirements found for tender "${tender.name}" ` +
      `for ${month}/${year}.`
    );
  }

  // 5. Calculate — engine does the math
  const calculation = billingEngine.generateBilling({ costSummary: requirements, config });

  // 6. Get sequential invoice number
  // Use custom number if provided, else auto-generate
  let invoiceNo = options.invoiceNo || null;
  if (!invoiceNo) {
    const prefix = config.invoicePrefix || 'INV';
    const fy     = billingEngine.getFinancialYear(month, year);
    invoiceNo    = await repository.getNextInvoiceNumber(tenantId, prefix, fy);
  }

  // 7. Save invoice + line items (single transaction in repository)
  const invoice = await repository.saveInvoice(tenantId, tenderId, {
    invoiceNo,
    month,
    year,
    periodStart:   calculation.periodStart,
    periodEnd:     calculation.periodEnd,
    subtotal:      calculation.subtotal,
    serviceCharge: calculation.serviceCharge,
    taxableValue:  calculation.taxableValue,
    cgst:          calculation.cgst,
    sgst:          calculation.sgst,
    igst:          calculation.igst,
    grandTotal:    calculation.grandTotal,
    gstMode:       calculation.gstMode,
    lineItems:     calculation.lineItems,
  });

  return {
    invoice,
    tender: { id: tender.id, name: tender.name },
    client: { name: tender.client.name, gstin: tender.client.gstin },
    calculation,
  };
}

// ── Get Single Invoice ────────────────────────────────────────────
async function getInvoice(invoiceId, tenantId) {
  const invoice = await repository.getInvoiceById(invoiceId, tenantId);
  if (!invoice) {
    throw new Error(`Invoice not found.`);
  }
  return invoice;
}

// ── Get All Invoices for Tender ───────────────────────────────────
async function getTenderInvoices(tenderId, tenantId) {
  // Verify tender belongs to tenant
  const tender = await repository.getTenderWithClient(tenderId, tenantId);
  if (!tender) {
    throw new Error(`Tender not found or does not belong to this tenant.`);
  }

  return repository.getInvoicesByTender(tenderId, tenantId);
}

// ── Update Invoice Status ─────────────────────────────────────────
async function markInvoicePaid(invoiceId, tenantId, paidAmount, paidOn) {
  const invoice = await repository.getInvoiceById(invoiceId, tenantId);
  if (!invoice) {
    throw new Error(`Invoice not found.`);
  }
  if (invoice.status === 'CANCELLED') {
    throw new Error(`Cannot mark a cancelled invoice as paid.`);
  }

  const status = paidAmount >= invoice.grandTotal ? 'PAID' : 'PARTIALLY_PAID';

  await repository.updateInvoiceStatus(invoiceId, tenantId, status, {
    paidAmount,
    paidOn: new Date(paidOn),
  });

  return repository.getInvoiceById(invoiceId, tenantId);
}

// ── Setup: Save Manpower Requirements ────────────────────────────
/**
 * Add or update required posts for a tender category
 * Called when setting up a tender or revising rates
 */
async function setManpowerRequirement(tenantId, tenderId, data) {
  // Validate required fields
  const required = ['categoryCode', 'categoryName', 'requiredPosts', 'monthlyRate'];
  for (const field of required) {
    if (data[field] === undefined || data[field] === null) {
      throw new Error(`Missing required field: ${field}`);
    }
  }
  if (data.requiredPosts <= 0) {
    throw new Error(`requiredPosts must be greater than 0.`);
  }
  if (data.monthlyRate <= 0) {
    throw new Error(`monthlyRate must be greater than 0.`);
  }

  return repository.upsertManpowerRequirement(tenantId, tenderId, data);
}

// ── Setup: Save Billing Config ────────────────────────────────────
/**
 * Configure GST mode, service charge, invoice prefix for a tender
 */
async function setBillingConfig(tenderId, tenantId, data) {
  // Verify tender belongs to tenant
  const tender = await repository.getTenderWithClient(tenderId, tenantId);
  if (!tender) {
    throw new Error(`Tender not found or does not belong to this tenant.`);
  }

  const validGstModes = ['EXCLUDED', 'INCLUDED', 'REVERSE_CHARGE', 'NONE'];
  if (data.gstMode && !validGstModes.includes(data.gstMode)) {
    throw new Error(
      `Invalid gstMode: "${data.gstMode}". Must be one of: ${validGstModes.join(', ')}`
    );
  }

  return repository.upsertBillingConfig(tenderId, {
    gstMode:             data.gstMode             ?? 'REVERSE_CHARGE',
    cgstRate:            data.cgstRate             ?? 0.09,
    sgstRate:            data.sgstRate             ?? 0.09,
    igstRate:            data.igstRate             ?? 0,
    serviceChargeRate:   data.serviceChargeRate    ?? 0.10,
    includeServiceCharge: data.includeServiceCharge ?? true,
    invoicePrefix:       data.invoicePrefix        ?? 'INV',
    sacCode:             data.sacCode              ?? '998525',
    paymentTermsDays:    data.paymentTermsDays      ?? 30,
    notes:               data.notes                ?? null,
  });
}

// ── Get Requirements for a Tender ────────────────────────────────
async function getManpowerRequirements(tenderId, tenantId) {
  const tender = await repository.getTenderWithClient(tenderId, tenantId);
  if (!tender) {
    throw new Error(`Tender not found or does not belong to this tenant.`);
  }
  return repository.getManpowerRequirements(tenderId);
}

// ── Get Billing Config for a Tender ──────────────────────────────
async function getBillingConfig(tenderId, tenantId) {
  const tender = await repository.getTenderWithClient(tenderId, tenantId);
  if (!tender) {
    throw new Error(`Tender not found or does not belong to this tenant.`);
  }
  return repository.getBillingConfig(tenderId);
}

// ── Private Helpers ───────────────────────────────────────────────
function _validateMonthYear(month, year) {
  const m = parseInt(month);
  const y = parseInt(year);
  if (isNaN(m) || m < 1 || m > 12) {
    throw new Error(`Invalid month: "${month}". Must be 1–12.`);
  }
  if (isNaN(y) || y < 2020 || y > 2100) {
    throw new Error(`Invalid year: "${year}".`);
  }
}

module.exports = {
  previewInvoice,
  generateInvoice,
  getInvoice,
  getTenderInvoices,
  markInvoicePaid,
  setManpowerRequirement,
  setBillingConfig,
  getManpowerRequirements,
  getBillingConfig,
};
