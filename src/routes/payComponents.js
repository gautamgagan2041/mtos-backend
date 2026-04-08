const express = require('express');
const prisma = require('../config/database');
const { protect } = require('../middleware/auth');
const { resolveTenant, requireTenant } = require('../middleware/tenant');
const router = express.Router();

router.use(protect, resolveTenant, requireTenant);

router.get('/', async (req, res, next) => {
  try {
    const components = await prisma.payComponent.findMany({
      where: { tenantId: req.tenantId, isActive: true },
      orderBy: [{ type: 'asc' }, { displayOrder: 'asc' }],
    });
    res.json({ success: true, data: components });
  } catch (err) { next(err); }
});

module.exports = router;