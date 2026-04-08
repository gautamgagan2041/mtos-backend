// src/routes/employees.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const prisma = require('../config/database');
const { protect, can } = require('../middleware/auth');
const { resolveTenant, requireTenant, checkEmployeeLimit } = require('../middleware/tenant');
const audit = require('../services/auditService');
const storage = require('../services/storageService');
const router = express.Router();

const upload = multer({
  dest: path.join(__dirname, '../../uploads/temp'),
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE_MB || 10) * 1024 * 1024 },
});

router.use(protect, resolveTenant, requireTenant);

// ── Helper: date fields sanitize karo ─────────────────────────
function sanitizeEmployeeData(data) {
  const clean = { ...data };
  // dob — empty string → null, valid string → Date
  if (clean.dob === '' || clean.dob === null || clean.dob === undefined) {
    clean.dob = null;
  } else if (typeof clean.dob === 'string') {
    const parsed = new Date(clean.dob);
    clean.dob = isNaN(parsed.getTime()) ? null : parsed;
  }
  // Empty strings → null for optional fields
  const optionalFields = ['phone','email','address','aadhaar','pan','uan','pfNumber','esicNumber','bankAccount','ifscCode','bankName','fatherName','photoUrl'];
  for (const f of optionalFields) {
    if (clean[f] === '') clean[f] = null;
  }
  return clean;
}

router.get('/', async (req, res, next) => {
  try {
    const { search, status, tenderId, page = 1, limit = 100 } = req.query;
    const where = { tenantId: req.tenantId };
    if (status) where.status = status;
    if (search) where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { uan: { contains: search } },
    ];
    if (tenderId) {
      where.tenderAssignments = { some: { tenderId, isActive: true } };
    }
    const [employees, total] = await Promise.all([
      prisma.employee.findMany({
        where,
        include: {
          tenderAssignments: {
            where: { isActive: true },
            include: { tender: { select: { name: true, code: true } } },
          },
          _count: { select: { documents: true } },
        },
        orderBy: { sr: 'asc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.employee.count({ where }),
    ]);
    res.json({ success: true, data: employees, total, page: parseInt(page) });
  } catch (err) { next(err); }
});

router.get('/:id/replacements', async (req, res, next) => {
  try {
    const emp = await prisma.employee.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
    const replacements = await prisma.replacement.findMany({
      where: {
        OR: [
          { exitedEmployeeId: req.params.id },
          { replacementEmployeeId: req.params.id },
        ],
      },
      include: {
        exitedEmployee: { select: { id: true, name: true, uan: true } },
        replacementEmployee: { select: { id: true, name: true, uan: true } },
      },
      orderBy: { replacedOn: 'desc' },
    });
    res.json({ success: true, data: replacements });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const employee = await prisma.employee.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      include: {
        tenderAssignments: { include: { tender: { include: { client: true } } } },
        documents: true,
        replacedBy: { include: { replacementEmployee: { select: { name: true, uan: true } } } },
      },
    });
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found' });
    res.json({ success: true, data: employee });
  } catch (err) { next(err); }
});

router.post('/', can('canManageEmployees'), checkEmployeeLimit, async (req, res, next) => {
  try {
    const { tenderId, rank, joiningDate, ...rawData } = req.body;
    const empData = sanitizeEmployeeData(rawData);

    const maxSr = await prisma.employee.aggregate({
      where: { tenantId: req.tenantId },
      _max: { sr: true },
    });

    const employee = await prisma.employee.create({
      data: { ...empData, tenantId: req.tenantId, sr: (maxSr._max.sr || 0) + 1 },
    });

    if (tenderId && rank) {
      await prisma.tenderEmployee.create({
        data: {
          tenderId,
          employeeId: employee.id,
          rank,
          joiningDate: new Date(joiningDate || Date.now()),
        },
      });
    }

    await audit.log({
      tenantId: req.tenantId, userId: req.user.id,
      action: 'CREATE', entityType: 'EMPLOYEE', entityId: employee.id,
      newValues: employee, req,
    });

    res.status(201).json({ success: true, data: employee });
  } catch (err) { next(err); }
});

router.put('/:id', can('canManageEmployees'), async (req, res, next) => {
  try {
    const existing = await prisma.employee.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!existing) return res.status(404).json({ success: false, message: 'Employee not found' });

    const updateData = sanitizeEmployeeData(req.body);

    const employee = await prisma.employee.update({
      where: { id: req.params.id },
      data: updateData,
    });

    await audit.log({
      tenantId: req.tenantId, userId: req.user.id,
      action: 'UPDATE', entityType: 'EMPLOYEE', entityId: employee.id,
      oldValues: existing, newValues: employee, req,
    });

    res.json({ success: true, data: employee });
  } catch (err) { next(err); }
});

router.post('/:id/exit', can('canManageEmployees'), async (req, res, next) => {
  try {
    const emp = await prisma.employee.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    const { tenderId, exitDate, exitReason, exitNote } = req.body;

    await prisma.tenderEmployee.updateMany({
      where: { employeeId: req.params.id, tenderId, isActive: true },
      data: { exitDate: new Date(exitDate), exitReason, exitNote, isActive: false },
    });

    await prisma.employee.update({
      where: { id: req.params.id },
      data: { status: 'EXITED' },
    });

    await prisma.complianceAlert.create({
      data: {
        tenantId: req.tenantId, tenderId,
        entityType: 'EMPLOYEE', entityId: req.params.id,
        alertType: 'VACANCY_CREATED', severity: 'MEDIUM',
        title: 'Vacancy Created',
        message: `${emp.name} exited on ${new Date(exitDate).toDateString()}. Replacement required.`,
      },
    });

    await audit.log({
      tenantId: req.tenantId, userId: req.user.id,
      action: 'EMPLOYEE_EXIT', entityType: 'EMPLOYEE', entityId: req.params.id,
      newValues: { exitDate, exitReason, exitNote, tenderId }, req,
    });

    res.json({ success: true, message: 'Exit recorded successfully' });
  } catch (err) { next(err); }
});

router.post('/:id/replace', can('canManageEmployees'), async (req, res, next) => {
  try {
    const { tenderId, replacementEmployeeId, rank, joiningDate } = req.body;

    await prisma.replacement.create({
      data: {
        tenderId, exitedEmployeeId: req.params.id,
        replacementEmployeeId, replacedOn: new Date(joiningDate),
      },
    });

    await prisma.tenderEmployee.create({
      data: { tenderId, employeeId: replacementEmployeeId, rank, joiningDate: new Date(joiningDate), isActive: true },
    });

    await prisma.employee.update({
      where: { id: req.params.id },
      data: { status: 'REPLACED' },
    });

    await prisma.complianceAlert.updateMany({
      where: { entityId: req.params.id, alertType: 'VACANCY_CREATED', isResolved: false },
      data: { isResolved: true, resolvedAt: new Date() },
    });

    await audit.log({
      tenantId: req.tenantId, userId: req.user.id,
      action: 'EMPLOYEE_REPLACE', entityType: 'EMPLOYEE', entityId: req.params.id,
      newValues: { replacementEmployeeId, tenderId, joiningDate }, req,
    });

    res.json({ success: true, message: 'Replacement assigned successfully' });
  } catch (err) { next(err); }
});

router.post('/:id/documents', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    const emp = await prisma.employee.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    const { key, provider } = await storage.moveFromTemp(
      req.file.path, req.tenant,
      `employees/${req.tenantId}`,
      req.file.originalname, req.file.mimetype,
    );

    const doc = await prisma.employeeDocument.create({
      data: {
        employeeId: req.params.id,
        docType: req.body.docType || 'OTHER',
        fileName: req.file.originalname,
        fileKey: key, fileSize: req.file.size,
        mimeType: req.file.mimetype, storageProvider: provider,
      },
    });

    await audit.log({
      tenantId: req.tenantId, userId: req.user.id,
      action: 'DOCUMENT_UPLOAD', entityType: 'EMPLOYEE_DOCUMENT', entityId: doc.id,
      newValues: { employeeId: req.params.id, docType: doc.docType, fileName: doc.fileName }, req,
    });

    res.status(201).json({ success: true, data: doc });
  } catch (err) { next(err); }
});

module.exports = router;