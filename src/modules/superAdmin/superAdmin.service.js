'use strict';

/**
 * superAdmin.service.js — Platform-level administration
 *
 * ONLY accessible to SUPER_ADMIN role.
 * Provides visibility and control across ALL tenants.
 *
 * Features:
 *  1. Platform dashboard (revenue, active tenants, total employees)
 *  2. Tenant list with usage metrics
 *  3. Tenant detail + impersonation token
 *  4. Manual plan override (for sales deals)
 *  5. Suspend / reactivate tenants
 *  6. Global system health
 */

const prisma = require('../../config/database');
const jwt    = require('jsonwebtoken');
const logger = require('../../utils/logger');

// ── Platform Dashboard ────────────────────────────────────────────

async function getPlatformStats() {
  const [
    totalTenants,
    activeTenants,
    trialTenants,
    suspendedTenants,
    totalEmployees,
    totalPayrollRuns,
    planBreakdown,
    recentSignups,
  ] = await Promise.all([
    prisma.tenant.count(),
    prisma.tenant.count({ where: { status: 'ACTIVE'    } }),
    prisma.tenant.count({ where: { status: 'TRIAL'     } }),
    prisma.tenant.count({ where: { status: 'SUSPENDED' } }),
    prisma.employee.count({ where: { status: { not: 'EXITED' } } }),
    prisma.payrollRun.count({ where: { status: { in: ['COMPLETED', 'LOCKED'] } } }),
    prisma.tenant.groupBy({
      by:     ['plan'],
      _count: { id: true },
    }),
    prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      take:    10,
      select:  { id: true, name: true, plan: true, status: true, createdAt: true },
    }),
  ]);

  // Monthly Recurring Revenue estimate
  const PLAN_MRR = { STARTER: 1999, PROFESSIONAL: 4999, BUSINESS: 9999, ENTERPRISE: 0 };
  const planMap  = Object.fromEntries(planBreakdown.map(p => [p.plan, p._count.id]));
  const mrr      = Object.entries(PLAN_MRR).reduce((sum, [plan, price]) => {
    return sum + (planMap[plan] || 0) * price;
  }, 0);

  return {
    tenants: { total: totalTenants, active: activeTenants, trial: trialTenants, suspended: suspendedTenants },
    employees: { total: totalEmployees },
    payroll:   { totalRuns: totalPayrollRuns },
    revenue:   { estimatedMRR: mrr, estimatedARR: mrr * 12 },
    planBreakdown: planBreakdown.map(p => ({ plan: p.plan, count: p._count.id })),
    recentSignups,
  };
}

// ── Tenant List ───────────────────────────────────────────────────

async function listTenants({ status, plan, search, page = 1, limit = 50 } = {}) {
  const where = {};
  if (status) where.status = status;
  if (plan)   where.plan   = plan;
  if (search) {
    where.OR = [
      { name:  { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [tenants, total] = await Promise.all([
    prisma.tenant.findMany({
      where,
      include: {
        _count: {
          select: {
            users:     true,
            employees: { where: { status: { not: 'EXITED' } } },
            tenders:   { where: { status: 'ACTIVE' } },
            payrollRuns: { where: { status: { in: ['COMPLETED', 'LOCKED'] } } },
          },
        },
        subscription: { select: { plan: true, isActive: true, nextBillingDate: true, amount: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip:    (parseInt(page) - 1) * parseInt(limit),
      take:    parseInt(limit),
    }),
    prisma.tenant.count({ where }),
  ]);

  return { tenants, total, page: parseInt(page), limit: parseInt(limit) };
}

// ── Tenant Detail ─────────────────────────────────────────────────

async function getTenantDetail(tenantId) {
  const [tenant, stats] = await Promise.all([
    prisma.tenant.findUnique({
      where:   { id: tenantId },
      include: {
        users:        { select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true } },
        subscription: true,
        _count: {
          select: {
            employees:   { where: { status: { not: 'EXITED' } } },
            tenders:     { where: { status: 'ACTIVE' } },
            clients:     { where: { isActive: true } },
            payrollRuns: { where: { status: { in: ['COMPLETED', 'LOCKED'] } } },
          },
        },
      },
    }),
    // Last 6 months payroll volume
    prisma.payrollRun.findMany({
      where:   { tenantId, status: { in: ['COMPLETED', 'LOCKED'] } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take:    6,
      select: { month: true, year: true, totalGross: true, _count: { select: { rows: true } } },
    }),
  ]);

  if (!tenant) { const e = new Error('Tenant not found'); e.statusCode = 404; throw e; }

  return { tenant, payrollHistory: stats };
}

// ── Impersonation Token ───────────────────────────────────────────

/**
 * generateImpersonationToken — create a short-lived JWT for SUPER_ADMIN
 * to act as a specific tenant's admin user for debugging.
 *
 * Token expires in 15 minutes and is logged in audit.
 * The frontend uses this token like a normal JWT.
 */
async function generateImpersonationToken(superAdminId, targetTenantId) {
  const tenant = await prisma.tenant.findUnique({ where: { id: targetTenantId } });
  if (!tenant) { const e = new Error('Tenant not found'); e.statusCode = 404; throw e; }

  // Find the COMPANY_ADMIN of this tenant
  const adminUser = await prisma.user.findFirst({
    where: { tenantId: targetTenantId, role: 'COMPANY_ADMIN', isActive: true },
    select: { id: true, name: true, email: true, role: true, tenantId: true },
  });

  if (!adminUser) {
    const e = new Error('No active COMPANY_ADMIN found for this tenant');
    e.statusCode = 404; throw e;
  }

  // Short-lived token — 15 minutes only
  const token = jwt.sign(
    {
      id:              adminUser.id,
      impersonatedBy:  superAdminId,
      isImpersonation: true,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '15m',
      issuer:    'mtos',
      audience:  'mtos-users',
    }
  );

  logger.warn(`[SuperAdmin] Impersonation token generated for tenant ${targetTenantId} by ${superAdminId}`);

  return {
    token,
    expiresIn:   '15 minutes',
    tenantName:  tenant.name,
    adminEmail:  adminUser.email,
    WARNING:     'This token grants full COMPANY_ADMIN access. Use responsibly. Expires in 15 minutes.',
  };
}

// ── Plan Override ─────────────────────────────────────────────────

async function overridePlan(tenantId, { plan, maxEmployees, reason }, superAdminId) {
  const VALID_PLANS = ['STARTER', 'PROFESSIONAL', 'BUSINESS', 'ENTERPRISE'];
  if (!VALID_PLANS.includes(plan)) {
    const e = new Error(`Invalid plan: ${plan}. Must be one of: ${VALID_PLANS.join(', ')}`);
    e.statusCode = 400; throw e;
  }

  const updated = await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      plan,
      maxEmployees: maxEmployees ? parseInt(maxEmployees) : undefined,
      status:       'ACTIVE', // Ensure not suspended when manually upgrading
    },
  });

  logger.info(`[SuperAdmin] Plan override: tenant=${tenantId} plan=${plan} by=${superAdminId} reason="${reason}"`);

  return { tenant: updated, message: `Plan updated to ${plan}` };
}

// ── Suspend / Reactivate ──────────────────────────────────────────

async function suspendTenant(tenantId, reason, superAdminId) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) { const e = new Error('Tenant not found'); e.statusCode = 404; throw e; }
  if (tenant.status === 'SUSPENDED') {
    const e = new Error('Tenant is already suspended'); e.statusCode = 409; throw e;
  }

  await prisma.tenant.update({
    where: { id: tenantId },
    data:  { status: 'SUSPENDED' },
  });

  logger.warn(`[SuperAdmin] Tenant SUSPENDED: ${tenantId} by ${superAdminId}. Reason: ${reason}`);
  return { suspended: true, reason };
}

async function reactivateTenant(tenantId, superAdminId) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) { const e = new Error('Tenant not found'); e.statusCode = 404; throw e; }

  await prisma.tenant.update({
    where: { id: tenantId },
    data:  { status: 'ACTIVE' },
  });

  logger.info(`[SuperAdmin] Tenant REACTIVATED: ${tenantId} by ${superAdminId}`);
  return { reactivated: true };
}

// ── System Health ─────────────────────────────────────────────────

async function getSystemHealth() {
  const checks = {};

  // DB health
  try {
    const start = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { status: 'healthy', latencyMs: Date.now() - start };
  } catch (err) {
    checks.database = { status: 'unhealthy', error: err.message };
  }

  // Redis health
  try {
    const cache = require('../../services/cacheService');
    const start = Date.now();
    await cache.set('health:ping', '1', 5);
    const val = await cache.get('health:ping');
    checks.redis = { status: val === '1' ? 'healthy' : 'degraded', latencyMs: Date.now() - start };
  } catch (err) {
    checks.redis = { status: 'unhealthy', error: err.message };
  }

  // BullMQ queue metrics
  try {
    const { getQueueMetrics } = require('../../jobs/payroll.job');
    checks.payrollQueue = await getQueueMetrics();
    checks.payrollQueue.status = checks.payrollQueue.failed > 0 ? 'degraded' : 'healthy';
  } catch {
    checks.payrollQueue = { status: 'unavailable' };
  }

  // Storage health
  checks.storage = {
    provider: process.env.AWS_ACCESS_KEY_ID ? 'S3' : 'LOCAL',
    status:   'healthy',
  };

  const allHealthy = Object.values(checks).every(c => c.status === 'healthy');

  return {
    status:     allHealthy ? 'healthy' : 'degraded',
    timestamp:  new Date().toISOString(),
    version:    process.env.npm_package_version || '4.0.0',
    checks,
  };
}

// ── Cleanup: Expired Trial Tenants ────────────────────────────────

async function cleanupExpiredTrials() {
  const expiredTrials = await prisma.tenant.findMany({
    where: {
      status:      'TRIAL',
      trialEndsAt: { lt: new Date() },
    },
    select: { id: true, name: true, trialEndsAt: true },
  });

  if (expiredTrials.length === 0) return { cleaned: 0 };

  // Mark as CANCELLED (preserve data for 30 days before hard delete)
  await prisma.tenant.updateMany({
    where: { id: { in: expiredTrials.map(t => t.id) } },
    data:  { status: 'CANCELLED' },
  });

  logger.info(`[SuperAdmin] Cleaned up ${expiredTrials.length} expired trial tenants`);
  return { cleaned: expiredTrials.length, tenants: expiredTrials };
}

module.exports = {
  getPlatformStats,
  listTenants,
  getTenantDetail,
  generateImpersonationToken,
  overridePlan,
  suspendTenant,
  reactivateTenant,
  getSystemHealth,
  cleanupExpiredTrials,
};
