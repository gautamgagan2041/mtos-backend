// src/routes/compliance.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const prisma = require('../config/database');
const { protect, can } = require('../middleware/auth');
const { resolveTenant, requireTenant } = require('../middleware/tenant');
const audit = require('../services/auditService');
const storage = require('../services/storageService');
const router = express.Router();

const upload = multer({
  dest: path.join(__dirname, '../../uploads/temp'),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.use(protect, resolveTenant, requireTenant);

// GET compliance documents
router.get('/documents', async (req, res, next) => {
  try {
    const { tenderId } = req.query;
    const docs = await prisma.complianceDocument.findMany({
      where: {
        tenantId: req.tenantId,
        isActive: true,
        ...(tenderId && { tenderId }),
      },
      include: { tender: { select: { name: true } } },
      orderBy: { expiryDate: 'asc' },
    });

    const now = new Date();
    const enriched = docs.map(doc => ({
      ...doc,
      daysLeft: doc.expiryDate
        ? Math.ceil((new Date(doc.expiryDate) - now) / (1000 * 60 * 60 * 24))
        : null,
    }));

    res.json({ success: true, data: enriched });
  } catch (err) { next(err); }
});

// POST upload compliance document
router.post('/documents', upload.single('file'), async (req, res, next) => {
  try {
    let fileKey = null, fileName = null, fileSize = null, provider = 'LOCAL';

    if (req.file) {
      const result = await storage.moveFromTemp(
        req.file.path, req.tenant,
        `compliance/${req.tenantId}`,
        req.file.originalname, req.file.mimetype,
      );
      fileKey = result.key;
      provider = result.provider;
      fileName = req.file.originalname;
      fileSize = req.file.size;
    }

    const doc = await prisma.complianceDocument.create({
      data: {
        ...req.body,
        tenantId: req.tenantId,
        uploadedBy: req.user.id,
        issueDate: req.body.issueDate ? new Date(req.body.issueDate) : null,
        expiryDate: req.body.expiryDate ? new Date(req.body.expiryDate) : null,
        tenderId: req.body.tenderId || null,
        fileKey, fileName, fileSize, storageProvider: provider,
      },
    });

    await audit.log({
      tenantId: req.tenantId, userId: req.user.id,
      action: 'DOCUMENT_UPLOAD', entityType: 'COMPLIANCE_DOC', entityId: doc.id,
      newValues: { name: doc.name, docType: doc.docType, expiryDate: doc.expiryDate }, req,
    });

    res.status(201).json({ success: true, data: doc });
  } catch (err) { next(err); }
});

// PUT update document
router.put('/documents/:id', async (req, res, next) => {
  try {
    const existing = await prisma.complianceDocument.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!existing) return res.status(404).json({ success: false, message: 'Document not found' });

    const doc = await prisma.complianceDocument.update({
      where: { id: req.params.id },
      data: {
        ...req.body,
        issueDate: req.body.issueDate ? new Date(req.body.issueDate) : undefined,
        expiryDate: req.body.expiryDate ? new Date(req.body.expiryDate) : undefined,
      },
    });
    res.json({ success: true, data: doc });
  } catch (err) { next(err); }
});

// DELETE document
router.delete('/documents/:id', can('canManageCompliance'), async (req, res, next) => {
  try {
    const doc = await prisma.complianceDocument.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });

    // Delete file from storage
    if (doc.fileKey) {
      await storage.deleteFile({ tenant: req.tenant, key: doc.fileKey });
    }

    await prisma.complianceDocument.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    await audit.log({
      tenantId: req.tenantId, userId: req.user.id,
      action: 'DOCUMENT_DELETE', entityType: 'COMPLIANCE_DOC', entityId: doc.id,
      oldValues: { name: doc.name, docType: doc.docType }, req,
    });

    res.json({ success: true, message: 'Document deleted' });
  } catch (err) { next(err); }
});

// GET alerts
router.get('/alerts', async (req, res, next) => {
  try {
    const { tenderId, severity, resolved } = req.query;
    const alerts = await prisma.complianceAlert.findMany({
      where: {
        tenantId: req.tenantId,
        ...(tenderId && { tenderId }),
        ...(severity && { severity }),
        isResolved: resolved === 'true',
      },
      include: { tender: { select: { name: true } } },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
    });
    res.json({ success: true, data: alerts });
  } catch (err) { next(err); }
});

// POST resolve alert
router.post('/alerts/:id/resolve', async (req, res, next) => {
  try {
    const existing = await prisma.complianceAlert.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!existing) return res.status(404).json({ success: false, message: 'Alert not found' });

    const alert = await prisma.complianceAlert.update({
      where: { id: req.params.id },
      data: { isResolved: true, resolvedAt: new Date(), resolvedBy: req.user.id },
    });

    await audit.log({
      tenantId: req.tenantId, userId: req.user.id,
      action: 'COMPLIANCE_RESOLVE', entityType: 'COMPLIANCE_ALERT', entityId: alert.id,
      newValues: { alertType: alert.alertType, title: alert.title }, req,
    });

    res.json({ success: true, data: alert });
  } catch (err) { next(err); }
});

module.exports = router;
