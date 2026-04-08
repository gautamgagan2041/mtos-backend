// src/routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../config/database');
const { protect } = require('../middleware/auth');
const audit = require('../services/auditService');
const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ success: false, message: 'Email and password required' });

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      include: { tenant: { select: { id: true, name: true, slug: true, status: true, plan: true } } },
    });

    if (!user || !user.isActive)
      return res.status(401).json({ success: false, message: 'Invalid credentials' });

    // Check tenant status before allowing login
    if (user.tenant) {
      if (user.tenant.status === 'SUSPENDED') {
        return res.status(403).json({ success: false, message: 'Account suspended. Contact support.' });
      }
      if (user.tenant.status === 'CANCELLED') {
        return res.status(403).json({ success: false, message: 'Subscription cancelled.' });
      }
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      // Audit failed login attempt
      await audit.log({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'LOGIN',
        entityType: 'USER',
        entityId: user.id,
        metadata: { success: false, reason: 'wrong_password' },
        req,
      });
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date(), lastIp: req.ip },
    });

    const token = jwt.sign(
      { id: user.id, role: user.role, tenantId: user.tenantId },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // Audit successful login
    await audit.log({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'LOGIN',
      entityType: 'USER',
      entityId: user.id,
      metadata: { success: true },
      req,
    });

    res.json({
      success: true,
      token,
      user: {
        id: user.id, name: user.name, email: user.email,
        role: user.role, tenantId: user.tenantId,
        tenant: user.tenant || null,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/auth/me
router.get('/me', protect, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, name: true, email: true, role: true,
        phone: true, lastLogin: true,
        tenant: {
          select: {
            id: true, name: true, slug: true, plan: true,
            status: true, maxEmployees: true, storageProvider: true,
          },
        },
      },
    });
    res.json({ success: true, user });
  } catch (err) { next(err); }
});

// POST /api/auth/change-password
router.post('/change-password', protect, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const match = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!match) return res.status(400).json({ success: false, message: 'Current password incorrect' });

    const hash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hash } });

    await audit.log({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'PASSWORD_CHANGE',
      entityType: 'USER',
      entityId: user.id,
      req,
    });

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) { next(err); }
});

module.exports = router;
