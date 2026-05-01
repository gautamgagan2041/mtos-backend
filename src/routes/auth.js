// src/routes/auth.js — Auth v2
'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const prisma  = require('../config/database');
const { protect }           = require('../middleware/auth');
const audit                 = require('../services/auditService');
const { validate, schemas } = require('../middleware/validate');

const router = express.Router();

// ── Constants ─────────────────────────────────────────────────────
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS    = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_D = 30;
const JWT_OPTIONS = { issuer: 'mtos', audience: 'mtos-users' };

// ── Helpers ───────────────────────────────────────────────────────

function signAccessToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, tenantId: user.tenantId },
    process.env.JWT_SECRET,
    { ...JWT_OPTIONS, expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
}

function generateRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function refreshExpiresAt() {
  const d = new Date();
  d.setDate(d.getDate() + REFRESH_TOKEN_TTL_D);
  return d;
}

function setRefreshCookie(res, token) {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   REFRESH_TOKEN_TTL_D * 24 * 60 * 60 * 1000,
    path:     '/api/auth',
  });
}

function clearRefreshCookie(res) {
  res.clearCookie('refreshToken', { path: '/api/auth' });
}

function getClientInfo(req) {
  return {
    ip:        req.ip,
    userAgent: req.headers['user-agent'] || null,
  };
}

// ── POST /api/auth/login ──────────────────────────────────────────

router.post('/login', validate(schemas.login), async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const { ip, userAgent }   = getClientInfo(req);

    const user = await prisma.user.findUnique({
      where:   { email: email.toLowerCase().trim() },
      include: { tenant: { select: { id: true, name: true, slug: true, status: true, plan: true } } },
    });

    if (!user || !user.isActive)
      return res.status(401).json({ success: false, message: 'Invalid credentials' });

    if (user.tenant?.status === 'SUSPENDED')
      return res.status(403).json({ success: false, message: 'Account suspended. Contact support.' });
    if (user.tenant?.status === 'CANCELLED')
      return res.status(403).json({ success: false, message: 'Subscription cancelled.' });

    // Account lockout check
    if (user.lockUntil && user.lockUntil > new Date()) {
      const minutesLeft = Math.ceil((user.lockUntil - new Date()) / 60000);
      return res.status(423).json({
        success: false,
        message: `Account locked. Try again in ${minutesLeft} minute(s).`,
      });
    }

    // Password check
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      const newAttempts = (user.failedAttempts || 0) + 1;
      const shouldLock  = newAttempts >= MAX_FAILED_ATTEMPTS;

      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedAttempts: newAttempts,
          lockUntil: shouldLock ? new Date(Date.now() + LOCK_DURATION_MS) : null,
        },
      });

      await audit.log({
        tenantId: user.tenantId, userId: user.id,
        action: 'LOGIN', entityType: 'USER', entityId: user.id,
        metadata: { success: false, reason: 'wrong_password', attempt: newAttempts },
        req,
      });

      if (shouldLock) {
        return res.status(423).json({
          success: false,
          message: `Too many failed attempts. Account locked for 15 minutes.`,
        });
      }

      return res.status(401).json({
        success: false,
        message: `Invalid credentials. ${MAX_FAILED_ATTEMPTS - newAttempts} attempt(s) remaining.`,
      });
    }

    // Success — reset lockout, issue tokens
    const rawRefresh = generateRefreshToken();

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          failedAttempts: 0,
          lockUntil:      null,
          lastLogin:      new Date(),
          lastIp:         ip,
          lastUserAgent:  userAgent,
        },
      }),
      prisma.refreshToken.create({
        data: {
          id:        crypto.randomUUID(),
          userId:    user.id,
          tokenHash: hashToken(rawRefresh),
          expiresAt: refreshExpiresAt(),
          userAgent,
          ipAddress: ip,
        },
      }),
    ]);

    await audit.log({
      tenantId: user.tenantId, userId: user.id,
      action: 'LOGIN', entityType: 'USER', entityId: user.id,
      metadata: { success: true, ip, userAgent },
      req,
    });

    setRefreshCookie(res, rawRefresh);

    res.json({
      success:   true,
      token:     signAccessToken(user),
      expiresIn: process.env.JWT_EXPIRES_IN || '15m',
      user: {
        id: user.id, name: user.name, email: user.email,
        role: user.role, tenantId: user.tenantId,
        tenant: user.tenant || null,
      },
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/refresh ────────────────────────────────────────

router.post('/refresh', async (req, res, next) => {
  try {
    const raw = req.cookies?.refreshToken || req.body?.refreshToken;

    if (!raw || typeof raw !== 'string' || raw.length < 10) {
      return res.status(401).json({ success: false, message: 'No refresh token provided' });
    }

    const stored = await prisma.refreshToken.findUnique({
      where:   { tokenHash: hashToken(raw) },
      include: {
        user: {
          include: { tenant: { select: { id: true, name: true, slug: true, status: true, plan: true } } },
        },
      },
    });

    if (!stored) {
      clearRefreshCookie(res);
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
    }

    if (stored.expiresAt < new Date()) {
      await prisma.refreshToken.delete({ where: { id: stored.id } });
      clearRefreshCookie(res);
      return res.status(401).json({ success: false, message: 'Refresh token expired — please log in again' });
    }

    const user = stored.user;
    if (!user.isActive || user.tenant?.status === 'SUSPENDED' || user.tenant?.status === 'CANCELLED') {
      await prisma.refreshToken.delete({ where: { id: stored.id } });
      clearRefreshCookie(res);
      return res.status(403).json({ success: false, message: 'Account is no longer active' });
    }

    // Rotate tokens
    const newRaw = generateRefreshToken();
    const { ip, userAgent } = getClientInfo(req);

    await prisma.$transaction([
      prisma.refreshToken.delete({ where: { id: stored.id } }),
      prisma.refreshToken.create({
        data: {
          id:        crypto.randomUUID(),
          userId:    user.id,
          tokenHash: hashToken(newRaw),
          expiresAt: refreshExpiresAt(),
          userAgent,
          ipAddress: ip,
        },
      }),
    ]);

    setRefreshCookie(res, newRaw);

    res.json({
      success:   true,
      token:     signAccessToken(user),
      expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/logout ─────────────────────────────────────────

router.post('/logout', protect, async (req, res, next) => {
  try {
    const raw = req.cookies?.refreshToken || req.body?.refreshToken;
    if (raw) {
      await prisma.refreshToken.deleteMany({
        where: { userId: req.user.id, tokenHash: hashToken(raw) },
      });
    }
    clearRefreshCookie(res);
    await audit.log({
      tenantId: req.user.tenantId, userId: req.user.id,
      action: 'LOGOUT', entityType: 'USER', entityId: req.user.id, req,
    });
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) { next(err); }
});

// ── POST /api/auth/logout-all ─────────────────────────────────────

router.post('/logout-all', protect, async (req, res, next) => {
  try {
    const count = await prisma.refreshToken.deleteMany({ where: { userId: req.user.id } });
    clearRefreshCookie(res);
    await audit.log({
      tenantId: req.user.tenantId, userId: req.user.id,
      action: 'LOGOUT', entityType: 'USER', entityId: req.user.id,
      metadata: { sessionsRevoked: count.count }, req,
    });
    res.json({ success: true, message: `Logged out from ${count.count} device(s)` });
  } catch (err) { next(err); }
});

// ── GET /api/auth/sessions ────────────────────────────────────────

router.get('/sessions', protect, async (req, res, next) => {
  try {
    const sessions = await prisma.refreshToken.findMany({
      where:   { userId: req.user.id, expiresAt: { gt: new Date() } },
      select:  { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: sessions });
  } catch (err) { next(err); }
});

// ── DELETE /api/auth/sessions/:id ────────────────────────────────

router.delete('/sessions/:id', protect, async (req, res, next) => {
  try {
    const session = await prisma.refreshToken.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
    await prisma.refreshToken.delete({ where: { id: session.id } });
    res.json({ success: true, message: 'Session revoked' });
  } catch (err) { next(err); }
});

// ── GET /api/auth/me ──────────────────────────────────────────────

router.get('/me', protect, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: {
        id: true, name: true, email: true, role: true,
        phone: true, lastLogin: true, lastIp: true, lastUserAgent: true,
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

// ── POST /api/auth/change-password ───────────────────────────────

router.post('/change-password', protect, validate(schemas.changePassword), async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user  = await prisma.user.findUnique({ where: { id: req.user.id } });
    const match = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!match) return res.status(400).json({ success: false, message: 'Current password incorrect' });

    const hash = await bcrypt.hash(newPassword, 12);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: hash, failedAttempts: 0, lockUntil: null },
      }),
      prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
    ]);

    clearRefreshCookie(res);

    await audit.log({
      tenantId: user.tenantId, userId: user.id,
      action: 'PASSWORD_CHANGE', entityType: 'USER', entityId: user.id, req,
    });

    res.json({ success: true, message: 'Password changed. Please log in again on all devices.' });
  } catch (err) { next(err); }
});

module.exports = router;