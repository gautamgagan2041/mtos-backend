// src/modules/billing/billing.repository.js
// ─────────────────────────────────────────────────────────────────
// Billing Repository — DB layer for billing domain
// ONLY this file talks to the database for billing
// No calculation logic here — that lives in billingEngine.js
// ─────────────────────────────────────────────────────────────────

'use strict';

const prisma = require('../../config/database');

// ── Read Operations ───────────────────────────────────────────────

/**
 * Get all active manpower requirements for a tender
 * These are the REQUIRED POSTS — source of truth for billing
 */
async function getManpowerRequirements(tenderId, asOfDate = new Date()) {
  return prisma.manpowerRequirement.findMany({
    where: {
      tenderId,
      isActive: true,
      effectiveFrom: { lte: asOfDate },
      OR: [
        { effectiveTo: null },
        { effectiveTo: { gte: asOfDate } },
      ],
    },
    orderBy: { categoryCode: 'asc' },
  });
}

/**
 * Get billing configuration for a tender
 * Contains GST mode, service charge rate, invoice prefix
 */
async function getBillingConfig(tenderId) {
  return prisma.billingConfig.findUnique({
    where: { tenderId },
  });
}

/**
 * Get tender with client details (for invoice header)
 */
async function getTenderWithClient(tenderId, tenantId) {
  return prisma.tender.findFirst({
    where: { id: tenderId, tenantId },
    include: {
      client: true,
    },
  });
}

/**
 * Check if invoice already exists for this tender + month + year
 * Prevents duplicate invoices
 */
async function findExistingInvoice(tenderId, month, year) {
  return prisma.invoice.findFirst({
    where: { tenderId, month, year },
  });
}

/**
 * Get next sequential invoice number for tenant + prefix + FY
 * Uses a transaction to prevent race conditions
 * Two simultaneous requests cannot get the same number
 */
async function getNextInvoiceNumber(tenantId, prefix, fy) {
  return prisma.$transaction(async (tx) => {
    // Upsert the sequence record — create if first invoice this FY
    const sequence = await tx.invoiceSequence.upsert({
      where: {
        tenantId_prefix_fy: { tenantId, prefix, fy },
      },
      create: { tenantId, prefix, fy, lastSeq: 1 },
      update: { lastSeq: { increment: 1 } },
    });

    // Format: INV/2025-26/0001
    const paddedSeq = String(sequence.lastSeq).padStart(4, '0');
    return `${prefix}/${fy}/${paddedSeq}`;
  });
}

/**
 * Save a complete invoice with all line items
 * Single transaction — either everything saves or nothing does
 */
async function saveInvoice(tenantId, tenderId, invoiceData) {
  const {
    invoiceNo,
    month,
    year,
    periodStart,
    periodEnd,
    subtotal,
    serviceCharge,
    taxableValue,
    cgst,
    sgst,
    igst,
    grandTotal,
    gstMode,
    lineItems,
  } = invoiceData;

  return prisma.$transaction(async (tx) => {
    // Create invoice header
    const invoice = await tx.invoice.create({
      data: {
        tenantId,
        tenderId,
        invoiceNo,
        month,
        year,
        periodStart: new Date(periodStart),
        periodEnd:   new Date(periodEnd),
        subtotal,
        serviceCharge,
        taxableValue,
        cgst,
        sgst,
        igst,
        grandTotal,
        gstMode,
        status: 'DRAFT',
      },
    });

    // Create line items — one per billing category
    await tx.invoiceLineItem.createMany({
      data: lineItems.map((item, index) => ({
        invoiceId:     invoice.id,
        categoryCode:  item.categoryCode,
        categoryName:  item.categoryName,
        requiredPosts: item.requiredPosts,
        monthlyRate:   item.monthlyRate,
        workingDays:   item.workingDays,
        standardDays:  item.standardDays,
        amount:        item.amount,
        sacCode:       item.sacCode,
        displayOrder:  index,
      })),
    });

    // Return invoice with line items for response
    return tx.invoice.findUnique({
      where: { id: invoice.id },
      include: { lineItems: { orderBy: { displayOrder: 'asc' } } },
    });
  });
}

/**
 * Get a single invoice with line items
 */
async function getInvoiceById(invoiceId, tenantId) {
  return prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId },
    include: {
      lineItems: { orderBy: { displayOrder: 'asc' } },
      tender: { include: { client: true } },
    },
  });
}

/**
 * Get all invoices for a tender
 */
async function getInvoicesByTender(tenderId, tenantId) {
  return prisma.invoice.findMany({
    where: { tenderId, tenantId },
    include: {
      lineItems: { orderBy: { displayOrder: 'asc' } },
    },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
  });
}

/**
 * Update invoice status (DRAFT → SENT → PAID etc.)
 */
async function updateInvoiceStatus(invoiceId, tenantId, status, extraData = {}) {
  return prisma.invoice.updateMany({
    where: { id: invoiceId, tenantId },
    data: { status, ...extraData },
  });
}

/**
 * Save or update manpower requirement
 */
async function upsertManpowerRequirement(tenantId, tenderId, data) {
  // Close previous requirement for this category if it exists
  if (data.effectiveFrom) {
    await prisma.manpowerRequirement.updateMany({
      where: {
        tenderId,
        categoryCode: data.categoryCode,
        isActive: true,
        effectiveTo: null,
      },
      data: {
        effectiveTo: new Date(data.effectiveFrom),
        isActive: false,
      },
    });
  }

  return prisma.manpowerRequirement.create({
    data: {
      tenantId,
      tenderId,
      categoryCode:  data.categoryCode,
      categoryName:  data.categoryName,
      requiredPosts: data.requiredPosts,
      monthlyRate:   data.monthlyRate,
      effectiveFrom: new Date(data.effectiveFrom || new Date()),
      effectiveTo:   data.effectiveTo ? new Date(data.effectiveTo) : null,
      isActive:      true,
    },
  });
}

/**
 * Save or update billing config for a tender
 */
async function upsertBillingConfig(tenderId, data) {
  return prisma.billingConfig.upsert({
    where: { tenderId },
    create: { tenderId, ...data },
    update: { ...data },
  });
}

module.exports = {
  getManpowerRequirements,
  getBillingConfig,
  getTenderWithClient,
  findExistingInvoice,
  getNextInvoiceNumber,
  saveInvoice,
  getInvoiceById,
  getInvoicesByTender,
  updateInvoiceStatus,
  upsertManpowerRequirement,
  upsertBillingConfig,
};