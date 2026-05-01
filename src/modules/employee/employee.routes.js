'use strict';

/**
 * employee.routes.js — Complete module-based replacement for src/routes/employees.js
 */

const express      = require('express');
const multer       = require('multer');
const path         = require('path');
const router       = express.Router();
const asyncHandler = require('../../utils/asyncHandler');
const { protect, can } = require('../../middleware/auth');
const { resolveTenant, requireTenant, checkEmployeeLimit } = require('../../middleware/tenant');
const { validate, schemas } = require('../../middleware/validate');
const service      = require('./employee.service');

// Multer — memory storage (files go straight to S3 or local via storageService)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ALLOWED = new Set([
      'image/jpeg', 'image/png', 'image/webp',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]);
    if (!ALLOWED.has(file.mimetype)) {
      return cb(new Error(`File type "${file.mimetype}" not allowed`));
    }
    cb(null, true);
  },
});

router.use(protect, resolveTenant, requireTenant);

// ── Collection ────────────────────────────────────────────────────

// GET /api/employees?search=&status=ACTIVE&tenderId=&page=1&limit=50
router.get('/', asyncHandler(async (req, res) => {
  const result = await service.getEmployees(req.tenantId, req.query);
  res.json({ success: true, ...result });
}));

// POST /api/employees
router.post('/',
  can('canManageEmployees'),
  checkEmployeeLimit,
  validate(schemas.createEmployee),
  asyncHandler(async (req, res) => {
    const employee = await service.createEmployee(
      req.tenantId, req.body, req.user.id, req.tenant
    );
    res.status(201).json({ success: true, data: employee });
  })
);

// ── Single Employee ───────────────────────────────────────────────

// GET /api/employees/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const employee = await service.getEmployee(req.tenantId, req.params.id);
  res.json({ success: true, data: employee });
}));

// PUT /api/employees/:id
router.put('/:id',
  can('canManageEmployees'),
  asyncHandler(async (req, res) => {
    const employee = await service.updateEmployee(
      req.tenantId, req.params.id, req.body, req.user.id
    );
    res.json({ success: true, data: employee });
  })
);

// ── Document Upload ───────────────────────────────────────────────

// POST /api/employees/:id/documents
router.post('/:id/documents',
  can('canManageEmployees'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    if (!req.body.docType) {
      return res.status(400).json({ success: false, message: 'docType is required' });
    }
    const doc = await service.uploadDocument(
      req.tenantId, req.params.id, req.file, req.body.docType, req.user.id
    );
    res.status(201).json({ success: true, data: doc });
  })
);

// ── Employee Exit ─────────────────────────────────────────────────

// POST /api/employees/exit/:tenderEmployeeId
router.post('/exit/:tenderEmployeeId',
  can('canManageEmployees'),
  asyncHandler(async (req, res) => {
    const result = await service.exitEmployee(
      req.tenantId, req.params.tenderEmployeeId, req.body, req.user.id
    );
    res.json({ success: true, data: result, message: 'Employee exited successfully' });
  })
);

// ── Replacement History ───────────────────────────────────────────

// GET /api/employees/:id/replacements
router.get('/:id/replacements', asyncHandler(async (req, res) => {
  const repo = require('./employee.repository');
  const data = await repo.findReplacements(req.params.id, req.tenantId);
  if (data === null) {
    return res.status(404).json({ success: false, message: 'Employee not found' });
  }
  res.json({ success: true, data });
}));

// ── Loan Management ───────────────────────────────────────────────

// GET /api/employees/:id/loans
router.get('/:id/loans', asyncHandler(async (req, res) => {
  const prisma = require('../../config/database');
  await service.getEmployee(req.tenantId, req.params.id); // Ownership check
  const loans = await prisma.employeeLoan.findMany({
    where:   { tenantId: req.tenantId, employeeId: req.params.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ success: true, data: loans });
}));

// POST /api/employees/:id/loans
router.post('/:id/loans',
  can('canManageEmployees'),
  asyncHandler(async (req, res) => {
    const prisma = require('../../config/database');
    await service.getEmployee(req.tenantId, req.params.id); // Ownership check

    const { totalAmount, emiAmount, startMonth, startYear, reason } = req.body;
    if (!totalAmount || !emiAmount || !startMonth || !startYear) {
      return res.status(400).json({
        success: false,
        message: 'totalAmount, emiAmount, startMonth, startYear are required',
      });
    }

    const loan = await prisma.employeeLoan.create({
      data: {
        tenantId:       req.tenantId,
        employeeId:     req.params.id,
        totalAmount:    parseFloat(totalAmount),
        remainingAmount: parseFloat(totalAmount),
        emiAmount:      parseFloat(emiAmount),
        startMonth:     parseInt(startMonth),
        startYear:      parseInt(startYear),
        reason:         reason || null,
        approvedBy:     req.user.id,
        isActive:       true,
      },
    });
    res.status(201).json({ success: true, data: loan });
  })
);

module.exports = router;
