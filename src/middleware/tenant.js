'use strict';

/**
 * tenant.js — Multi-Tenant Isolation Middleware (v4)
 *
 * SECURITY FIX: Removed _tenantId query param for SUPER_ADMIN impersonation.
 *   Old: req.query._tenantId  ← shows in URLs, server logs, nginx logs, browser history
 *   New: req.headers['x-tenant-id'] only ← stays in headers, not logged by default
 *
 * ADDED: Trial expiry enforcement (checkTenantActive was previously only in planGuard)
 */

const prisma   = require('../config/database');
const ApiError = require('../utils/apiError');

/**
 * resolveTenant — loads Tenant record and attaches to req.tenant / req.tenantId
 * Must be called AFTER protect() middleware (needs req.user)
 */
const resolveTenant = async (req, res, next) => {
  try {
    // SUPER_ADMIN tenant impersonation — header ONLY (not query param)
    if (req.user.role === 'SUPER_ADMIN') {
      const targetTenantId = req.headers['x-tenant-id']; // ← FIXED: no query param

      if (targetTenantId) {
        const tenant = await prisma.tenant.findUnique({ where: { id: targetTenantId } });
        if (!tenant) return next(new ApiError(404, `Tenant not found: ${targetTenantId}`));
        req.tenant   = tenant;
        req.tenantId = tenant.id;
        // Audit: log SUPER_ADMIN impersonation
        try {
          const logger = require('../utils/logger');
          logger.warn('[Security] SUPER_ADMIN impersonation', {
            adminId:    req.user.id,
            adminEmail: req.user.email,
            tenantId:   tenant.id,
            tenantName: tenant.name,
            ip:         req.ip,
            method:     req.method,
            path:       req.path,
          });
        } catch (e) {}
        return next();
      }

      // SUPER_ADMIN without target → platform-level access (no tenant scope)
      req.tenant   = null;
      req.tenantId = null;
      return next();
    }

    // Regular user — tenant from their user record
    if (!req.user.tenantId) {
      return next(new ApiError(403, 'Your account is not associated with any company'));
    }

    const tenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId } });

    if (!tenant) {
      return next(new ApiError(404, 'Company account not found. Please contact support.'));
    }

    // Status checks
    if (tenant.status === 'SUSPENDED') {
      return next(new ApiError(403,
        'Your account has been suspended. Contact support@mtos.in to resolve.'
      ));
    }

    if (tenant.status === 'CANCELLED') {
      return next(new ApiError(402,
        'Your subscription has been cancelled. Renew at Settings → Billing.'
      ));
    }

    if (tenant.status === 'TRIAL') {
      // Trial expired?
      if (tenant.trialEndsAt && new Date(tenant.trialEndsAt) < new Date()) {
        return next(new ApiError(402,
          `Your free trial ended on ${new Date(tenant.trialEndsAt).toLocaleDateString('en-IN')}. ` +
          'Subscribe at Settings → Billing to continue using MTOS.'
        ));
      }
    }

    req.tenant   = tenant;
    req.tenantId = tenant.id;
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * requireTenant — hard block if no tenant resolved.
 * Use on ALL routes that touch business data.
 */
const requireTenant = (req, res, next) => {
  if (!req.tenantId) {
    return next(new ApiError(403,
      'Tenant context required. Include x-tenant-id header or log in with a company account.'
    ));
  }
  next();
};

/**
 * checkEmployeeLimit — verify active employee count hasn't exceeded plan cap.
 * Kept for backward-compat with existing routes — planGuard.js has the full version.
 */
const checkEmployeeLimit = async (req, res, next) => {
  try {
    if (!req.tenantId) return next();

    const [count, limit] = await Promise.all([
      prisma.employee.count({ where: { tenantId: req.tenantId, status: { not: 'EXITED' } } }),
      Promise.resolve(req.tenant?.maxEmployees || 100),
    ]);

    if (count >= limit) {
      return next(new ApiError(402,
        `Employee limit reached (${count}/${limit}). Upgrade your plan to add more.`
      ));
    }

    req.employeeCount = count;
    req.employeeLimit = limit;
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { resolveTenant, requireTenant, checkEmployeeLimit };
