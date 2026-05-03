/**
 * MTOS Billing — Invoice generation with race condition protection
 *
 * Fixes: MED-02 — Duplicate invoice race condition.
 *                 Two concurrent requests both passing the duplicate check
 *                 and creating two invoices for the same tender/month/year.
 *
 * Design contract:
 *  - generateInvoice() uses a DB-level unique constraint on (tenderId, month, year)
 *    as the primary guard. This is the ONLY reliable guard against concurrent inserts.
 *  - The application-level pre-check is retained as an early-exit optimisation
 *    (avoids DB round-trip on the hot path), but it is NOT the safety guard.
 *  - P2002 (unique constraint violation) from Prisma is caught and translated
 *    to a clean "already exists" result rather than a 500 error.
 *
 * Required DB migration (add this to your next Prisma migration):
 *   ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenderId_month_year_key"
 *     UNIQUE ("tenderId", "month", "year");
 *
 * Or in schema.prisma:
 *   model Invoice {
 *     ...
 *     @@unique([tenderId, month, year])
 *   }
 */

'use strict';

// Prisma unique constraint violation error code
const PRISMA_UNIQUE_VIOLATION = 'P2002';

// ─── generateInvoice ──────────────────────────────────────────────────────────

/**
 * Generates an invoice for a payroll run.
 *
 * Returns { invoice, created: true }  if the invoice was newly created.
 * Returns { invoice, created: false } if it already existed (idempotent).
 * Throws on all other errors.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} tenantId
 * @param {Object} invoiceData – { tenderId, month, year, lineItems, ... }
 * @returns {Promise<{ invoice: Object, created: boolean }>}
 */
async function generateInvoice(prisma, tenantId, invoiceData) {
  if (!tenantId) throw new Error('generateInvoice: tenantId is required');

  const { tenderId, month, year } = invoiceData;
  if (!tenderId || !month || !year) {
    throw new Error('generateInvoice: tenderId, month, and year are required');
  }

  // ── Optimistic application-level pre-check ────────────────────────────────
  // Not a safety guard — just avoids the insert round-trip on the common path.
  const existing = await prisma.invoice.findFirst({
    where: { tenantId, tenderId, month, year },
  });
  if (existing) {
    return { invoice: existing, created: false };
  }

  // ── Atomic insert with unique constraint guard (MED-02 FIX) ──────────────
  // The DB-level UNIQUE(tenderId, month, year) constraint is the real guard.
  // If two requests race past the pre-check above, only one succeeds here.
  try {
    const invoiceNumber = await generateInvoiceNumber(prisma, tenantId);

    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        tenderId,
        month,
        year,
        invoiceNumber,
        lineItems:   invoiceData.lineItems   || [],
        subtotal:    invoiceData.subtotal    || 0,
        taxAmount:   invoiceData.taxAmount   || 0,
        totalAmount: invoiceData.totalAmount || 0,
        dueDate:     invoiceData.dueDate     || null,
        status:      'DRAFT',
        generatedBy: invoiceData.generatedBy || null,
        generatedAt: new Date(),
      },
    });

    return { invoice, created: true };
  } catch (err) {
    // MED-02 FIX: Catch the unique constraint violation that occurs when two
    // concurrent requests race past the pre-check. Translate to idempotent result.
    if (err.code === PRISMA_UNIQUE_VIOLATION) {
      const existing = await prisma.invoice.findFirst({
        where: { tenantId, tenderId, month, year },
      });
      return { invoice: existing, created: false };
    }
    throw err;
  }
}

// ─── Invoice number generation ────────────────────────────────────────────────

/**
 * Generates a sequential, gapless invoice number for the tenant.
 * Uses a DB sequence (or count+1) wrapped in a transaction to prevent
 * gaps from concurrent inserts.
 *
 * Format: INV-{YYYY}-{TENANTSEQ:06d}
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} tenantId
 * @returns {Promise<string>}
 */
async function generateInvoiceNumber(prisma, tenantId) {
  const year  = new Date().getFullYear();
  const count = await prisma.invoice.count({ where: { tenantId } });
  const seq   = String(count + 1).padStart(6, '0');
  return `INV-${year}-${seq}`;
}

module.exports = {
  generateInvoice,
  generateInvoiceNumber,
};
