// src/routes/attendance.js
'use strict';

const express = require('express');
const multer  = require('multer');
const XLSX    = require('xlsx');
const path    = require('path');
const fs      = require('fs');
const prisma  = require('../config/database');
const { protect }                    = require('../middleware/auth');
const { resolveTenant, requireTenant } = require('../middleware/tenant');

const router = express.Router();
const upload = multer({ dest: path.join(__dirname, '../../uploads/temp') });

router.use(protect, resolveTenant, requireTenant);

// ── Helper: convert month name or number to Int ───────────────────
const MONTH_NAMES = [
  'january','february','march','april','may','june',
  'july','august','september','october','november','december'
];

function parseMonth(month) {
  if (!month) return null;
  const n = parseInt(month);
  if (!isNaN(n) && n >= 1 && n <= 12) return n;
  const idx = MONTH_NAMES.indexOf(String(month).toLowerCase());
  return idx >= 0 ? idx + 1 : null;
}

// ── GET /:tenderId — fetch employees with attendance ──────────────
router.get('/:tenderId', async (req, res, next) => {
  try {
    const { month, year } = req.query;

    const tender = await prisma.tender.findFirst({
      where: { id: req.params.tenderId, tenantId: req.tenantId },
    });
    if (!tender) {
      return res.status(404).json({ success: false, message: 'Tender not found' });
    }

    // Fetch employees without attendance relation
    const tenderEmployees = await prisma.tenderEmployee.findMany({
      where:   { tenderId: req.params.tenderId, isActive: true },
      include: { employee: true },
      orderBy: { employee: { sr: 'asc' } },
    });

    // Fetch attendance separately
    let attendanceMap = {};
    const monthInt = parseMonth(month);

    if (monthInt && year) {
      const teIds = tenderEmployees.map(te => te.id);
      const records = await prisma.attendance.findMany({
        where: {
          tenderEmployeeId: { in: teIds },
          month: monthInt,
          year:  parseInt(year),
        },
      });
      records.forEach(a => { attendanceMap[a.tenderEmployeeId] = a; });
    }

    // Merge
    const result = tenderEmployees.map(te => ({
      ...te,
      attendance: attendanceMap[te.id] ? [attendanceMap[te.id]] : [],
    }));

    return res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

// ── POST /save — save single attendance record ────────────────────
router.post('/save', async (req, res, next) => {
  try {
    const {
      tenderEmployeeId, month, year,
      presentDays, extraDutyDays, splitDays, splitRank,
      otHours, nightShifts, dailyData,
    } = req.body;

    if (!tenderEmployeeId || !month || !year) {
      return res.status(400).json({
        success: false,
        message: 'tenderEmployeeId, month, year are required',
      });
    }

    // Get tenantId from tenderEmployee
    const te = await prisma.tenderEmployee.findUnique({
      where:   { id: tenderEmployeeId },
      include: { tender: true },
    });
    if (!te) {
      return res.status(404).json({ success: false, message: 'TenderEmployee not found' });
    }

    const monthInt = parseMonth(month);
    if (!monthInt) {
      return res.status(400).json({ success: false, message: `Invalid month: "${month}"` });
    }

    const attendance = await prisma.attendance.upsert({
      where: {
        tenderEmployeeId_month_year: {
          tenderEmployeeId,
          month: monthInt,
          year:  parseInt(year),
        },
      },
      update: {
        presentDays:   parseInt(presentDays)   || 0,
        extraDutyDays: parseInt(extraDutyDays) || 0,
        splitDays:     parseInt(splitDays)     || 0,
        splitRank:     splitRank               || null,
        otHours:       parseFloat(otHours)     || 0,
        nightShifts:   parseFloat(nightShifts) || 0,
        dailyData:     dailyData               || null,
      },
      create: {
        tenantId:        te.tender.tenantId,
        tenderEmployeeId,
        month:           monthInt,
        year:            parseInt(year),
        presentDays:     parseInt(presentDays)   || 0,
        extraDutyDays:   parseInt(extraDutyDays) || 0,
        splitDays:       parseInt(splitDays)     || 0,
        splitRank:       splitRank               || null,
        otHours:         parseFloat(otHours)     || 0,
        nightShifts:     parseFloat(nightShifts) || 0,
        dailyData:       dailyData               || null,
      },
    });

    return res.json({ success: true, data: attendance });
  } catch (err) { next(err); }
});

// ── POST /bulk-save — save multiple records at once ───────────────
router.post('/bulk-save', async (req, res, next) => {
  try {
    const { tenderId, month, year, attendanceData } = req.body;

    if (!tenderId || !month || !year || !attendanceData?.length) {
      return res.status(400).json({
        success: false,
        message: 'tenderId, month, year, attendanceData are required',
      });
    }

    const monthInt = parseMonth(month);
    if (!monthInt) {
      return res.status(400).json({ success: false, message: `Invalid month: "${month}"` });
    }

    // Get tenantId from tender
    const tender = await prisma.tender.findFirst({
      where: { id: tenderId, tenantId: req.tenantId },
    });
    if (!tender) {
      return res.status(404).json({ success: false, message: 'Tender not found' });
    }

    const results = [];
    for (const att of attendanceData) {
      const saved = await prisma.attendance.upsert({
        where: {
          tenderEmployeeId_month_year: {
            tenderEmployeeId: att.tenderEmployeeId,
            month:            monthInt,
            year:             parseInt(year),
          },
        },
        update: {
          presentDays:   parseInt(att.presentDays)   || 0,
          extraDutyDays: parseInt(att.extraDutyDays) || 0,
          splitDays:     parseInt(att.splitDays)     || 0,
          splitRank:     att.splitRank               || null,
          otHours:       parseFloat(att.otHours)     || 0,
          nightShifts:   parseFloat(att.nightShifts) || 0,
          dailyData:     att.dailyData               || null,
        },
        create: {
          tenantId:        tender.tenantId,
          tenderEmployeeId: att.tenderEmployeeId,
          month:            monthInt,
          year:             parseInt(year),
          presentDays:     parseInt(att.presentDays)   || 0,
          extraDutyDays:   parseInt(att.extraDutyDays) || 0,
          splitDays:       parseInt(att.splitDays)     || 0,
          splitRank:       att.splitRank               || null,
          otHours:         parseFloat(att.otHours)     || 0,
          nightShifts:     parseFloat(att.nightShifts) || 0,
          dailyData:       att.dailyData               || null,
        },
      });
      results.push(saved);
    }

    return res.json({ success: true, data: results, count: results.length });
  } catch (err) { next(err); }
});

// ── POST /upload-excel — import attendance from Excel ─────────────
router.post('/upload-excel', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const { tenderId, month, year } = req.body;

    const monthInt = parseMonth(month);
    if (!monthInt) {
      return res.status(400).json({ success: false, message: `Invalid month: "${month}"` });
    }

    const tender = await prisma.tender.findFirst({
      where: { id: tenderId, tenantId: req.tenantId },
    });
    if (!tender) {
      return res.status(404).json({ success: false, message: 'Tender not found' });
    }

    const workbook = XLSX.readFile(req.file.path);
    const sheet    = workbook.Sheets[workbook.SheetNames[0]];
    const rows     = XLSX.utils.sheet_to_json(sheet);

    const tenderEmployees = await prisma.tenderEmployee.findMany({
      where:   { tenderId, isActive: true },
      include: { employee: true },
    });

    const empMap = {};
    tenderEmployees.forEach(te => {
      empMap[te.employee.name.toUpperCase()] = te.id;
      if (te.employee.uan) empMap[te.employee.uan] = te.id;
    });

    const daysInMonth = new Date(parseInt(year), monthInt, 0).getDate();
    const results     = [];

    for (const row of rows) {
      const empName        = (row['Name'] || row['EMPLOYEE NAME'] || '').toUpperCase();
      const uan            = String(row['UAN'] || '');
      const tenderEmployeeId = empMap[empName] || empMap[uan];
      if (!tenderEmployeeId) continue;

      let presentDays = 0;
      const dailyData = {};
      for (let d = 1; d <= daysInMonth; d++) {
        const val = String(row[`D${d}`] || row[String(d)] || '').trim().toUpperCase();
        dailyData[d] = val;
        if (val === 'P') presentDays++;
      }
      const extraDutyDays = parseInt(row['Extra Duty'] || row['ED'] || 0);

      await prisma.attendance.upsert({
        where: {
          tenderEmployeeId_month_year: {
            tenderEmployeeId,
            month: monthInt,
            year:  parseInt(year),
          },
        },
        update: { presentDays, extraDutyDays, dailyData },
        create: {
          tenantId: tender.tenantId,
          tenderEmployeeId,
          month:    monthInt,
          year:     parseInt(year),
          presentDays,
          extraDutyDays,
          dailyData,
        },
      });
      results.push({ tenderEmployeeId, presentDays, extraDutyDays });
    }

    try { fs.unlinkSync(req.file.path); } catch {}
    return res.json({
      success: true,
      message: `${results.length} records imported`,
      data:    results,
    });

  } catch (err) {
    try { if (req.file) fs.unlinkSync(req.file.path); } catch {}
    next(err);
  }
});

module.exports = router;