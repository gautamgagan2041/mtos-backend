const { PrismaClient, AlertType } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || 'Admin@123';

// ── PAY COMPONENTS (v3.1 FIXED: added nature) ────────────────────
async function seedPayComponents(tenantId) {
  const components = [
    // ── EARNINGS ──
    { code: 'BASIC', name: 'Basic Salary', type: 'EARNING', nature: 'EARNING', displayOrder: 1 },
    { code: 'VDA', name: 'Variable DA', type: 'EARNING', nature: 'EARNING', displayOrder: 2 },
    { code: 'HRA', name: 'House Rent Allowance', type: 'EARNING', nature: 'EARNING', displayOrder: 3 },
    { code: 'WASHING', name: 'Washing Allowance', type: 'EARNING', nature: 'TENDER_COST', displayOrder: 4 },
    { code: 'BONUS', name: 'Bonus', type: 'EARNING', nature: 'PROVISION', isStatutory: true, displayOrder: 5 },
    { code: 'UNIFORM', name: 'Uniform Allowance', type: 'EARNING', nature: 'TENDER_COST', displayOrder: 6 },
    { code: 'OT', name: 'Overtime', type: 'EARNING', nature: 'EARNING', displayOrder: 7 },
    { code: 'SPECIAL', name: 'Special Allowance', type: 'EARNING', nature: 'EARNING', displayOrder: 8 },

    // ── DEDUCTIONS ──
    { code: 'PF_EE', name: 'PF Employee (12%)', type: 'DEDUCTION', nature: 'DEDUCTION', isStatutory: true, displayOrder: 1 },
    { code: 'ESIC_EE', name: 'ESIC Employee', type: 'DEDUCTION', nature: 'DEDUCTION', isStatutory: true, displayOrder: 2 },
    { code: 'PT', name: 'Professional Tax', type: 'DEDUCTION', nature: 'DEDUCTION', isStatutory: true, displayOrder: 3 },

    // ── EMPLOYER COST (NEW) ──
    { code: 'PF_ER', name: 'PF Employer', type: 'DEDUCTION', nature: 'EMPLOYER_COST', isStatutory: true, displayOrder: 10 },
    { code: 'ESIC_ER', name: 'ESIC Employer', type: 'DEDUCTION', nature: 'EMPLOYER_COST', isStatutory: true, displayOrder: 11 },

    // ── PROVISIONS ──
    { code: 'GRATUITY', name: 'Gratuity', type: 'EARNING', nature: 'PROVISION', displayOrder: 20 },

    // ── TENDER COST ──
    { code: 'RELIEVER', name: 'Reliever Cost', type: 'EARNING', nature: 'TENDER_COST', displayOrder: 30 },
  ];

  await Promise.all(
    components.map(comp =>
      prisma.payComponent.upsert({
        where: { tenantId_code: { tenantId, code: comp.code } },
        update: {},
        create: { ...comp, tenantId, isStatutory: comp.isStatutory || false },
      })
    )
  );

  console.log(`✅ PayComponents seeded`);
}

// ── MAIN ─────────────────────────────────────────────────────────
async function main() {
  console.log('🌱 Seeding MTOS v3.1...');

  const hash = await bcrypt.hash(DEFAULT_PASSWORD, 12);

  // ── SUPER ADMIN ──
  await prisma.user.upsert({
    where: { email: 'superadmin@mtos.platform' },
    update: {},
    create: {
      name: 'Super Admin',
      email: 'superadmin@mtos.platform',
      passwordHash: hash,
      role: 'SUPER_ADMIN',
    },
  });

  // ── TENANT ──
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'everest-hr' },
    update: {},
    create: {
      name: 'Everest HR',
      slug: 'everest-hr',
      plan: 'PROFESSIONAL',
      status: 'ACTIVE',
    },
  });

  // ── USERS ──
  const users = [
    { email: 'admin@everesthr.in', role: 'COMPANY_ADMIN' },
    { email: 'hr@everesthr.in', role: 'HR_MANAGER' },
  ];

  await Promise.all(
    users.map(u =>
      prisma.user.upsert({
        where: { email: u.email },
        update: {},
        create: {
          name: u.email,
          email: u.email,
          passwordHash: hash,
          role: u.role,
          tenantId: tenant.id,
        },
      })
    )
  );

  // ── PAY COMPONENTS ──
  await seedPayComponents(tenant.id);

  // ── CLIENT ──
  const client = await prisma.client.upsert({
    where: { id: 'client-1' },
    update: {},
    create: {
      id: 'client-1',
      tenantId: tenant.id,
      name: 'IOCL',
    },
  });

  // ── TENDER ──
  const tender = await prisma.tender.upsert({
    where: { id: 'tender-1' },
    update: {},
    create: {
      id: 'tender-1',
      tenantId: tenant.id,
      clientId: client.id,
      name: 'IOCL Tender',
      startDate: new Date(),
      endDate: new Date(),
    },
  });

  // ── BILLING CONFIG (IMPORTANT) ──
  await prisma.billingConfig.upsert({
    where: { tenderId: tender.id },
    update: {},
    create: {
      tenderId: tender.id,
      gstMode: 'REVERSE_CHARGE',
    },
  });

  // ── EMPLOYEE ──
  const emp = await prisma.employee.upsert({
    where: { tenantId_uan: { tenantId: tenant.id, uan: '123' } },
    update: {},
    create: {
      name: 'Test Employee',
      uan: '123',
      tenantId: tenant.id,
      gender: 'Male',
    },
  });

  // ── TENDER EMPLOYEE (SAFE UPSERT) ──
  await prisma.tenderEmployee.upsert({
    where: {
      tenderId_employeeId: {
        tenderId: tender.id,
        employeeId: emp.id,
      },
    },
    update: {},
    create: {
      tenderId: tender.id,
      employeeId: emp.id,
      rank: 'SUP',
      joiningDate: new Date(),
    },
  });

  // ── ADMIN (FIXED QUERY) ──
  const admin = await prisma.user.findFirst({
    where: { tenantId: tenant.id },
  });

  // ── COMPLIANCE DOCS ──
  const docs = [
    { docType: 'LABOUR_LICENSE', name: 'Labour License' },
    { docType: 'PASARA_LICENSE', name: 'PASARA License' },
  ];

  await Promise.all(
    docs.map(doc =>
      prisma.complianceDocument.upsert({
        where: {
          tenantId_tenderId_docType: {
            tenantId: tenant.id,
            tenderId: tender.id,
            docType: doc.docType,
          },
        },
        update: {},
        create: {
          ...doc,
          tenantId: tenant.id,
          tenderId: tender.id,
          uploadedBy: admin?.id,
        },
      })
    )
  );

  // ── ALERT (FIXED ENTITY TYPE) ──
  await prisma.complianceAlert.upsert({
    where: {
      tenantId_entityId_alertType: {
        tenantId: tenant.id,
        entityId: 'sample',
        alertType: AlertType.COMPLIANCE_EXPIRY_30D,
      },
    },
    update: {},
    create: {
      tenantId: tenant.id,
      tenderId: tender.id,
      entityType: 'COMPLIANCE_DOC',
      entityId: 'sample',
      alertType: AlertType.COMPLIANCE_EXPIRY_30D,
      severity: 'HIGH',
      title: 'Test Alert',
      message: 'Compliance document expiring soon',
    },
  });

  console.log('🎉 Seed complete (v3.1 ready)');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());