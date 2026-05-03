/**
 * MTOS Razorpay Webhook Verification
 *
 * Fixes: HIGH-06 — Webhook signature was not verified, allowing any attacker
 *                  to POST a spoofed subscription.activated event and upgrade
 *                  any tenant to BUSINESS plan for free.
 *
 * Design contract:
 *  - verifyRazorpayWebhook() is Express middleware; it MUST be the first
 *    middleware on the webhook route, before body parsing or business logic.
 *  - Uses crypto.timingSafeEqual() — never a string equality check — to
 *    prevent timing attacks.
 *  - Hard-fails (500) at startup if RAZORPAY_WEBHOOK_SECRET is absent,
 *    so misconfiguration is caught on deploy, not at first webhook call.
 *  - The raw body (Buffer) must be preserved for HMAC computation. If your
 *    global body parser runs before this middleware, pass
 *    { verify: captureRawBody } to express.json() and attach to req.rawBody.
 */

'use strict';

const crypto = require('crypto');

// ─── Secret validation at module load time ────────────────────────────────────

let _webhookSecret = null;

/**
 * Must be called once at startup (after validateSecrets() has already passed).
 * Caches the HMAC key in a Buffer so repeated conversions are avoided.
 */
function initWebhookVerification(secret = process.env.RAZORPAY_WEBHOOK_SECRET) {
  if (!secret || secret.trim() === '') {
    throw new Error(
      'HIGH-06: RAZORPAY_WEBHOOK_SECRET is not set. ' +
      'Webhook verification cannot be performed. ' +
      'Process will not start to prevent free subscription escalation attacks.'
    );
  }
  _webhookSecret = secret;
}

// ─── Raw body capture ─────────────────────────────────────────────────────────

/**
 * Pass this as the `verify` option to express.json() on the webhook route
 * so the raw body Buffer is preserved for HMAC verification.
 *
 * Usage in index.js:
 *   app.post(
 *     '/api/subscription/webhook',
 *     express.json({ verify: captureRawBody }),
 *     verifyRazorpayWebhook,
 *     subscriptionController.handleWebhook
 *   );
 */
function captureRawBody(req, _res, buf) {
  req.rawBody = buf;
}

// ─── Verification middleware ───────────────────────────────────────────────────

/**
 * Express middleware that verifies the Razorpay-Signature header using
 * HMAC-SHA256 with timing-safe comparison.
 *
 * Responds with 400 on signature mismatch (not 401 — we don't want to
 * reveal that signature verification exists to probing attackers).
 * Responds with 500 if the webhook secret was not initialised.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {Function} next
 */
function verifyRazorpayWebhook(req, res, next) {
  if (!_webhookSecret) {
    // Should have been caught at startup — defensive guard
    return res.status(500).json({
      error: 'Webhook verification not configured. Contact system administrator.'
    });
  }

  const signature = req.headers['x-razorpay-signature'];
  if (!signature) {
    return res.status(400).json({ error: 'Missing webhook signature' });
  }

  const rawBody = req.rawBody;
  if (!rawBody || !Buffer.isBuffer(rawBody)) {
    return res.status(400).json({
      error: 'Raw body not available for signature verification. ' +
             'Ensure captureRawBody is used as the express.json verify option.'
    });
  }

  // Compute expected HMAC
  const expectedHmac = crypto
    .createHmac('sha256', _webhookSecret)
    .update(rawBody)
    .digest('hex');

  // Timing-safe comparison — prevents timing oracle attacks
  let isValid;
  try {
    isValid = crypto.timingSafeEqual(
      Buffer.from(signature,    'hex'),
      Buffer.from(expectedHmac, 'hex')
    );
  } catch {
    // timingSafeEqual throws if buffer lengths differ — signature is wrong
    isValid = false;
  }

  if (!isValid) {
    // Log the attempt for security monitoring — do NOT log the raw signature
    const logger = _getLogger();
    logger.warn(
      {
        ip:          req.ip,
        path:        req.path,
        userAgent:   req.get('user-agent'),
        component:   'razorpay-webhook',
      },
      'Webhook signature verification failed — possible spoofing attempt'
    );
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  next();
}

// ─── Subscription event handler contract ─────────────────────────────────────

/**
 * Validates the structure of a Razorpay webhook payload.
 * Returns a normalised event object or throws if the payload is malformed.
 *
 * @param {Object} body  – parsed JSON body
 * @returns {{ event: string, subscriptionId: string, status: string }}
 */
function parseWebhookPayload(body) {
  if (!body || typeof body !== 'object') {
    throw new Error('Webhook payload is missing or not an object');
  }
  if (!body.event || typeof body.event !== 'string') {
    throw new Error('Webhook payload missing "event" field');
  }
  const sub = body?.payload?.subscription?.entity;
  if (!sub || !sub.id) {
    throw new Error('Webhook payload missing subscription entity or id');
  }

  return {
    event:          body.event,
    subscriptionId: sub.id,
    status:         sub.status || null,
    planId:         sub.plan_id || null,
    currentStart:   sub.current_start ? new Date(sub.current_start * 1000) : null,
    currentEnd:     sub.current_end   ? new Date(sub.current_end   * 1000) : null,
    rawPayload:     body,
  };
}

// ─── Logger shim ──────────────────────────────────────────────────────────────

function _getLogger() {
  try { return require('../config/logger'); }
  catch { return console; }
}

// ─── Test helper ──────────────────────────────────────────────────────────────

function _resetForTest() { _webhookSecret = null; }

module.exports = {
  initWebhookVerification,
  captureRawBody,
  verifyRazorpayWebhook,
  parseWebhookPayload,
  _resetForTest,
};
