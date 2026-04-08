// src/index.js — MTOS Backend Entry Point (v2 — Multi-Tenant SaaS)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');
const { defaultLimiter, authLimiter } = require('./middleware/rateLimit');
const { setupCronJobs } = require('./services/cronService');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.set('trust proxy', 1);
app.use(defaultLimiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev', { stream: { write: (msg) => logger.http(msg.trim()) } }));
}

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    environment: process.env.NODE_ENV,
  });
});

// ── API Routes ────────────────────────────────────────────────
app.use('/api/auth',           authLimiter, require('./routes/auth'));
app.use('/api/users',          require('./routes/users'));
app.use('/api/clients',        require('./routes/clients'));
app.use('/api/tenders',        require('./routes/tenders'));
app.use('/api/employees',      require('./routes/employees'));
app.use('/api/attendance',     require('./routes/attendance'));
app.use('/api/payroll',        require('./modules/payroll/payroll.routes'));
app.use('/api/compliance',     require('./routes/compliance'));
app.use('/api/documents',      require('./routes/documents'));
app.use('/api/dashboard',      require('./routes/dashboard'));
app.use('/api/reports',        require('./routes/reports'));
app.use('/api/audit',          require('./routes/audit'));
app.use('/api/tenants',        require('./routes/tenants'));
app.use('/api/pay-components', require('./routes/payComponents')); // ← NEW
app.use('/api/billing', require('./modules/billing/billing.routes'));
app.use('/api/disbursements', require('./modules/disbursement/disbursement.routes'));
app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

app.use(errorHandler);

if (require.main === module) {
  app.listen(PORT, () => {
    logger.info(`🚀 MTOS v2 Backend running on http://localhost:${PORT}`);
    logger.info(`📊 Environment: ${process.env.NODE_ENV}`);
    logger.info(`🏢 Mode: Multi-Tenant SaaS`);
    if (process.env.NODE_ENV === 'production') {
      setupCronJobs();
      logger.info('⏰ Cron jobs started');
    }
  });
}

module.exports = app;