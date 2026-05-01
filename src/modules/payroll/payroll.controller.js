'use strict';

/**
 * payroll.controller.js — v4
 *
 * NEW endpoints vs v3:
 *   POST   /api/payroll/run          → async (enqueue to BullMQ)
 *   GET    /api/payroll/run/status/:jobId → poll job state
 *   GET    /api/payroll/:runId/ecr   → download PF ECR file
 *   GET    /api/payroll/:runId/esic  → download ESIC return CSV
 *   GET    /api/payroll/:runId/payslip/:employeeId → PDF payslip
 *   GET    /api/payroll/:runId/payslips-bulk → all payslips as ZIP
 */

const payrollService  = require('./payroll.service');
const costSheetService = require('./costSheet.service');
const asyncHandler    = require('../../utils/asyncHandler');
const ApiError        = require('../../utils/apiError');
const { enqueuePayroll, getJobStatus } = require('../../jobs/payroll.job');
const { generateECR, generateESICReturn } = require('./exports/pfECR');
const { generatePayslipPDF, generatePayslipHTML } = require('./exports/payslip');

// ── POST /api/payroll/run ─────────────────────────────────────────

const runPayroll = asyncHandler(async (req, res) => {
  const { tenderId, month, year } = req.body;
  const tenantId    = req.tenantId;
  const runByUserId = req.user.id;

  // Idempotency check (in service layer) before enqueuing
  await payrollService.validateCanRun(tenantId, tenderId, Number(month), Number(year));

  // Enqueue — returns immediately with jobId
  const { jobId, alreadyQueued, state } = await enqueuePayroll({
    tenantId,
    tenderId,
    month:  Number(month),
    year:   Number(year),
    runByUserId,
  });

  if (alreadyQueued) {
    return res.status(202).json({
      success: true,
      message: `Payroll run is already ${state}`,
      jobId,
      alreadyQueued: true,
    });
  }

  res.status(202).json({
    success:  true,
    message:  'Payroll run queued. Poll /api/payroll/run/status/:jobId for progress.',
    jobId,
    statusUrl: `/api/payroll/run/status/${jobId}`,
  });
});

// ── GET /api/payroll/run/status/:jobId ───────────────────────────

const getRunStatus = asyncHandler(async (req, res) => {
  const { jobId } = req.params;
  const status = await getJobStatus(jobId);

  // Map BullMQ states to user-friendly messages
  const MESSAGES = {
    waiting:   'Payroll run is queued and waiting to start...',
    active:    'Payroll run is processing...',
    completed: 'Payroll run completed successfully.',
    failed:    'Payroll run failed. Please check the error and retry.',
    delayed:   'Payroll run will start shortly...',
    not_found: 'Job not found. It may have expired.',
  };

  res.json({
    success: true,
    data: {
      ...status,
      message: MESSAGES[status.state] || status.state,
      // Map progress 0-100 to user-visible steps
      step: _getProgressStep(status.state, status.progress),
    },
  });
});

function _getProgressStep(state, progress) {
  if (state === 'completed') return { current: 4, total: 4, label: 'Done' };
  if (state === 'failed')    return { current: 0, total: 4, label: 'Failed' };
  if (state === 'waiting')   return { current: 0, total: 4, label: 'Queued' };
  if (progress < 20)  return { current: 1, total: 4, label: 'Loading data' };
  if (progress < 70)  return { current: 2, total: 4, label: 'Calculating payroll' };
  if (progress < 95)  return { current: 3, total: 4, label: 'Saving results' };
  return { current: 4, total: 4, label: 'Finalizing' };
}

// ── GET /api/payroll/:runId ───────────────────────────────────────

const getRun = asyncHandler(async (req, res) => {
  const run = await payrollService.getRun(req.params.runId, req.tenantId);
  res.json({ success: true, data: run });
});

// ── GET /api/payroll/:runId/runs (by tender) ──────────────────────

const getRunsByTender = asyncHandler(async (req, res) => {
  const { tenderId } = req.query;
  if (!tenderId) throw new ApiError(400, 'tenderId is required');
  const runs = await payrollService.getRunsByTender(tenderId, req.tenantId);
  res.json({ success: true, data: runs });
});

// ── POST /api/payroll/:runId/lock ─────────────────────────────────

const lockPayroll = asyncHandler(async (req, res) => {
  const run = await payrollService.lockRun(req.params.runId, req.tenantId, req.user.id);
  res.json({ success: true, data: run, message: 'Payroll locked successfully' });
});

// ── DELETE /api/payroll/:runId ────────────────────────────────────

const deleteRun = asyncHandler(async (req, res) => {
  await payrollService.deleteRun(req.params.runId, req.tenantId);
  res.json({ success: true, message: 'Payroll run deleted' });
});

// ── GET /api/payroll/:runId/cost-sheet ────────────────────────────

const getCostSheet = asyncHandler(async (req, res) => {
  const data = await costSheetService.getCostSheet(req.params.runId, req.tenantId);
  res.json({ success: true, data });
});

// ── GET /api/payroll/:runId/pf-challan ───────────────────────────

const getPFChallan = asyncHandler(async (req, res) => {
  const data = await payrollService.getPFChallan(req.params.runId, req.tenantId);
  res.json({ success: true, data });
});

// ── GET /api/payroll/:runId/transfer-sheet ───────────────────────

const getTransferSheet = asyncHandler(async (req, res) => {
  const data = await payrollService.getTransferSheet(req.params.runId, req.tenantId);
  res.json({ success: true, data });
});

// ── GET /api/payroll/:runId/ecr ────────────────────────────────── ← NEW

const downloadECR = asyncHandler(async (req, res) => {
  const { content, filename, summary } = await generateECR(
    req.params.runId,
    req.tenantId
  );

  // Return summary if ?preview=true
  if (req.query.preview === 'true') {
    return res.json({ success: true, data: summary });
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-ECR-Summary',       JSON.stringify(summary));
  res.send(content);
});

// ── GET /api/payroll/:runId/esic-return ────────────────────────── ← NEW

const downloadESICReturn = asyncHandler(async (req, res) => {
  const { content, filename, summary } = await generateESICReturn(
    req.params.runId,
    req.tenantId
  );

  if (req.query.preview === 'true') {
    return res.json({ success: true, data: summary });
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(content);
});

// ── GET /api/payroll/:runId/payslip/:employeeId ────────────────── ← NEW

const downloadPayslip = asyncHandler(async (req, res) => {
  const { runId, employeeId } = req.params;

  if (req.query.format === 'html') {
    // HTML preview (for browser iframe)
    const html = await generatePayslipHTML(runId, employeeId, req.tenantId);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  }

  // Default: PDF
  const pdf = await generatePayslipPDF(runId, employeeId, req.tenantId);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Payslip_${employeeId}_${runId}.pdf"`);
  res.send(pdf);
});

// ── GET /api/payroll/:runId/payslips-bulk ─────────────────────────← NEW

const downloadAllPayslips = asyncHandler(async (req, res) => {
  // Requires: npm install archiver
  let archiver;
  try {
    archiver = require('archiver');
  } catch {
    throw new ApiError(501,
      'Bulk payslip download requires archiver package. Run: npm install archiver'
    );
  }

  const run = await payrollService.getRun(req.params.runId, req.tenantId);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition',
    `attachment; filename="Payslips_${req.params.runId}.zip"`
  );

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);

  // Generate each payslip and add to ZIP
  for (const row of run.rows) {
    try {
      const pdf = await generatePayslipPDF(run.id, row.employeeId, req.tenantId);
      const safeName = row.employee.name.replace(/[^A-Za-z0-9 ]/g, '').trim();
      archive.append(pdf, { name: `Payslip_${safeName}_${row.employee.sr}.pdf` });
    } catch (err) {
      // Skip individual failures — don't abort the whole ZIP
      console.error(`Payslip generation failed for ${row.employeeId}: ${err.message}`);
    }
  }

  await archive.finalize();
});

module.exports = {
  runPayroll,
  getRunStatus,
  getRun,
  getRunsByTender,
  lockPayroll,
  deleteRun,
  getCostSheet,
  getPFChallan,
  getTransferSheet,
  downloadECR,
  downloadESICReturn,
  downloadPayslip,
  downloadAllPayslips,
};
