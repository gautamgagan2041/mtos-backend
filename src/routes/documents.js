// src/routes/documents.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const prisma = require('../config/database');
const { protect } = require('../middleware/auth');
const { resolveTenant, requireTenant } = require('../middleware/tenant');
const storage = require('../services/storageService');
const audit = require('../services/auditService');
const router = express.Router();

const upload = multer({
  dest: path.join(__dirname, '../../uploads/temp'),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.use(protect, resolveTenant, requireTenant);

router.get('/tender/:tenderId', async (req, res, next) => {
  try {
    const tender = await prisma.tender.findFirst({ where: { id: req.params.tenderId, tenantId: req.tenantId } });
    if (!tender) return res.status(404).json({ success: false, message: 'Tender not found' });

    const docs = await prisma.tenderDocument.findMany({
      where: { tenderId: req.params.tenderId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: docs });
  } catch (err) { next(err); }
});

router.post('/tender/:tenderId', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const tender = await prisma.tender.findFirst({ where: { id: req.params.tenderId, tenantId: req.tenantId } });
    if (!tender) return res.status(404).json({ success: false, message: 'Tender not found' });

    const { key, provider } = await storage.moveFromTemp(
      req.file.path, req.tenant,
      `tender-docs/${req.tenantId}/${req.params.tenderId}`,
      req.file.originalname, req.file.mimetype,
    );

    const doc = await prisma.tenderDocument.create({
      data: {
        tenderId: req.params.tenderId,
        category: req.body.category || 'OTHER',
        name: req.body.name || req.file.originalname,
        fileName: req.file.originalname,
        fileKey: key,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        storageProvider: provider,
        uploadedBy: req.user.id,
      },
    });

    await audit.log({
      tenantId: req.tenantId, userId: req.user.id,
      action: 'DOCUMENT_UPLOAD', entityType: 'TENDER_DOCUMENT', entityId: doc.id,
      newValues: { tenderId: req.params.tenderId, name: doc.name, category: doc.category }, req,
    });

    res.status(201).json({ success: true, data: doc });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const doc = await prisma.tenderDocument.findFirst({
      where: { id: req.params.id },
      include: { tender: { select: { tenantId: true } } },
    });
    if (!doc || doc.tender.tenantId !== req.tenantId) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }

    await storage.deleteFile({ tenant: req.tenant, key: doc.fileKey });
    await prisma.tenderDocument.delete({ where: { id: req.params.id } });

    await audit.log({
      tenantId: req.tenantId, userId: req.user.id,
      action: 'DOCUMENT_DELETE', entityType: 'TENDER_DOCUMENT', entityId: doc.id,
      oldValues: { name: doc.name }, req,
    });

    res.json({ success: true, message: 'Document deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
