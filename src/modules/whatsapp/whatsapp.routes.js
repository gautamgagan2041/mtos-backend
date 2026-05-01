'use strict';

// ═══════════════════════════════════════════════════════════════════
// whatsapp.routes.js
// ═══════════════════════════════════════════════════════════════════

const express      = require('express');
const router       = express.Router();
const asyncHandler = require('../../utils/asyncHandler');
const { handleIncomingMessage } = require('./whatsappBot.service');
const logger = require('../../utils/logger');

// POST /api/whatsapp/webhook — WATI sends all inbound messages here
// No auth required (WATI signs the request — validate token if needed)
router.post('/webhook', asyncHandler(async (req, res) => {
  // Respond 200 immediately so WATI doesn't retry
  res.json({ received: true });

  // Process asynchronously (don't block response)
  setImmediate(async () => {
    try {
      await handleIncomingMessage(req.body);
    } catch (err) {
      logger.error(`[WhatsApp Webhook] Error: ${err.message}`);
    }
  });
}));

module.exports = router;
