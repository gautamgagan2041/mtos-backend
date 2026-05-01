'use strict';

/**
 * compliance.routes.js — Complete replacement for src/routes/compliance.js
 *
 * NEW endpoints:
 *   PUT  /documents/:id          — update doc metadata
 *   POST /alerts/:id/resolve     — resolve alert with notes
 *   POST /payroll/:runId/mark-pf-filed   — mark PF challan submitted
 *   POST /payroll/:runId/mark-esic-filed — mark ESIC return submitted
 *   GET  /wage-rates             — get min wage rates by state
 *   POST /wage-rates             — add new wage revision entry
 */

const express      = require('express');
const multer       = require('multer');
const path         = require('path');
const router       = express.Router();
const asyncHandler = require('../../utils/asyncHandler');
const { protect, can } = require('../../middleware/auth');
const { resolveTenant, requireTenant } = require('../../middleware/tenant');
const service      = require('./compliance.service');

// ── Multer: strict file type whitelist ────────────────────────────

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const upload = multer({
  dest: path.join(process.cwd(), 'uploads/temp'),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error(`File type "${file.mimetype}" not allowed for compliance documents`));
    }
    cb(null, true);
  },
});

router.use(protect, resolveTenant, requireTenant);

// ══════════════════════════════════════════════════════════════════
// DOCUMENTS
// ══════════════════════════════════════════════════════════════════

// GET /api/compliance/documents?tenderId=&docType=&expiringSoonDays=30
router.get('/documents', asyncHandler(async (req, res) => {
  const data = await service.getDocuments(req.tenantId, req.query);
  res.json({ success: true, data });
}));

// POST /api/compliance/documents  (multipart: file + JSON fields)
router.post('/documents',
  can('canManageCompliance'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const doc = await service.uploadDocument(
      req.tenantId,
      req.body,
      req.file || null,
      req.user.id,
      req.tenant,
    );
    res.status(201).json({ success: true, data: doc });
  })
);

// PUT /api/compliance/documents/:id
router.put('/documents/:id',
  can('canManageCompliance'),
  asyncHandler(async (req, res) => {
    const doc = await service.updateDocument(req.tenantId, req.params.id, req.body, req.user.id);
    res.json({ success: true, data: doc });
  })
);

// DELETE /api/compliance/documents/:id
router.delete('/documents/:id',
  can('canManageCompliance'),
  asyncHandler(async (req, res) => {
    const result = await service.deleteDocument(req.tenantId, req.params.id, req.user.id, req.tenant);
    res.json({ success: true, ...result });
  })
);

// ══════════════════════════════════════════════════════════════════
// ALERTS
// ══════════════════════════════════════════════════════════════════

// GET /api/compliance/alerts?tenderId=&severity=CRITICAL&isResolved=false
router.get('/alerts', asyncHandler(async (req, res) => {
  const data = await service.getAlerts(req.tenantId, req.query);
  res.json({ success: true, data });
}));

// POST /api/compliance/alerts/:id/resolve
// Body: { notes: "Renewed document uploaded" }
router.post('/alerts/:id/resolve', asyncHandler(async (req, res) => {
  const data = await service.resolveAlert(
    req.tenantId, req.params.id, req.user.id, req.body.notes
  );
  res.json({ success: true, data, message: 'Alert resolved' });
}));

// ══════════════════════════════════════════════════════════════════
// CHALLAN FILING STATUS  ← NEW
// ══════════════════════════════════════════════════════════════════

// POST /api/compliance/payroll/:runId/mark-pf-filed
router.post('/payroll/:runId/mark-pf-filed',
  can('canManageCompliance'),
  asyncHandler(async (req, res) => {
    const data = await service.markChallanFiled(
      req.tenantId, req.params.runId, 'PF', req.user.id
    );
    res.json({ success: true, data, message: 'PF challan marked as filed' });
  })
);

// POST /api/compliance/payroll/:runId/mark-esic-filed
router.post('/payroll/:runId/mark-esic-filed',
  can('canManageCompliance'),
  asyncHandler(async (req, res) => {
    const data = await service.markChallanFiled(
      req.tenantId, req.params.runId, 'ESIC', req.user.id
    );
    res.json({ success: true, data, message: 'ESIC return marked as filed' });
  })
);

// ══════════════════════════════════════════════════════════════════
// WAGE RATES (Minimum Wage Tracking)  ← NEW
// ══════════════════════════════════════════════════════════════════

// GET /api/compliance/wage-rates?state=MAHARASHTRA&category=SKILLED
router.get('/wage-rates', asyncHandler(async (req, res) => {
  const data = await service.getWageRates(req.tenantId, req.query);
  res.json({ success: true, data });
}));

// POST /api/compliance/wage-rates
// Body: { state, category, effectiveFrom, basicWage, daWage, source }
router.post('/wage-rates',
  can('canManageCompliance'),
  asyncHandler(async (req, res) => {
    const { state, category, effectiveFrom, basicWage, daWage } = req.body;
    if (!state || !category || !effectiveFrom || basicWage == null || daWage == null) {
      return res.status(400).json({
        success: false,
        message: 'state, category, effectiveFrom, basicWage, daWage are required',
      });
    }
    const data = await service.addWageRevision(req.tenantId, req.body, req.user.id);
    res.status(201).json({ success: true, data });
  })
);

module.exports = router;
