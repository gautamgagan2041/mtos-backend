'use strict';

/**
 * attendance.routes.js — Complete replacement for src/routes/attendance.js
 */

const express      = require('express');
const multer       = require('multer');
const path         = require('path');
const fs           = require('fs');
const router       = express.Router();
const asyncHandler = require('../../utils/asyncHandler');
const { protect }  = require('../../middleware/auth');
const { resolveTenant, requireTenant } = require('../../middleware/tenant');
const service      = require('./attendance.service');

// Multer: temp storage for Excel uploads — memory preferred for small files
const upload = multer({
  dest: path.join(process.cwd(), 'uploads/temp'),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only Excel files (.xlsx, .xls) are allowed for attendance upload'));
  },
});

router.use(protect, resolveTenant, requireTenant);

// GET /api/attendance/:tenderId?month=4&year=2026
router.get('/:tenderId', asyncHandler(async (req, res) => {
  const { month, year } = req.query;
  const data = await service.getAttendance(req.tenantId, req.params.tenderId, month, year);
  res.json({ success: true, data });
}));

// POST /api/attendance/save
router.post('/save', asyncHandler(async (req, res) => {
  const data = await service.saveAttendance(req.tenantId, req.body);
  res.json({ success: true, data });
}));

// POST /api/attendance/bulk-save  ← FIXED: now atomic transaction
router.post('/bulk-save', asyncHandler(async (req, res) => {
  const result = await service.bulkSaveAttendance(req.tenantId, req.body);
  res.json({ success: true, ...result, message: `${result.count} records saved` });
}));

// POST /api/attendance/upload-excel  ← FIXED: guaranteed temp file cleanup
router.post('/upload-excel', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }

  const { tenderId, month, year } = req.body;

  try {
    const result = await service.importFromExcel(
      req.tenantId,
      tenderId,
      month,
      year,
      req.file.path
    );

    res.json({
      success: true,
      message: `${result.processed} records imported, ${result.skipped} skipped`,
      data:    result,
    });
  } finally {
    // ALWAYS clean up temp file — even if service throws
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch { /* already gone */ }
    }
  }
}));

module.exports = router;
