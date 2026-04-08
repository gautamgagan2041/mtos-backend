// src/routes/tenants.js
const express = require('express');
const prisma = require('../config/database');
const { protect, authorize } = require('../middleware/auth');
const router = express.Router();

router.use(protect, authorize('SUPER_ADMIN'));

const DEFAULT_COMPONENTS = [
  { code: 'BASIC',   name: 'Basic Salary',         type: 'EARNING',   isStatutory: false, displayOrder: 1 },
  { code: 'VDA',     name: 'Variable DA',           type: 'EARNING',   isStatutory: false, displayOrder: 2 },
  { code: 'HRA',     name: 'House Rent Allowance',  type: 'EARNING',   isStatutory: false, displayOrder: 3 },
  { code: 'WASHING', name: 'Washing Allowance',     type: 'EARNING',   isStatutory: false, displayOrder: 4 },
  { code: 'BONUS',   name: 'Bonus',                 type: 'EARNING',   isStatutory: true,  displayOrder: 5 },
  { code: 'UNIFORM', name: 'Uniform Allowance',     type: 'EARNING',   isStatutory: false, displayOrder: 6 },
  { code: 'OT',      name: 'Overtime',              type: 'EARNING',   isStatutory: false, displayOrder: 7 },
  { code: 'SPECIAL', name: 'Special Allowance',     type: 'EARNING',   isStatutory: false, displayOrder: 8 },
  { code: 'PF_EE',   name: 'PF Employee (12%)',     type: 'DEDUCTION', isStatutory: true,  displayOrder: 1 },
  { code: 'ESIC_EE', name: 'ESIC Employee (0.75%)', type: 'DEDUCTION', isStatutory: true,  displayOrder: 2 },
  { code: 'PT',      name: 'Professional Tax',      type: 'DEDUCTION', isStatutory: true,  displayOrder: 3 },
  { code: 'ADVANCE', name: 'Advance Recovery',      type: 'DEDUCTION', isStatutory: false, displayOrder: 4 },
  { code: 'LOAN',    name: 'Loan Recovery',         type: 'DEDUCTION', isStatutory: false, displayOrder: 5 },
];

router.get('/', async (req, res, next) => {
  try {
    const tenants = await prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { users: true, employees: true, clients: true } } }
    });
    res.json({ success: true, data: tenants });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, slug, gstin, pan, epfRegNo, esicRegNo, address, city, state, phone, email, plan, adminName, adminEmail, adminPassword } = req.body;

    const existing = await prisma.tenant.findUnique({ where: { slug } });
    if (existing) return res.status(400).json({ success: false, message: 'Slug already taken' });

    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(adminPassword || 'Admin@123', 12);

    const tenant = await prisma.$transaction(async (tx) => {
      const t = await tx.tenant.create({
        data: {
          name, slug,
          gstin: gstin || null, pan: pan || null,
          epfRegNo: epfRegNo || null, esicRegNo: esicRegNo || null,
          address: address || null, city: city || null,
          state: state || null, phone: phone || null,
          email: email || null, plan: plan || 'STARTER', status: 'ACTIVE',
        }
      });

      await tx.user.create({
        data: {
          tenantId: t.id,
          name: adminName || name + ' Admin',
          email: adminEmail,
          passwordHash: hash,
          role: 'COMPANY_ADMIN',
          isActive: true,
        }
      });

      // ✅ Naye tenant ke liye default PayComponents auto-create
      await tx.payComponent.createMany({
        data: DEFAULT_COMPONENTS.map(c => ({ ...c, tenantId: t.id })),
      });

      return t;
    });

    res.status(201).json({ success: true, data: tenant });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      include: {
        users: { select: { id: true, name: true, email: true, role: true, isActive: true } },
        _count: { select: { employees: true, clients: true, tenders: true } }
      }
    });
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });
    res.json({ success: true, data: tenant });
  } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.update({ where: { id: req.params.id }, data: req.body });
    res.json({ success: true, data: tenant });
  } catch (err) { next(err); }
});

router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    const tenant = await prisma.tenant.update({ where: { id: req.params.id }, data: { status } });
    res.json({ success: true, data: tenant });
  } catch (err) { next(err); }
});

module.exports = router;