// src/middleware/tenant.js
// ── Multi-Tenant Isolation Middleware ────────────────────────
// Resolves the current tenant from JWT and attaches it to req.
// Every data query MUST include tenantId to prevent cross-tenant leaks.

const prisma = require('../config/database');
const ApiError = require('../utils/apiError');

/**
 * resolveTenant
 * 
 * Called AFTER protect() middleware.
 * Loads the full Tenant record and attaches it to req.tenant.
 * SUPER_ADMINs can pass ?tenantId= query param to access any tenant.
 */
const resolveTenant = async (req, res, next) => {
  try {
    // SUPER_ADMIN can impersonate any tenant via query param or header
    if (req.user.role === 'SUPER_ADMIN') {
      const targetTenantId = req.query._tenantId || req.headers['x-tenant-id'];
      if (targetTenantId) {
        const tenant = await prisma.tenant.findUnique({ where: { id: targetTenantId } });
        if (!tenant) return next(new ApiError(404, 'Tenant not found'));
        req.tenant = tenant;
        req.tenantId = tenant.id;
        return next();
      }
      // SUPER_ADMIN without target tenant → platform-level access
      req.tenant = null;
      req.tenantId = null;
      return next();
    }

    // Regular users → resolved from their user record
    if (!req.user.tenantId) {
      return next(new ApiError(403, 'User is not associated with any company'));
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
    });

    if (!tenant) return next(new ApiError(404, 'Company not found'));
    if (tenant.status === 'SUSPENDED') {
      return next(new ApiError(403, 'Your account has been suspended. Please contact support.'));
    }
    if (tenant.status === 'CANCELLED') {
      return next(new ApiError(403, 'Your subscription has been cancelled.'));
    }

    req.tenant = tenant;
    req.tenantId = tenant.id;
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * requireTenant
 * 
 * Strict version — rejects if no tenant resolved.
 * Use on all routes that touch business data.
 */
const requireTenant = (req, res, next) => {
  if (!req.tenantId) {
    return next(new ApiError(403, 'Tenant context required for this operation'));
  }
  next();
};

/**
 * checkEmployeeLimit
 * 
 * Validates tenant hasn't exceeded their plan's employee cap.
 * Use on POST /employees.
 */
const checkEmployeeLimit = async (req, res, next) => {
  try {
    if (!req.tenantId) return next();
    const count = await prisma.employee.count({
      where: { tenantId: req.tenantId, status: { not: 'EXITED' } },
    });
    const limit = req.tenant?.maxEmployees || 100;
    if (count >= limit) {
      return next(new ApiError(402, 
        `Employee limit reached (${count}/${limit}). Please upgrade your plan.`
      ));
    }
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { resolveTenant, requireTenant, checkEmployeeLimit };
