'use strict';

/**
 * subscription.service.js — SaaS subscription billing via Razorpay
 *
 * This bills YOUR clients (manpower companies) for using MTOS.
 * NOT the client's billing to their government clients (that's billing.service.js).
 *
 * FLOW:
 *   1. New manpower company signs up → TRIAL (14 days)
 *   2. Trial ends → upgrade prompt
 *   3. Admin selects plan → Razorpay subscription created
 *   4. Monthly auto-debit via Razorpay
 *   5. Webhook: payment_captured → keep active; payment_failed → suspend
 *
 * INSTALL:
 *   npm install razorpay
 *
 * ENV:
 *   RAZORPAY_KEY_ID=rzp_live_...
 *   RAZORPAY_KEY_SECRET=...
 *   RAZORPAY_WEBHOOK_SECRET=...
 */

const crypto = require('crypto');
const prisma  = require('../../config/database');
const logger  = require('../../utils/logger');

// ── Razorpay Plan IDs (create these in Razorpay dashboard first) ──
// Maps our plan names to Razorpay plan IDs
const RAZORPAY_PLAN_IDS = {
  STARTER:      process.env.RAZORPAY_PLAN_STARTER      || 'plan_starter',
  PROFESSIONAL: process.env.RAZORPAY_PLAN_PROFESSIONAL || 'plan_professional',
  BUSINESS:     process.env.RAZORPAY_PLAN_BUSINESS     || 'plan_business',
  ENTERPRISE:   null, // Enterprise is custom — sales-assisted
};

const PLAN_PRICES = {
  STARTER:      { monthly: 1999,  annual: 19990  },
  PROFESSIONAL: { monthly: 4999,  annual: 49990  },
  BUSINESS:     { monthly: 9999,  annual: 99990  },
  ENTERPRISE:   { monthly: null,  annual: null   }, // Custom pricing
};

let _razorpay = null;

function getRazorpay() {
  if (_razorpay) return _razorpay;
  try {
    const Razorpay = require('razorpay');
    _razorpay = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    return _razorpay;
  } catch {
    throw new Error('Razorpay not installed. Run: npm install razorpay');
  }
}

// ── Get Current Subscription ──────────────────────────────────────

async function getSubscription(tenantId) {
  const tenant = await prisma.tenant.findUnique({
    where:  { id: tenantId },
    select: {
      id: true, name: true, plan: true, status: true, trialEndsAt: true,
      maxEmployees: true, subscription: true,
    },
  });

  if (!tenant) { const e = new Error('Tenant not found'); e.statusCode = 404; throw e; }

  const trialDaysLeft = tenant.trialEndsAt
    ? Math.max(0, Math.ceil((new Date(tenant.trialEndsAt) - new Date()) / 86_400_000))
    : null;

  const employeeCount = await prisma.employee.count({
    where: { tenantId, status: { not: 'EXITED' } },
  });

  return {
    tenant:        { id: tenant.id, name: tenant.name },
    plan:          tenant.plan,
    status:        tenant.status,
    trialEndsAt:   tenant.trialEndsAt,
    trialDaysLeft,
    isTrialActive: tenant.status === 'TRIAL' && trialDaysLeft > 0,
    subscription:  tenant.subscription || null,
    usage: {
      employees:    employeeCount,
      employeeLimit: tenant.maxEmployees || _getPlanEmployeeLimit(tenant.plan),
    },
    availablePlans: _getAvailablePlans(),
  };
}

// ── Create Razorpay Subscription ──────────────────────────────────

async function createSubscription(tenantId, { plan, billingCycle, contactName, contactEmail }) {
  if (!RAZORPAY_PLAN_IDS[plan]) {
    const e = new Error(
      plan === 'ENTERPRISE'
        ? 'Enterprise plan requires contacting sales. Email: sales@mtos.in'
        : `Invalid plan: ${plan}`
    );
    e.statusCode = 400;
    throw e;
  }

  // Cancel existing subscription if any
  const existing = await prisma.tenantSubscription.findUnique({ where: { tenantId } });
  if (existing?.razorpaySubId && existing.isActive) {
    try {
      await getRazorpay().subscriptions.cancel(existing.razorpaySubId, { cancel_at_cycle_end: true });
    } catch (err) {
      logger.warn(`[Subscription] Failed to cancel old subscription: ${err.message}`);
    }
  }

  const planId    = RAZORPAY_PLAN_IDS[plan];
  const amount    = PLAN_PRICES[plan][billingCycle === 'ANNUAL' ? 'annual' : 'monthly'];

  // Create Razorpay subscription
  const rzpSub = await getRazorpay().subscriptions.create({
    plan_id:        planId,
    customer_notify: 1,
    quantity:       1,
    total_count:    billingCycle === 'ANNUAL' ? 1 : 12,
    notes: {
      tenant_id:   tenantId,
      plan,
      billing_cycle: billingCycle,
    },
  });

  const nextBillingDate = new Date();
  nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);

  // Save subscription in DB
  const sub = await prisma.tenantSubscription.upsert({
    where:  { tenantId },
    create: {
      tenantId,
      plan:             plan,
      billingCycle:     billingCycle || 'MONTHLY',
      amount,
      currency:         'INR',
      nextBillingDate,
      razorpaySubId:    rzpSub.id,
      razorpayPlanId:   planId,
      isActive:         true,
    },
    update: {
      plan,
      billingCycle:     billingCycle || 'MONTHLY',
      amount,
      nextBillingDate,
      razorpaySubId:    rzpSub.id,
      razorpayPlanId:   planId,
      isActive:         true,
      cancelledAt:      null,
      cancelReason:     null,
    },
  });

  // Update tenant plan
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      plan,
      status: 'ACTIVE',
      maxEmployees: _getPlanEmployeeLimit(plan),
    },
  });

  return {
    subscriptionId:     sub.id,
    razorpaySubId:      rzpSub.id,
    plan,
    amount,
    billingCycle,
    // Return Razorpay checkout details for frontend
    razorpay: {
      key:             process.env.RAZORPAY_KEY_ID,
      subscription_id: rzpSub.id,
      name:           'MTOS — Manpower ERP',
      description:    `${plan} Plan — ${billingCycle}`,
      prefill: {
        name:  contactName,
        email: contactEmail,
      },
    },
  };
}

// ── Webhook Handler — Razorpay Events ─────────────────────────────

async function handleWebhook(rawBody, signature) {
  // Verify webhook signature
  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  if (expectedSig !== signature) {
    logger.warn('[Subscription] Webhook signature mismatch');
    const e = new Error('Invalid webhook signature'); e.statusCode = 400; throw e;
  }

  const event = JSON.parse(rawBody);
  const { event: eventName, payload } = event;

  logger.info(`[Subscription] Webhook received: ${eventName}`);

  switch (eventName) {
    case 'subscription.activated':
      await _handleActivated(payload.subscription.entity);
      break;

    case 'invoice.payment_failed':
      await _handlePaymentFailed(payload.subscription?.entity);
      break;

    case 'subscription.cancelled':
      await _handleCancelled(payload.subscription.entity);
      break;

    case 'invoice.paid':
      await _handleInvoicePaid(payload.invoice.entity, payload.subscription?.entity);
      break;

    default:
      logger.info(`[Subscription] Unhandled webhook event: ${eventName}`);
  }

  return { received: true, event: eventName };
}

// ── Cancel Subscription ───────────────────────────────────────────

async function cancelSubscription(tenantId, reason) {
  const sub = await prisma.tenantSubscription.findUnique({ where: { tenantId } });
  if (!sub) { const e = new Error('No subscription found'); e.statusCode = 404; throw e; }

  if (sub.razorpaySubId) {
    try {
      await getRazorpay().subscriptions.cancel(sub.razorpaySubId, { cancel_at_cycle_end: true });
    } catch (err) {
      logger.warn(`[Subscription] Razorpay cancel failed: ${err.message}`);
    }
  }

  await prisma.tenantSubscription.update({
    where: { tenantId },
    data:  { isActive: false, cancelledAt: new Date(), cancelReason: reason || 'User cancelled' },
  });

  logger.info(`[Subscription] Cancelled for tenant ${tenantId}: ${reason}`);
  return { cancelled: true };
}

// ── Private Handlers ──────────────────────────────────────────────

async function _handleActivated(subscription) {
  const tenantId = subscription.notes?.tenant_id;
  if (!tenantId) return;
  await prisma.tenant.update({
    where: { id: tenantId },
    data:  { status: 'ACTIVE' },
  });
  logger.info(`[Subscription] Activated for tenant ${tenantId}`);
}

async function _handlePaymentFailed(subscription) {
  if (!subscription) return;
  const tenantId = subscription.notes?.tenant_id;
  if (!tenantId) return;

  // After 2 failed attempts, suspend the account
  const failedCount = subscription.paid_count || 0;
  if (failedCount === 0) { // First payment never completed
    await prisma.tenant.update({
      where: { id: tenantId },
      data:  { status: 'SUSPENDED' },
    });
    logger.warn(`[Subscription] Payment failed → SUSPENDED tenant ${tenantId}`);
  }
}

async function _handleCancelled(subscription) {
  const tenantId = subscription.notes?.tenant_id;
  if (!tenantId) return;
  await prisma.tenantSubscription.updateMany({
    where: { tenantId },
    data:  { isActive: false, cancelledAt: new Date() },
  });
  logger.info(`[Subscription] Cancelled for tenant ${tenantId}`);
}

async function _handleInvoicePaid(invoice, subscription) {
  if (!subscription) return;
  const tenantId = subscription.notes?.tenant_id;
  if (!tenantId) return;

  // Record payment
  const sub = await prisma.tenantSubscription.findUnique({ where: { tenantId } });
  if (sub) {
    await prisma.subscriptionInvoice.create({
      data: {
        subscriptionId:    sub.id,
        amount:            invoice.amount / 100, // Razorpay returns paise
        currency:          invoice.currency,
        status:            'PAID',
        razorpayInvoiceId: invoice.id,
        paidAt:            new Date(invoice.paid_at * 1000),
      },
    });

    // Update next billing date
    const nextDate = new Date();
    nextDate.setMonth(nextDate.getMonth() + 1);
    await prisma.tenantSubscription.update({
      where: { id: sub.id },
      data:  { nextBillingDate: nextDate },
    });
  }

  // Ensure tenant is ACTIVE
  await prisma.tenant.update({
    where: { id: tenantId },
    data:  { status: 'ACTIVE' },
  });
}

// ── Helpers ───────────────────────────────────────────────────────

function _getPlanEmployeeLimit(plan) {
  const limits = { STARTER: 50, PROFESSIONAL: 200, BUSINESS: 1000, ENTERPRISE: 999999 };
  return limits[plan] || 50;
}

function _getAvailablePlans() {
  return [
    {
      id: 'STARTER', name: 'Starter',
      price: PLAN_PRICES.STARTER,
      employeeLimit: 50,
      features: ['Payroll', 'Attendance', 'PF/ESIC Challans', 'Payslip PDF', 'Documents'],
    },
    {
      id: 'PROFESSIONAL', name: 'Professional',
      price: PLAN_PRICES.PROFESSIONAL,
      employeeLimit: 200,
      features: ['All Starter +', 'Client Billing', 'Compliance Tracking', 'Basic Reports', 'Disbursements'],
    },
    {
      id: 'BUSINESS', name: 'Business',
      price: PLAN_PRICES.BUSINESS,
      employeeLimit: 1000,
      features: ['All Professional +', 'Advanced Reports', 'Cost Analytics', 'API Access', 'Bulk Exports', 'Audit Logs'],
    },
    {
      id: 'ENTERPRISE', name: 'Enterprise',
      price: { monthly: null, annual: null },
      employeeLimit: null,
      features: ['All Business +', 'Unlimited Employees', 'White-labelling', 'Custom Integrations', 'Dedicated Support'],
    },
  ];
}

module.exports = {
  getSubscription,
  createSubscription,
  handleWebhook,
  cancelSubscription,
};
