// prisma/seed.js — MTOS v2 Multi-Tenant Seed
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

// ── Default PayComponents for each tenant ─────────────────────────
async function seedPayComponents(tenantId) {
  const components = [
    // EARNINGS
    { code: 'BASIC',   name: 'Basic Salary',        type: 'EARNING',   isStatutory: false, displayOrder: 1 },
    { code: 'VDA',     name: 'Variable DA',          type: 'EARNING',   isStatutory: false, displayOrder: 2 },
    { code: 'HRA',     name: 'House Rent Allowance', type: 'EARNING',   isStatutory: false, displayOrder: 3 },
    { code: 'WASHING', name: 'Washing Allowance',    type: 'EARNING',   isStatutory: false, displayOrder: 4 },
    { code: 'BONUS',   name: 'Bonus',                type: 'EARNING',   isStatutory: true,  displayOrder: 5 },
    { code: 'UNIFORM', name: 'Uniform Allowance',    type: 'EARNING',   isStatutory: false, displayOrder: 6 },
    { code: 'OT',      name: 'Overtime',             type: 'EARNING',   isStatutory: false, displayOrder: 7 },
    { code: 'SPECIAL', name: 'Special Allowance',    type: 'EARNING',   isStatutory: false, displayOrder: 8 },
    { code: 'INCENTIVE', name: 'Incentive',          type: 'EARNING',   isStatutory: false, displayOrder: 9 },
    // DEDUCTIONS
    { code: 'PF_EE',   name: 'PF Employee (12%)',    type: 'DEDUCTION', isStatutory: true,  displayOrder: 1 },
    { code: 'ESIC_EE', name: 'ESIC Employee (0.75%)',type: 'DEDUCTION', isStatutory: true,  displayOrder: 2 },
    { code: 'PT',      name: 'Professional Tax',     type: 'DEDUCTION', isStatutory: true,  displayOrder: 3 },
    { code: 'ADVANCE', name: 'Advance Recovery',     type: 'DEDUCTION', isStatutory: false, displayOrder: 4 },
    { code: 'LOAN',    name: 'Loan Recovery',        type: 'DEDUCTION', isStatutory: false, displayOrder: 5 },
  ];

  for (const comp of components) {
    await prisma.payComponent.upsert({
      where: { tenantId_code: { tenantId, code: comp.code } },
      update: {},
      create: { ...comp, tenantId },
    });
  }
  console.log(`✅ PayComponents seeded for tenant: ${tenantId}`);
}

async function main() {
  console.log('🌱 Seeding MTOS v2 database...\n');

  // ── Platform Super Admin (no tenant) ──────────────────────
  const superAdminHash = await bcrypt.hash('SuperAdmin@123', 12);
  await prisma.user.upsert({
    where: { email: 'superadmin@mtos.platform' },
    update: {},
    create: {
      name: 'Platform Super Admin',
      email: 'superadmin@mtos.platform',
      passwordHash: superAdminHash,
      role: 'SUPER_ADMIN',
      tenantId: null,
    },
  });
  console.log('✅ Super Admin created (no tenant)');

  // ── Tenant 1: Everest HR Consultants ──────────────────────
  const tenant1 = await prisma.tenant.upsert({
    where: { slug: 'everest-hr' },
    update: {},
    create: {
      name: 'Everest Human Resource Consultants',
      slug: 'everest-hr',
      gstin: '09AABCE1234F1Z5',
      epfRegNo: 'UP/LKH/00001',
      esicRegNo: 'UP00001234',
      address: 'Near Civil Lines, Lakhimpur Kheri - 262701, U.P.',
      city: 'Lakhimpur Kheri',
      state: 'Uttar Pradesh',
      phone: '9876543210',
      email: 'info@everesthr.in',
      plan: 'PROFESSIONAL',
      status: 'ACTIVE',
      maxEmployees: 500,
      storageProvider: 'LOCAL',
    },
  });

  // ── Tenant 1 users ─────────────────────────────────────────
  const adminHash = await bcrypt.hash('Admin@123', 12);
  const hrHash    = await bcrypt.hash('Hr@123', 12);
  const acctHash  = await bcrypt.hash('Accounts@123', 12);
  const compHash  = await bcrypt.hash('Compliance@123', 12);

  await prisma.user.upsert({
    where: { email: 'admin@everesthr.in' },
    update: {},
    create: { name: 'Company Admin', email: 'admin@everesthr.in', passwordHash: adminHash, role: 'COMPANY_ADMIN', tenantId: tenant1.id },
  });
  await prisma.user.upsert({
    where: { email: 'hr@everesthr.in' },
    update: {},
    create: { name: 'HR Manager', email: 'hr@everesthr.in', passwordHash: hrHash, role: 'HR_MANAGER', tenantId: tenant1.id },
  });
  await prisma.user.upsert({
    where: { email: 'accounts@everesthr.in' },
    update: {},
    create: { name: 'Accounts Manager', email: 'accounts@everesthr.in', passwordHash: acctHash, role: 'ACCOUNTS', tenantId: tenant1.id },
  });
  await prisma.user.upsert({
    where: { email: 'compliance@everesthr.in' },
    update: {},
    create: { name: 'Compliance Officer', email: 'compliance@everesthr.in', passwordHash: compHash, role: 'COMPLIANCE', tenantId: tenant1.id },
  });
  console.log('✅ Tenant 1: Everest HR users created');

  // ── Tenant 2: Sanjeev Chauhan Security ────────────────────
  const tenant2 = await prisma.tenant.upsert({
    where: { slug: 'sanjeev-security' },
    update: {},
    create: {
      name: 'Sanjeev Chauhan Security Agency',
      slug: 'sanjeev-security',
      gstin: '09AABCS5678G1Z1',
      address: 'Agra, Uttar Pradesh',
      city: 'Agra',
      state: 'Uttar Pradesh',
      plan: 'STARTER',
      status: 'ACTIVE',
      maxEmployees: 100,
      storageProvider: 'LOCAL',
    },
  });

  await prisma.user.upsert({
    where: { email: 'admin@sanjeev-security.in' },
    update: {},
    create: {
      name: 'Sanjeev Chauhan',
      email: 'admin@sanjeev-security.in',
      passwordHash: adminHash,
      role: 'COMPANY_ADMIN',
      tenantId: tenant2.id,
    },
  });
  console.log('✅ Tenant 2: Sanjeev Security created');

  // ── PayComponents — dono tenants ke liye ──────────────────
  await seedPayComponents(tenant1.id);
  await seedPayComponents(tenant2.id);

  // ── Tenant 1 — Client & Tender data ───────────────────────
  const client = await prisma.client.upsert({
    where: { id: 'client-iocl-everest-01' },
    update: {},
    create: {
      id: 'client-iocl-everest-01',
      tenantId: tenant1.id,
      name: 'INDIAN OIL CORPORATION LTD',
      shortName: 'IOCL',
      gstin: '09AAACI1681G1ZN',
      address: 'INDANE BOTTLING PLANT, BEHJAM ROAD, LAKHIMPUR-KHERI - 262642, U.P.',
      state: 'Uttar Pradesh',
      stateCode: '09',
      phone: '05872-123456',
      email: 'lakhimpur@iocl.com',
    },
  });

  const tender = await prisma.tender.upsert({
    where: { id: 'tender-iocl-lkh-2526' },
    update: {},
    create: {
      id: 'tender-iocl-lkh-2526',
      tenantId: tenant1.id,
      clientId: client.id,
      name: 'IOCL Lakhimpur Kheri Security Services 2025-26',
      code: 'IOCL-LKH-SEC-2526',
      location: 'Lakhimpur Kheri, U.P.',
      startDate: new Date('2025-04-01'),
      endDate: new Date('2026-03-31'),
      
      status: 'ACTIVE',
      poNumber: '71954762',
      workOrder: 'LKM/LPG/SECURITY/2026-2027',
    },
  });

  // ── Legacy salary structures (billing fields removed — now in BillingConfig) ──
  const structures = [
    { rank: 'SUP', basicSalary: 26280.80, bonusEnabled: false },
    { rank: 'S/G', basicSalary: 19760,    bonusEnabled: true  },
  ];

  for (const s of structures) {
    await prisma.tenderSalaryStructure.upsert({
      where: { tenderId_rank: { tenderId: tender.id, rank: s.rank } },
      update: {},
      create: {
        tenderId: tender.id,
        ...s,
        vda: 0, hraType: 'percentage', hraValue: 0.08, hraMinimum: 1800,
        washingRate: 0.03, bonusRate: 0.0833, uniformRate: 0.05,
        pfRule: 'CAPPED', pfCap: 15000, pfEERate: 0.12, pfERRate: 0.13,
        esicEnabled: true, esicThreshold: 21000, esicEERate: 0.0075, esicERRate: 0.0325,
        baseDivisor: 26,
      },
    });
  }

  // ── BillingConfig for IOCL tender ─────────────────────────────
  await prisma.billingConfig.upsert({
    where: { tenderId: tender.id },
    update: {},
    create: {
      tenderId:            tender.id,
      gstMode:             'REVERSE_CHARGE',
      cgstRate:            0.09,
      sgstRate:            0.09,
      igstRate:            0,
      serviceChargeRate:   0.10,
      includeServiceCharge: true,
      invoicePrefix:       'GGGA',
      sacCode:             '998525',
      paymentTermsDays:    30,
    },
  });

  // ── ManpowerRequirements for IOCL tender ──────────────────────
  const requirements = [
    { categoryCode: 'SUP', categoryName: 'Supervisor',      requiredPosts: 3,  monthlyRate: 32000 },
    { categoryCode: 'S/G', categoryName: 'Security Guard',  requiredPosts: 14, monthlyRate: 22000 },
  ];

  for (const req of requirements) {
    await prisma.manpowerRequirement.upsert({
      where: {
        id: `req-${tender.id}-${req.categoryCode}`,
      },
      update: {},
      create: {
        id:            `req-${tender.id}-${req.categoryCode}`,
        tenderId:      tender.id,
        tenantId:      tenant1.id,
        categoryCode:  req.categoryCode,
        categoryName:  req.categoryName,
        requiredPosts: req.requiredPosts,
        monthlyRate:   req.monthlyRate,
        effectiveFrom: new Date('2025-04-01'),
        isActive:      true,
      },
    });
  }

  // Employees
  const employees = [
    { sr: 1,  uan: '101131010105', name: 'RAM AVTAR',          fatherName: 'SHRI RAM',            rank: 'SUP', bankAccount: '07180100022232', ifscCode: 'BARBOLAKHIM', bankName: 'Bank of Baroda' },
    { sr: 2,  uan: '101131042334', name: 'YASHPAL SINGH',      fatherName: 'ASHA SINGH',           rank: 'SUP' },
    { sr: 3,  uan: '101130991931', name: 'RAJESH KUMAR',       fatherName: 'RAM BILAS',            rank: 'SUP' },
    { sr: 4,  uan: '101135005471', name: 'JAGTAR SINGH',       fatherName: 'GURBACHAN SINGH',      rank: 'S/G' },
    { sr: 5,  uan: '101181243723', name: 'OM PRAKASH',         fatherName: 'PATI RAKHAN LAL',      rank: 'S/G' },
    { sr: 6,  uan: '101590351309', name: 'RAM SHANKAR GAUR',   fatherName: 'SOMESHWAR DATT GAUR',  rank: 'S/G' },
    { sr: 7,  uan: '101494704849', name: 'SANDIP KUMAR',       fatherName: 'BANKEY LAL',           rank: 'S/G' },
    { sr: 8,  uan: '10113127931',  name: 'RAM DAYAL',          fatherName: 'SOBI LAL',             rank: 'S/G' },
    { sr: 9,  uan: '101135118893', name: 'GULWINDER SINGH',    fatherName: 'GAJJAN SINGH',         rank: 'S/G' },
    { sr: 10, uan: '101833283148', name: 'RAKESH KUMAR VERMA', fatherName: 'GAYAPRASAD',           rank: 'S/G' },
    { sr: 11, uan: '101304027998', name: 'SATYAM MISHRA',      fatherName: 'PREM PRAKASH MISHRA',  rank: 'S/G' },
    { sr: 12, uan: '101556040829', name: 'JAI DEVI',           fatherName: 'RAMAVTAR',             rank: 'S/G', gender: 'Female' },
  ];

  for (const emp of employees) {
    const { rank, ...empData } = emp;
    const created = await prisma.employee.upsert({
      where: { tenantId_uan: { tenantId: tenant1.id, uan: emp.uan } },
      update: {},
      create: { ...empData, tenantId: tenant1.id, gender: emp.gender || 'Male' },
    });

    const existing = await prisma.tenderEmployee.findFirst({
      where: { tenderId: tender.id, employeeId: created.id },
    });
    if (!existing) {
      await prisma.tenderEmployee.create({
        data: { tenderId: tender.id, employeeId: created.id, rank, joiningDate: new Date('2025-04-01'), isActive: true },
      });
    }
  }
  console.log('✅ Employees created and mapped to IOCL tender');

  // Compliance documents
  const adminUser = await prisma.user.findUnique({ where: { email: 'admin@everesthr.in' } });
  const docs = [
    { docType: 'LABOUR_LICENSE',   name: 'Labour License - Lakhimpur Kheri', expiryDate: new Date('2026-03-31') },
    { docType: 'PASARA_LICENSE',   name: 'PASARA License - UP State',         expiryDate: new Date('2026-05-31') },
    { docType: 'TENDER_AGREEMENT', name: 'Service Agreement - IOCL 2025-26',  expiryDate: new Date('2026-03-31') },
    { docType: 'INSURANCE',        name: 'Workmen Compensation Insurance',     expiryDate: new Date('2026-03-31') },
    { docType: 'RENT_AGREEMENT',   name: 'Office Rent Agreement',              expiryDate: new Date('2025-12-31') },
  ];
  for (const doc of docs) {
    await prisma.complianceDocument.create({
      data: { ...doc, tenantId: tenant1.id, tenderId: tender.id, uploadedBy: adminUser.id },
    });
  }
  console.log('✅ Compliance documents created');

  // Sample alert
  await prisma.complianceAlert.create({
    data: {
      tenantId: tenant1.id,
      tenderId: tender.id,
      entityType: 'COMPLIANCE_DOC', entityId: 'sample',
      alertType: 'COMPLIANCE_EXPIRY_30D', severity: 'HIGH',
      title: 'Office Rent Agreement Expiring Soon',
      message: 'Rent Agreement expires on 31-Dec-2025. Please initiate renewal immediately.',
    },
  });

  console.log('\n🎉 Database seeded successfully!');
  console.log('\n📋 Login Credentials:');
  console.log('  superadmin@mtos.platform / SuperAdmin@123  [SUPER_ADMIN]');
  console.log('  admin@everesthr.in       / Admin@123       [COMPANY_ADMIN]');
  console.log('  hr@everesthr.in          / Hr@123          [HR_MANAGER]');
  console.log('  accounts@everesthr.in    / Accounts@123    [ACCOUNTS]');
  console.log('  admin@sanjeev-security.in/ Admin@123       [COMPANY_ADMIN]');
  console.log('\n⚠  Change all passwords before going to production!');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => await prisma.$disconnect());
