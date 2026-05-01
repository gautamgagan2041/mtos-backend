'use strict';

/**
 * planGuard.js — Tenant Plan Feature Gating
 *
 * USAGE in routes:
 *   const { requireFeature, checkEmployeeLimit } = require('../middleware/planGuard');
 *
 *   router.get('/reports', protect, resolveTenant, requireFeature('reports'), handler);
 *   router.post('/employees', protect, resolveTenant, checkEmployeeLimit, handler);
 *
 * PLAN MATRIX:
 *   STARTER:      Up to 50 employees, payroll, attendance
 *   PROFESSIONAL: Up to 200 employees, + billing, compliance, basic reports
 *   BUSINESS:     Up to 1000 employees, + advanced reports, API access
 *   ENTERPRISE:   Unlimited, all features, white-labelling
 */

const ApiError = require('../utils/apiError');
const prisma   = require('../config/database');

// ── Feature → Plan Matrix ─────────────────────────────────────────

const PLAN_FEATURES = {
  STARTER: [
    'employees',
    'attendance',
    'payroll',
    'payslip',
    'pf_challan',
    'esic_challan',
    'documents',
    'compliance_basic',
  ],
  PROFESSIONAL: [
    'employees',
    'attendance',
    'payroll',
    'payslip',
    'pf_challan',
    'esic_challan',
    'documents',
    'compliance_basic',
    'compliance_advanced',
    'billing',
    'invoices',
    'reports_basic',
    'disbursements',
    'tenders',
    'clients',
  ],
  BUSINESS: [
    'employees',
    'attendance',
    'payroll',
    'payslip',
    'pf_challan',
    'esic_challan',
    'documents',
    'compliance_basic',
    'compliance_advanced',
    'billing',
    'invoices',
    'reports_basic',
    'reports_advanced',
    'disbursements',
    'tenders',
    'clients',
    'api_access',
    'bulk_export',
    'audit_logs',
    'multi_state',
  ],
  ENTERPRISE: [
    '*', // All features
  ],
};

// ── Employee Limits per Plan ──────────────────────────────────────

const PLAN_EMPLOYEE_LIMITS = {
  STARTER:      50,
  PROFESSIONAL: 200,
  BUSINESS:     1000,
  ENTERPRISE:   Infinity,
};

// ── Middleware: requireFeature ─────────────────────────────────────

/**
 * requireFeature(featureName) — check if tenant's plan includes this feature
 * Must be used AFTER resolveTenant middleware
 */
const requireFeature = (featureName) => (req, res, next) => {
  const plan    = req.tenant?.plan || 'STARTER';
  const allowed = PLAN_FEATURES[plan] || PLAN_FEATURES.STARTER;

  // ENTERPRISE has wildcard '*' = all features
  if (allowed.includes('*') || allowed.includes(featureName)) {
    return next();
  }

  return next(new ApiError(402,
    `Feature "${featureName}" is not available on your current plan (${plan}). ` +
    `Please upgrade to access this feature.`
  ));
};

// ── Middleware: checkEmployeeLimit ────────────────────────────────

/**
 * checkEmployeeLimit — verify tenant hasn't exceeded plan's employee cap
 * Use on POST /employees routes
 */
const checkEmployeeLimit = async (req, res, next) => {
  try {
    if (!req.tenantId) return next();

    const plan        = req.tenant?.plan || 'STARTER';
    const planLimit   = PLAN_EMPLOYEE_LIMITS[plan] || 50;
    const configLimit = req.tenant?.maxEmployees || planLimit;
    const limit       = Math.min(planLimit, configLimit); // Use the stricter of the two

    if (limit === Infinity) return next(); // ENTERPRISE: no limit

    const count = await prisma.employee.count({
      where: { tenantId: req.tenantId, status: { not: 'EXITED' } },
    });

    if (count >= limit) {
      return next(new ApiError(402,
        `Employee limit reached (${count}/${limit}). ` +
        `Upgrade your plan to add more employees.`
      ));
    }

    // Attach for downstream use
    req.employeeCount = count;
    req.employeeLimit = limit;
    next();
  } catch (err) {
    next(err);
  }
};

// ── Middleware: checkTenantActive ─────────────────────────────────

/**
 * checkTenantActive — block SUSPENDED/CANCELLED tenants
 * Already done in resolveTenant, but add here for defense-in-depth
 */
const checkTenantActive = (req, res, next) => {
  const status = req.tenant?.status;
  if (status === 'SUSPENDED') {
    return next(new ApiError(403,
      'Your account has been suspended. Please contact support@mtos.in'
    ));
  }
  if (status === 'CANCELLED') {
    return next(new ApiError(403,
      'Your subscription has been cancelled. Please renew at billing settings.'
    ));
  }
  if (status === 'TRIAL') {
    const trialEndsAt = req.tenant?.trialEndsAt;
    if (trialEndsAt && new Date(trialEndsAt) < new Date()) {
      return next(new ApiError(402,
        'Your trial period has ended. Please subscribe to continue.'
      ));
    }
  }
  next();
};

// ── Utility: getFeatureList ───────────────────────────────────────

function getFeatureList(plan) {
  const features = PLAN_FEATURES[plan] || PLAN_FEATURES.STARTER;
  if (features.includes('*')) return Object.values(PLAN_FEATURES).flat();
  return features;
}

function getPlanInfo(plan) {
  return {
    plan,
    features:      getFeatureList(plan),
    employeeLimit: PLAN_EMPLOYEE_LIMITS[plan] || 50,
  };
}

module.exports = {
  requireFeature,
  checkEmployeeLimit,
  checkTenantActive,
  getFeatureList,
  getPlanInfo,
  PLAN_FEATURES,
  PLAN_EMPLOYEE_LIMITS,
};
