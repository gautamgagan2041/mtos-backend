// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const prisma = require('../config/database');
const ApiError = require('../utils/apiError');

/**
 * protect — validate JWT and attach req.user
 */
const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return next(new ApiError(401, 'No token provided'));
    }

    const token = authHeader.split(' ')[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      return next(new ApiError(401, e.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token'));
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true, name: true, email: true,
        role: true, tenantId: true, isActive: true,
      },
    });

    if (!user || !user.isActive) {
      return next(new ApiError(401, 'User not found or inactive'));
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * authorize(...roles) — role-based access guard
 * 
 * Usage: router.post('/', protect, authorize('SUPER_ADMIN', 'COMPANY_ADMIN'), handler)
 */
const authorize = (...roles) => (req, res, next) => {
  if (!req.user) return next(new ApiError(401, 'Not authenticated'));
  if (!roles.includes(req.user.role)) {
    return next(new ApiError(403,
      `Your role (${req.user.role}) is not authorized for this action`
    ));
  }
  next();
};

/**
 * Permission helpers — maps roles to capabilities
 */
const PERMISSIONS = {
  canManageEmployees:   ['SUPER_ADMIN', 'COMPANY_ADMIN', 'HR_MANAGER'],
  canRunPayroll:        ['SUPER_ADMIN', 'COMPANY_ADMIN', 'ACCOUNTS'],
  canManageTenders:     ['SUPER_ADMIN', 'COMPANY_ADMIN', 'HR_MANAGER'],
  canManageUsers:       ['SUPER_ADMIN', 'COMPANY_ADMIN'],
  canViewReports:       ['SUPER_ADMIN', 'COMPANY_ADMIN', 'ACCOUNTS', 'HR_MANAGER'],
  canManageCompliance:  ['SUPER_ADMIN', 'COMPANY_ADMIN', 'COMPLIANCE', 'HR_MANAGER'],
  canViewAuditLog:      ['SUPER_ADMIN', 'COMPANY_ADMIN'],
  canManageClients:     ['SUPER_ADMIN', 'COMPANY_ADMIN', 'HR_MANAGER'],
};

const can = (permission) => (req, res, next) => {
  const allowed = PERMISSIONS[permission];
  if (!allowed) return next(new ApiError(500, `Unknown permission: ${permission}`));
  if (!allowed.includes(req.user?.role)) {
    return next(new ApiError(403, `Insufficient permissions for ${permission}`));
  }
  next();
};
/**
 * requireTenant — protect ke baad use karo
 * Sets req.tenantId from:
 *   - x-tenant-id header (SUPER_ADMIN ke liye)
 *   - req.user.tenantId (baaki sab ke liye)
 */
const requireTenant = (req, res, next) => {
  if (!req.user) return next(new ApiError(401, 'Not authenticated'));

  if (req.user.role === 'SUPER_ADMIN') {
    // Super admin kisi bhi tenant pe kaam kar sakta hai
    const headerTenant = req.headers['x-tenant-id'];
    if (!headerTenant) {
      return next(new ApiError(400, 'Tenant context required: send x-tenant-id header'));
    }
    req.tenantId = headerTenant;
  } else {
    // Company Admin / HR / Accounts — token se milega
    if (!req.user.tenantId) {
      return next(new ApiError(400, 'Tenant context required for this operation'));
    }
    req.tenantId = req.user.tenantId;
  }

  next();
};
module.exports = { protect, authorize, can, requireTenant };
