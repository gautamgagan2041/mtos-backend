// src/modules/disbursement/disbursement.controller.js
'use strict';

const service      = require('./disbursement.service');
const asyncHandler = require('../../utils/asyncHandler');

// POST /disbursements/initialize
const initializeDisbursements = asyncHandler(async (req, res) => {
  const { runId } = req.body;
  if (!runId) {
    return res.status(400).json({ success: false, message: 'runId is required' });
  }

  const result = await service.initializeDisbursements(runId, req.tenantId);

  return res.status(201).json({
    success: true,
    message: `Disbursements initialized: ${result.created} created, ${result.skipped} skipped`,
    data:    result,
  });
});

// GET /disbursements?runId=xxx
const getDisbursements = asyncHandler(async (req, res) => {
  const { runId } = req.query;
  if (!runId) {
    return res.status(400).json({ success: false, message: 'runId query param required' });
  }

  const data = await service.getDisbursements(runId, req.tenantId);

  return res.status(200).json({ success: true, data });
});

// PATCH /disbursements/:id/transferred
const markTransferred = asyncHandler(async (req, res) => {
  const { utrNo } = req.body;

  const result = await service.markTransferred(
    req.params.id,
    req.tenantId,
    utrNo,
    req.user.id
  );

  return res.status(200).json({ success: true, ...result });
});

// PATCH /disbursements/:id/failed
const markFailed = asyncHandler(async (req, res) => {
  const { failureReason } = req.body;

  const result = await service.markFailed(
    req.params.id,
    req.tenantId,
    failureReason
  );

  return res.status(200).json({ success: true, ...result });
});

// POST /disbursements/bulk-transfer
const bulkMarkTransferred = asyncHandler(async (req, res) => {
  const { runId } = req.body;
  if (!runId) {
    return res.status(400).json({ success: false, message: 'runId is required' });
  }

  const result = await service.bulkMarkTransferred(runId, req.tenantId, req.user.id);

  return res.status(200).json({ success: true, ...result });
});

module.exports = {
  initializeDisbursements,
  getDisbursements,
  markTransferred,
  markFailed,
  bulkMarkTransferred,
};
