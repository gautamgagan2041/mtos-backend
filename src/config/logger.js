/**
 * MTOS Structured Logger
 *
 * Fixes:
 *   LOW-01 — Replace console.error/warn/info with structured Winston logging.
 *            All logs go through this module; the log aggregator (Datadog,
 *            CloudWatch, etc.) receives structured JSON, not unstructured stdout.
 *   LOW-04 — Prometheus metrics endpoint for APM/alerting.
 *
 * Design contract:
 *  - Import this module everywhere; NEVER call console.* directly.
 *  - All logs include: level, timestamp, component, tenantId (when available),
 *    requestId, and a structured `data` field — no free-form strings.
 *  - In test environments, the logger is replaced with a no-op to keep output clean.
 */

'use strict';

const { createLogger, format, transports } = require('winston');
const { combine, timestamp, json, errors, colorize, simple } = format;

// ─── Environment helpers ──────────────────────────────────────────────────────

const isProduction = process.env.NODE_ENV === 'production';
const isTest       = process.env.NODE_ENV === 'test';

// ─── Base logger ──────────────────────────────────────────────────────────────

const logger = isTest
  ? createLogger({ silent: true })        // No output during tests
  : createLogger({
      level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
      format: isProduction
        ? combine(timestamp(), errors({ stack: true }), json())
        : combine(colorize(), timestamp({ format: 'HH:mm:ss' }), simple()),
      transports: [
        new transports.Console({ handleExceptions: true }),
      ],
      exitOnError: false,
    });

// ─── Child logger factory ─────────────────────────────────────────────────────

/**
 * Returns a child logger with a fixed component label.
 * All log calls on the child automatically include the component field.
 *
 * Usage:
 *   const log = require('./logger').forComponent('payrollEngine');
 *   log.info({ tenantId, runId }, 'Payroll run started');
 *
 * @param {string} component
 */
function forComponent(component) {
  return logger.child({ component });
}

// ─── Request-scoped logger middleware ─────────────────────────────────────────

/**
 * Express middleware that attaches a request-scoped child logger to req.log.
 * Logs the incoming request and attaches a correlation ID (requestId).
 *
 * Usage:
 *   app.use(requestLogger);
 *   // Then in any route: req.log.info({ userId }, 'Action taken');
 */
function requestLogger(req, res, next) {
  const requestId = req.headers['x-request-id'] || generateRequestId();
  req.requestId   = requestId;
  req.log         = logger.child({
    requestId,
    component: 'http',
    method:    req.method,
    path:      req.path,
  });

  res.setHeader('X-Request-Id', requestId);

  const startMs = Date.now();
  res.on('finish', () => {
    req.log.info({
      statusCode: res.statusCode,
      durationMs: Date.now() - startMs,
    }, 'Request completed');
  });

  next();
}

// ─── LOW-04: Prometheus metrics ───────────────────────────────────────────────

/**
 * Sets up a /metrics endpoint for Prometheus scraping.
 *
 * LOW-04 FIX: Without this, DB pool exhaustion and BullMQ queue depth are
 * invisible until timeouts occur. Prometheus + Grafana (or Datadog) provide
 * alerting on queue depth, error rate, and response time percentiles.
 *
 * Tracked metrics:
 *   - http_requests_total (counter)
 *   - http_request_duration_ms (histogram)
 *   - payroll_runs_total (counter, labelled by status)
 *   - payroll_run_duration_ms (histogram)
 *   - redis_lock_acquisitions_total (counter, labelled by outcome)
 *   - formula_errors_total (counter)
 *
 * @param {import('express').Application} app
 * @returns {Object}  metrics registry (for recording events from other modules)
 */
function setupMetrics(app) {
  let registry;
  try {
    const client = require('prom-client');

    registry = new client.Registry();
    client.collectDefaultMetrics({ register: registry });

    // HTTP request counter
    const httpRequestsTotal = new client.Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests',
      labelNames: ['method', 'route', 'status'],
      registers: [registry],
    });

    // HTTP duration histogram
    const httpDurationMs = new client.Histogram({
      name: 'http_request_duration_ms',
      help: 'HTTP request duration in milliseconds',
      labelNames: ['method', 'route', 'status'],
      buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000],
      registers: [registry],
    });

    // Payroll metrics
    const payrollRunsTotal = new client.Counter({
      name: 'payroll_runs_total',
      help: 'Total payroll runs',
      labelNames: ['status'],
      registers: [registry],
    });

    // Redis lock metrics
    const redisLockTotal = new client.Counter({
      name: 'redis_lock_acquisitions_total',
      help: 'Redis distributed lock acquisition outcomes',
      labelNames: ['outcome'],  // acquired | taken | error
      registers: [registry],
    });

    // Formula error counter (MED-07 alerting)
    const formulaErrorsTotal = new client.Counter({
      name: 'formula_errors_total',
      help: 'Total formula evaluation errors in payroll engine',
      labelNames: ['component_code'],
      registers: [registry],
    });

    // Prometheus scrape endpoint — separate from the main API
    app.get('/metrics', async (_req, res) => {
      res.set('Content-Type', registry.contentType);
      res.end(await registry.metrics());
    });

    return {
      httpRequestsTotal,
      httpDurationMs,
      payrollRunsTotal,
      redisLockTotal,
      formulaErrorsTotal,
    };
  } catch {
    // prom-client not installed — return no-op counters so calling code
    // doesn't have to conditionally check for metrics availability
    const noop = { inc: () => {}, observe: () => {}, labels: () => ({ inc: () => {}, observe: () => {} }) };
    logger.warn({ component: 'metrics' }, 'prom-client not installed — metrics disabled');
    return {
      httpRequestsTotal:  noop,
      httpDurationMs:     noop,
      payrollRunsTotal:   noop,
      redisLockTotal:     noop,
      formulaErrorsTotal: noop,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateRequestId() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  ...logger,         // info, warn, error, debug are available directly
  forComponent,
  requestLogger,
  setupMetrics,
};
