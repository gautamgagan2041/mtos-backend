'use strict';

/**
 * index.js — MTOS Application Entry Point v4
 *
 * CHANGES vs v3:
 *  1. All modules use new router paths (modules/ instead of routes/)
 *  2. Static file serving REMOVED (security fix)
 *  3. Compliance cron REPLACED with BullMQ scheduled jobs
 *  4. Graceful shutdown with worker cleanup
 *  5. process.send('ready') for PM2 wait_ready
 *  6. Health check endpoint added
 *  7. Subscription webhook endpoint (raw body required)
 */

require('dotenv').config();

const express        = require('express');
const cors           = require('cors');
const helmet         = require('helmet');
const morgan         = require('morgan');
const rateLimit      = require('express-rate-limit');
const cookieParser   = require('cookie-parser');

const logger         = require('./utils/logger');
const ApiError       = require('./utils/apiError');
const prisma         = require('./config/database');

const app = express();

// Ensure upload temp directory exists
const fs = require('fs');
const uploadTemp = require('path').join(__dirname, '../uploads/temp');
fs.mkdirSync(uploadTemp, { recursive: true });

// ── Security Headers ──────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],   // Adjust for your frontend
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:', 'https:'],
    },
  },
}));

app.set('trust proxy', 1); // Required for rate limiting behind nginx/load balancer

// ── CORS ──────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = (process.env.API_CORS_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin "${origin}" not allowed`));
  },
  credentials:      true,
  allowedHeaders:   ['Content-Type', 'Authorization', 'x-tenant-id'],
  exposedHeaders:   ['X-Total-Count'],
  methods:          ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

// ── Rate Limiting ─────────────────────────────────────────────────

const defaultLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max:      parseInt(process.env.RATE_LIMIT_MAX       || '50'),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: 'Too many requests. Please slow down.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      parseInt(process.env.AUTH_RATE_LIMIT_MAX || '10'),
  message:  { success: false, message: 'Too many login attempts. Try again in 15 minutes.' },
});

// ── Webhook Route FIRST (needs raw body) ─────────────────────────
// Must be registered BEFORE express.json() middleware

app.post(
  '/api/subscription/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res, next) => {
    try {
      const { handleWebhook } = require('./modules/subscription/subscription.service');
      const signature = req.headers['x-razorpay-signature'];
      const result    = await handleWebhook(req.body.toString(), signature);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── Body Parsing ──────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// ── Logging ───────────────────────────────────────────────────────

app.use(morgan(
  process.env.NODE_ENV === 'production'
    ? ':remote-addr :method :url :status :res[content-length] - :response-time ms'
    : 'dev',
  { stream: { write: (msg) => logger.http(msg.trim()) } }
));

// ── Health Check ──────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status:    'ok',
      timestamp: new Date().toISOString(),
      version:   process.env.npm_package_version || '4.0.0',
      env:       process.env.NODE_ENV,
    });
  } catch (err) {
    res.status(503).json({ status: 'error', message: 'Database unreachable' });
  }
});

// ── API Routes ────────────────────────────────────────────────────

app.use('/api/auth',        authLimiter,    require('./routes/auth'));

// All business routes use default rate limiter
app.use('/api',             defaultLimiter);

// NEW module-based routes (replace old routes/ equivalents)
app.use('/api/employees',   require('./modules/employee/employee.routes'));
app.use('/api/tenders',     require('./modules/tender/tender.routes'));
app.use('/api/attendance',  require('./modules/attendance/attendance.routes'));
app.use('/api/payroll',     require('./modules/payroll/payroll.routes'));
app.use('/api/billing',     require('./modules/billing/billing.routes'));
app.use('/api/disbursements', require('./modules/disbursement/disbursement.routes'));
app.use('/api/reports',     require('./modules/reports/reports.routes'));
app.use('/api/relievers',   require('./modules/relievers/relievers.routes'));
app.use('/api/subscription', require('./modules/subscription/subscription.routes'));

// Existing routes that haven't been refactored yet (Phase 4)
app.use('/api/dashboard',  require('./routes/dashboard'));
app.use('/api/clients',     require('./modules/client/client.routes'));
app.use('/api/compliance',  require('./routes/compliance'));
app.use('/api/audit',       require('./routes/audit'));

// ── FILE SERVING — Authenticated Only (SECURITY FIX) ─────────────
// Old: app.use('/uploads', express.static(...))  ← REMOVED
// New: Files served through authenticated endpoint

const { protect }            = require('./middleware/auth');
const { resolveTenant, requireTenant } = require('./middleware/tenant');
const storageService         = require('./services/storageService');

app.get('/api/files/:fileKey', protect, resolveTenant, requireTenant, async (req, res, next) => {
  try {
    const fileKey = decodeURIComponent(req.params.fileKey);

    // Verify file belongs to this tenant
    const doc = await prisma.employeeDocument.findFirst({
      where: { fileKey, employee: { tenantId: req.tenantId } },
    });
    const complianceDoc = !doc ? await prisma.complianceDocument.findFirst({
      where: { fileKey, tenantId: req.tenantId },
    }) : null;

    if (!doc && !complianceDoc) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }

    if (process.env.AWS_ACCESS_KEY_ID) {
      // S3: redirect to signed URL (expires in 15 min)
      const url = await storageService.getSignedUrl(fileKey, req.tenant);
      return res.redirect(302, url);
    }

    // Local: serve file
    const filePath = storageService.getLocalPath(fileKey);
    res.sendFile(filePath);
  } catch (err) {
    next(err);
  }
});

// ── 404 Handler ───────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.path}`,
  });
});

// ── Global Error Handler ──────────────────────────────────────────

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  // Prisma unique constraint violation
  if (err.code === 'P2002') {
    const field = err.meta?.target?.[0] || 'field';
    return res.status(409).json({
      success: false,
      message: `A record with this ${field} already exists`,
    });
  }

  // Prisma record not found
  if (err.code === 'P2025') {
    return res.status(404).json({ success: false, message: 'Record not found' });
  }

  // Operational errors (ApiError instances)
  if (err.isOperational) {
    return res.status(err.statusCode || 400).json({
      success: false,
      message: err.message,
      errors:  err.errors || [],
    });
  }

  // Programming errors — don't leak details in production
  logger.error('Unhandled error:', { message: err.message, stack: err.stack, url: req.url });

  res.status(500).json({
    success: false,
    message: process.env.NODE_ENV === 'production'
      ? 'An internal server error occurred. Our team has been notified.'
      : err.message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

// ── Start Server ──────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '5000');

const server = app.listen(PORT, async () => {
  logger.info(`🚀 MTOS API running on port ${PORT} [${process.env.NODE_ENV}]`);

  // Schedule compliance jobs on startup (BullMQ — idempotent)
  try {
    const { scheduleComplianceJobs } = require('./jobs/compliance.job');
    await scheduleComplianceJobs();
    logger.info('✅ Compliance jobs scheduled');
  } catch (err) {
    logger.warn(`⚠️  Compliance jobs scheduling failed (Redis unavailable?): ${err.message}`);
  }

  // Signal PM2 we're ready (for wait_ready: true)
  if (process.send) process.send('ready');
});

// ── Graceful Shutdown ─────────────────────────────────────────────

async function shutdown(signal) {
  try {
    const { payrollWorker } = require('./jobs/payroll.job');
    const { complianceWorker } = require('./jobs/compliance.job');
    if (payrollWorker) await payrollWorker.close();
    if (complianceWorker) await complianceWorker.close();
  } catch (e) { }
  logger.info(`[Server] ${signal} received — graceful shutdown starting...`);

  // Stop accepting new connections
  server.close(async () => {
    logger.info('[Server] HTTP server closed');

    // Close DB connection pool
    await prisma.$disconnect();
    logger.info('[Server] Database disconnected');

    process.exit(0);
  });

  // Force exit after 30s if graceful shutdown hangs
  setTimeout(() => {
    logger.error('[Server] Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 30_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', { message: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', { reason: String(reason) });
  process.exit(1);
});

module.exports = app; // For testing
