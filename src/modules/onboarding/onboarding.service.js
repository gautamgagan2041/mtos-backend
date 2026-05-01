'use strict';

/**
 * onboarding.service.js — Tenant self-registration and setup wizard
 *
 * FLOW:
 *   Step 1: Company registers (POST /api/onboarding/register)
 *           → Creates Tenant (TRIAL) + COMPANY_ADMIN user + sends welcome email
 *
 *   Step 2: Complete setup wizard (POST /api/onboarding/setup)
 *           → Saves: company details, EPF/ESIC reg numbers, PT state config
 *           → Marks onboardingComplete = true
 *
 *   Step 3: Add first client (guided through UI, calls existing /api/clients)
 *   Step 4: Add first tender (guided)
 *   Step 5: Configure salary structure (guided)
 *   Step 6: Run first payroll (guided)
 *
 * GET /api/onboarding/progress → returns checklist of completed steps
 */

const prisma               = require('../../config/database');
const bcrypt               = require('bcrypt');
const notificationService  = require('../../services/notificationService');
const audit                = require('../../services/auditService');

const TRIAL_DAYS = 14;

// ── Step 1: Register New Company ──────────────────────────────────

async function registerCompany({
  companyName,
  adminName,
  adminEmail,
  adminPassword,
  phone,
  state,
}) {
  // Validate required fields
  if (!companyName || !adminEmail || !adminPassword || !adminName) {
    const e = new Error('companyName, adminName, adminEmail, adminPassword are required');
    e.statusCode = 400; throw e;
  }

  if (adminPassword.length < 8) {
    const e = new Error('Password must be at least 8 characters');
    e.statusCode = 400; throw e;
  }

  // Check email not already used
  const existingUser = await prisma.user.findUnique({ where: { email: adminEmail.toLowerCase() } });
  if (existingUser) {
    const e = new Error(`An account already exists for email: ${adminEmail}`);
    e.statusCode = 409; throw e;
  }

  const passwordHash = await bcrypt.hash(adminPassword, 12);
  const trialEndsAt  = new Date(Date.now() + TRIAL_DAYS * 86_400_000);

  // Atomic: create tenant + admin user together
  const { tenant, user } = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        name:               companyName.trim(),
        slug:               _slugify(companyName),
        plan:               'STARTER',
        status:             'TRIAL',
        trialEndsAt,
        maxEmployees:       50,
        onboardingComplete: false,
        phone:              phone   || null,
        state:              state   || null,
      },
    });

    const user = await tx.user.create({
      data: {
        tenantId:     tenant.id,
        name:         adminName.trim(),
        email:        adminEmail.toLowerCase().trim(),
        passwordHash,
        role:         'COMPANY_ADMIN',
        isActive:     true,
      },
    });

    // Create default subscription record (TRIAL)
    await tx.tenantSubscription.create({
      data: {
        tenantId:       tenant.id,
        plan:           'STARTER',
        billingCycle:   'MONTHLY',
        amount:         0,
        currency:       'INR',
        nextBillingDate: trialEndsAt,
        isActive:       true,
      },
    });

    return { tenant, user };
  });

  // Send welcome email (fire-and-forget)
  notificationService.sendEmail({
    to:      adminEmail,
    subject: `Welcome to MTOS — Your free trial has started!`,
    html:    _welcomeEmailHTML(adminName, companyName, trialEndsAt),
  }).catch(() => {});

  await audit.log({
    tenantId:   tenant.id,
    userId:     user.id,
    action:     'COMPANY_REGISTERED',
    entityType: 'TENANT',
    entityId:   tenant.id,
    newValues:  { companyName, adminEmail, plan: 'STARTER', trialEndsAt },
  });

  return {
    tenant: {
      id:          tenant.id,
      name:        tenant.name,
      plan:        tenant.plan,
      status:      tenant.status,
      trialEndsAt: tenant.trialEndsAt,
    },
    user: {
      id:    user.id,
      name:  user.name,
      email: user.email,
      role:  user.role,
    },
    nextStep: 'Complete setup wizard at /onboarding/setup',
  };
}

// ── Step 2: Complete Setup Wizard ─────────────────────────────────

async function completeSetup(tenantId, data, actorUserId) {
  const {
    // Company details
    address, gstin, website,
    // Compliance registration numbers
    epfRegNo, esicRegNo, ptState,
    // Storage preference
    logoUrl,
  } = data;

  const tenant = await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      address:    address    || undefined,
      gstin:      gstin      || undefined,
      website:    website    || undefined,
      epfRegNo:   epfRegNo   || undefined,
      esicRegNo:  esicRegNo  || undefined,
      state:      ptState    || undefined,
      logoUrl:    logoUrl    || undefined,
      onboardingComplete: false, // Will be true after all steps done
    },
  });

  await audit.log({
    tenantId, userId: actorUserId,
    action: 'SETUP_COMPLETE', entityType: 'TENANT', entityId: tenantId,
    newValues: { epfRegNo, esicRegNo, address },
  });

  return { tenant, nextStep: 'Add your first client at /clients' };
}

// ── Onboarding Progress Checklist ────────────────────────────────

async function getProgress(tenantId) {
  const [tenant, clientCount, tenderCount, employeeCount, salaryStructureCount, payrollRunCount] =
    await Promise.all([
      prisma.tenant.findUnique({
        where:  { id: tenantId },
        select: { name: true, epfRegNo: true, esicRegNo: true, plan: true,
                  status: true, trialEndsAt: true, onboardingComplete: true },
      }),
      prisma.client.count({ where: { tenantId, isActive: true } }),
      prisma.tender.count({ where: { tenantId, status: 'ACTIVE' } }),
      prisma.employee.count({ where: { tenantId, status: { not: 'EXITED' } } }),
      prisma.salaryStructure.count({ where: { tenantId, isActive: true } }),
      prisma.payrollRun.count({ where: { tenantId, status: { in: ['COMPLETED', 'LOCKED'] } } }),
    ]);

  const steps = [
    {
      id:          'company_setup',
      label:       'Complete company setup',
      description: 'Add EPF/ESIC registration numbers, address',
      completed:   !!(tenant?.epfRegNo || tenant?.esicRegNo),
      action:      '/settings/company',
    },
    {
      id:          'add_client',
      label:       'Add your first client',
      description: 'Add a government or private client you supply manpower to',
      completed:   clientCount > 0,
      action:      '/clients/new',
    },
    {
      id:          'add_tender',
      label:       'Create your first tender/site',
      description: 'Create a tender for a client with details like location and duration',
      completed:   tenderCount > 0,
      action:      '/tenders/new',
    },
    {
      id:          'salary_structure',
      label:       'Configure salary structure',
      description: 'Define pay components (Basic, VDA, HRA, allowances)',
      completed:   salaryStructureCount > 0,
      action:      '/salary-structures/new',
    },
    {
      id:          'add_employees',
      label:       'Add employees',
      description: 'Upload or manually add workers deployed at the site',
      completed:   employeeCount > 0,
      action:      '/employees/new',
    },
    {
      id:          'run_payroll',
      label:       'Run your first payroll',
      description: 'Generate payroll for a month and download ECR files',
      completed:   payrollRunCount > 0,
      action:      '/payroll',
    },
  ];

  const completedCount = steps.filter(s => s.completed).length;
  const progressPct    = Math.round((completedCount / steps.length) * 100);
  const allComplete    = completedCount === steps.length;

  // Mark onboardingComplete if all steps done
  if (allComplete && !tenant?.onboardingComplete) {
    await prisma.tenant.update({
      where: { id: tenantId },
      data:  { onboardingComplete: true },
    });
  }

  return {
    tenant: {
      name:        tenant?.name,
      plan:        tenant?.plan,
      status:      tenant?.status,
      trialEndsAt: tenant?.trialEndsAt,
      trialDaysLeft: tenant?.trialEndsAt
        ? Math.max(0, Math.ceil((new Date(tenant.trialEndsAt) - new Date()) / 86_400_000))
        : null,
    },
    steps,
    progress:       { completed: completedCount, total: steps.length, percent: progressPct },
    allComplete,
    nextIncomplete: steps.find(s => !s.completed) || null,
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function _slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
    .slice(0, 50) + '-' + Date.now().toString(36);
}

function _welcomeEmailHTML(name, company, trialEndsAt) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1e40af; color: white; padding: 32px; border-radius: 8px 8px 0 0; text-align: center;">
        <h1 style="margin: 0; font-size: 28px;">Welcome to MTOS</h1>
        <p style="margin: 8px 0 0; opacity: 0.85;">Manpower Tender Operating System</p>
      </div>
      <div style="padding: 32px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <p>Hi <strong>${name}</strong>,</p>
        <p>Welcome to MTOS! Your account for <strong>${company}</strong> is ready.</p>
        <p>Your <strong>14-day free trial</strong> ends on
          <strong>${trialEndsAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</strong>.
        </p>
        <h3 style="color: #1e40af;">Get started in 3 steps:</h3>
        <ol>
          <li>Complete your company setup (EPF/ESIC numbers)</li>
          <li>Add your first client and tender</li>
          <li>Add employees and run your first payroll</li>
        </ol>
        <a href="${process.env.APP_URL || 'https://app.mtos.in'}"
           style="display: inline-block; margin-top: 16px; padding: 14px 28px;
                  background: #1e40af; color: white; border-radius: 6px;
                  text-decoration: none; font-weight: 700; font-size: 16px;">
          Open MTOS Dashboard →
        </a>
        <p style="margin-top: 24px; color: #6b7280; font-size: 13px;">
          Need help? Email us at <a href="mailto:support@mtos.in">support@mtos.in</a>
        </p>
      </div>
    </div>
  `;
}

module.exports = { registerCompany, completeSetup, getProgress };
