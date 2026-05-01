'use strict';

/**
 * auth.js — Enhanced Auth Middleware v4
 *
 * ADDITIONS vs v3:
 *  1. PERMISSIONS table is now extensible (add new permissions without code change)
 *  2. canForTender(permission, tenderId) — per-tender resource-level RBAC
 *  3. isSuperAdmin / isCompanyAdmin helpers
 *  4. Password policy validator (for change-password, register)
 */

const jwt    = require('jsonwebtoken');
const prisma = require('../config/database');
const ApiError = require('../utils/apiError');

// ── Permission Matrix ─────────────────────────────────────────────
// Role → [list of allowed permissions]
// Add new roles/permissions here without touching route files.

const ROLE_PERMISSIONS = {
  SUPER_ADMIN: [
    'canManageEmployees', 'canRunPayroll', 'canManageTenders',
    'canManageUsers', 'canViewReports', 'canManageCompliance',
    'canViewAuditLog', 'canManageClients', 'canManageBilling',
    'canManageSubscription',
  ],
  COMPANY_ADMIN: [
    'canManageEmployees', 'canRunPayroll', 'canManageTenders',
    'canManageUsers', 'canViewReports', 'canManageCompliance',
    'canViewAuditLog', 'canManageClients', 'canManageBilling',
    'canManageSubscription',
  ],
  ACCOUNTS: [
    'canRunPayroll', 'canViewReports', 'canManageBilling',
    'canManageCompliance',
  ],
  HR_MANAGER: [
    'canManageEmployees', 'canManageTenders', 'canViewReports',
    'canManageCompliance', 'canManageClients',
  ],
  COMPLIANCE: [
    'canManageCompliance', 'canViewReports',
  ],
  VIEWER: [
    'canViewReports',
  ],
};

// ── Core Middleware ───────────────────────────────────────────────

const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return next(new ApiError(401, 'Authentication required. Include Bearer token in Authorization header.'));
    }

    const token = authHeader.split(' ')[1];
    let decoded;

    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET, {
        issuer:   'mtos',
        audience: 'mtos-users',
      });
    } catch (e) {
      if (e.name === 'TokenExpiredError') {
        return next(new ApiError(401, 'Session expired. Please log in again.'));
      }
      return next(new ApiError(401, 'Invalid authentication token.'));
    }

    const user = await prisma.user.findUnique({
      where:  { id: decoded.id },
      select: {
        id: true, name: true, email: true, role: true,
        tenantId: true, isActive: true, phone: true,
      },
    });

    if (!user)          return next(new ApiError(401, 'Account not found.'));
    if (!user.isActive) return next(new ApiError(401, 'Account has been deactivated. Contact your administrator.'));

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * can(permission) — role-based permission check
 */
const can = (permission) => (req, res, next) => {
  if (!req.user) return next(new ApiError(401, 'Not authenticated'));

  const userPermissions = ROLE_PERMISSIONS[req.user.role] || [];
  if (!userPermissions.includes(permission)) {
    return next(new ApiError(403,
      `Your role (${req.user.role}) does not have permission: ${permission}`
    ));
  }
  next();
};

/**
 * authorize(...roles) — role-level gate
 */
const authorize = (...roles) => (req, res, next) => {
  if (!req.user) return next(new ApiError(401, 'Not authenticated'));
  if (!roles.includes(req.user.role)) {
    return next(new ApiError(403,
      `Access restricted. Required roles: ${roles.join(', ')}`
    ));
  }
  next();
};

/**
 * canForTender(permission) — per-tender resource-level check
 *
 * Checks if:
 *   a) User has the permission by role (covers most cases), OR
 *   b) User has explicit per-tender assignment (for limited HR users)
 *
 * Usage: router.post('/:tenderId/run', protect, resolveTenant, canForTender('canRunPayroll'))
 */
const canForTender = (permission) => async (req, res, next) => {
  try {
    if (!req.user) return next(new ApiError(401, 'Not authenticated'));

    const tenderId = req.params.tenderId || req.params.id || req.body.tenderId;

    // Check role-level permission first (fast path)
    const userPermissions = ROLE_PERMISSIONS[req.user.role] || [];
    if (userPermissions.includes(permission)) return next();

    // Check per-tender assignment (for VIEWER or limited roles)
    if (tenderId) {
      const assignment = await prisma.userTenderPermission.findFirst({
        where: {
          userId:   req.user.id,
          tenderId,
          [_permToField(permission)]: true,
        },
      });
      if (assignment) return next();
    }

    return next(new ApiError(403,
      `You don't have permission to perform this action on this tender`
    ));
  } catch (err) {
    next(err);
  }
};

// ── Convenience Guards ────────────────────────────────────────────

const isSuperAdmin = (req, res, next) => {
  if (req.user?.role !== 'SUPER_ADMIN') {
    return next(new ApiError(403, 'Super admin access required'));
  }
  next();
};

const isCompanyAdmin = (req, res, next) => {
  if (!['SUPER_ADMIN', 'COMPANY_ADMIN'].includes(req.user?.role)) {
    return next(new ApiError(403, 'Company admin access required'));
  }
  next();
};

// ── Password Policy ───────────────────────────────────────────────

const PASSWORD_POLICY = {
  minLength:        8,
  requireUppercase: false, // Set to true for enterprise
  requireNumber:    true,
  requireSpecial:   false,
  maxLength:        128,
};

/**
 * validatePassword — returns array of violation messages
 * Empty array = valid password
 */
function validatePassword(password) {
  const errors = [];
  if (!password || typeof password !== 'string') {
    return ['Password is required'];
  }
  if (password.length < PASSWORD_POLICY.minLength) {
    errors.push(`Password must be at least ${PASSWORD_POLICY.minLength} characters`);
  }
  if (password.length > PASSWORD_POLICY.maxLength) {
    errors.push(`Password must be less than ${PASSWORD_POLICY.maxLength} characters`);
  }
  if (PASSWORD_POLICY.requireNumber && !/\d/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  if (PASSWORD_POLICY.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  if (PASSWORD_POLICY.requireSpecial && !/[^a-zA-Z0-9]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }
  return errors;
}

// ── User Management helpers ───────────────────────────────────────

/**
 * getUserPermissions — return permission list for a user role
 * Used by frontend to conditionally show/hide UI elements
 */
function getUserPermissions(role) {
  return ROLE_PERMISSIONS[role] || [];
}

// ── Helper ────────────────────────────────────────────────────────

function _permToField(permission) {
  const map = {
    canRunPayroll:       'canRunPayroll',
    canManageEmployees:  'canEdit',
    canViewReports:      'canView',
  };
  return map[permission] || 'canEdit';
}

module.exports = {
  protect, can, authorize, canForTender,
  isSuperAdmin, isCompanyAdmin,
  validatePassword, getUserPermissions,
  ROLE_PERMISSIONS,
};
