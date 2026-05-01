'use strict';

/**
 * whatsappBot.service.js — Employee Self-Service via WhatsApp
 *
 * Manpower workers don't use computers. WhatsApp is their interface.
 * This bot handles inbound WhatsApp messages and responds with:
 *   - Payslip (PDF attachment)
 *   - PF balance (EPFO passbook API when available)
 *   - Attendance summary
 *   - Salary credit confirmation
 *
 * INTEGRATION: WATI (WhatsApp Business API)
 *   Webhook: POST /api/whatsapp/webhook
 *   Header:  wati-token verification
 *
 * SETUP:
 *   1. Create WATI account at app.wati.io
 *   2. Connect WhatsApp Business number
 *   3. Set webhook URL: https://app.mtos.in/api/whatsapp/webhook
 *   4. Set ENV: WHATSAPP_API_URL, WHATSAPP_API_KEY
 *
 * FLOW:
 *   Worker sends "payslip" → bot replies with PDF of last month's payslip
 *   Worker sends "salary"  → bot replies with net pay for last month
 *   Worker sends "pf"      → bot replies with EPF account info
 *   Worker sends "help"    → bot replies with command list
 */

const prisma  = require('../../config/database');
const { generatePayslipPDF } = require('../payroll/exports/payslip');
const { decryptPII }         = require('../../utils/encryption');
const logger = require('../../utils/logger');

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

// ── Webhook Handler ───────────────────────────────────────────────

/**
 * handleIncomingMessage — process WATI webhook payload
 * Called from: POST /api/whatsapp/webhook
 */
async function handleIncomingMessage(payload) {
  // WATI webhook format
  const message   = payload.messages?.[0];
  const waId      = message?.from;   // WhatsApp phone number (E.164)
  const text      = (message?.text?.body || '').trim().toLowerCase();
  const messageId = message?.id;

  if (!waId || !text) return { handled: false };

  logger.info(`[WhatsApp] Inbound from ${waId}: "${text}"`);

  // Find employee by phone number
  const employee = await _findEmployeeByPhone(waId);

  if (!employee) {
    await _sendText(waId,
      `Hello! I don't recognize your WhatsApp number (${waId}).\n\n` +
      `Please ask your HR department to update your phone number in MTOS.`
    );
    return { handled: true, action: 'employee_not_found' };
  }

  // Route command
  const command = _parseCommand(text);
  logger.info(`[WhatsApp] ${employee.name} (${waId}): command="${command}"`);

  switch (command) {
    case 'payslip': return handlePayslipRequest(employee, waId);
    case 'salary':  return handleSalaryRequest(employee, waId);
    case 'pf':      return handlePFRequest(employee, waId);
    case 'attend':  return handleAttendanceRequest(employee, waId);
    case 'help':
    default:        return handleHelp(employee, waId);
  }
}

// ── Command Handlers ──────────────────────────────────────────────

async function handlePayslipRequest(employee, waId) {
  const lastRun = await _getLastPayrollRow(employee.id);

  if (!lastRun) {
    await _sendText(waId, `Hi ${employee.name}! No payslip found yet. Please try next month.`);
    return { handled: true, action: 'no_payslip' };
  }

  await _sendText(waId,
    `Hi ${employee.name}! Generating your payslip for ${MONTHS[lastRun.run.month]} ${lastRun.run.year}...`
  );

  try {
    const pdf = await generatePayslipPDF(lastRun.run.id, employee.id, employee.tenantId);
    await _sendDocument(waId, pdf, `Payslip_${MONTHS[lastRun.run.month]}_${lastRun.run.year}.pdf`);
  } catch (err) {
    logger.error(`[WhatsApp] Payslip PDF failed for ${employee.id}: ${err.message}`);
    await _sendText(waId,
      `Sorry, payslip download failed. Please contact HR or visit the MTOS app.`
    );
  }

  return { handled: true, action: 'payslip_sent' };
}

async function handleSalaryRequest(employee, waId) {
  const lastRun = await _getLastPayrollRow(employee.id);

  if (!lastRun) {
    await _sendText(waId, `Hi ${employee.name}! No salary information found yet.`);
    return { handled: true, action: 'no_salary' };
  }

  const fmt = n => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(n);
  const row = lastRun;

  const msg = [
    `*Salary Summary — ${MONTHS[row.run.month]} ${row.run.year}*`,
    ``,
    `👤 *${employee.name}*`,
    `📅 Days Worked: ${row.workDays}`,
    ``,
    `💰 Gross Pay:       ${fmt(row.grossEarnings)}`,
    `📉 PF (Your Share): ${fmt(row.pfEE)}`,
    `📉 ESIC:            ${fmt(row.esicEE)}`,
    `📉 Prof. Tax:       ${fmt(row.pt)}`,
    ``,
    `✅ *Net Pay: ${fmt(row.netPay)}*`,
    ``,
    `_Send "payslip" to get your PDF payslip._`,
  ].join('\n');

  await _sendText(waId, msg);
  return { handled: true, action: 'salary_sent' };
}

async function handlePFRequest(employee, waId) {
  const dec = decryptPII(employee);

  if (!employee.uan) {
    await _sendText(waId,
      `Hi ${employee.name}! Your UAN (Universal Account Number) is not registered in MTOS.\n` +
      `Please contact HR to update your UAN.`
    );
    return { handled: true, action: 'no_uan' };
  }

  const msg = [
    `*PF Account Details — ${employee.name}*`,
    ``,
    `🔢 UAN: *${employee.uan}*`,
    ``,
    `To check your PF balance:`,
    `📱 EPFO App: https://play.google.com/store/apps/details?id=com.epf.umang`,
    `🌐 Portal: https://passbook.epfindia.gov.in`,
    `📞 Helpline: 1800-118-005`,
    ``,
    `_Your UAN is used to transfer PF when you change jobs._`,
  ].join('\n');

  await _sendText(waId, msg);
  return { handled: true, action: 'pf_info_sent' };
}

async function handleAttendanceRequest(employee, waId) {
  const now   = new Date();
  const month = now.getMonth() === 0 ? 12 : now.getMonth();
  const year  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();

  const attendance = await prisma.attendance.findFirst({
    where: {
      month, year,
      tenderEmployee: { employeeId: employee.id },
    },
    select: { presentDays: true, otHours: true, month: true, year: true },
  });

  if (!attendance) {
    await _sendText(waId,
      `Hi ${employee.name}! Attendance for ${MONTHS[month]} ${year} is not entered yet.\n` +
      `Please check with your supervisor.`
    );
    return { handled: true, action: 'no_attendance' };
  }

  const msg = [
    `*Attendance — ${MONTHS[month]} ${year}*`,
    `👤 ${employee.name}`,
    ``,
    `📅 Days Present: *${attendance.presentDays}*`,
    `⏰ OT Hours:     *${attendance.otHours || 0}*`,
    ``,
    `_Send "salary" to see your pay calculation._`,
  ].join('\n');

  await _sendText(waId, msg);
  return { handled: true, action: 'attendance_sent' };
}

async function handleHelp(employee, waId) {
  const msg = [
    `Hi ${employee.name}! 👋`,
    ``,
    `*MTOS Self-Service Commands:*`,
    ``,
    `📄 *payslip*  — Get PDF salary slip`,
    `💰 *salary*   — View salary breakdown`,
    `🏦 *pf*       — View PF/UAN details`,
    `📅 *attend*   — Check attendance`,
    `❓ *help*     — Show this menu`,
    ``,
    `_All messages are in English. Type the command exactly._`,
  ].join('\n');

  await _sendText(waId, msg);
  return { handled: true, action: 'help_sent' };
}

// ── WATI API Helpers ──────────────────────────────────────────────

async function _sendText(to, text) {
  if (!process.env.WHATSAPP_API_URL || !process.env.WHATSAPP_API_KEY) {
    logger.warn('[WhatsApp] Not configured — skipping send');
    return;
  }

  try {
    const r = await fetch(
      `${process.env.WHATSAPP_API_URL}/api/v1/sendSessionMessage/${to}`,
      {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization:  `Bearer ${process.env.WHATSAPP_API_KEY}`,
        },
        body: JSON.stringify({ messageText: text }),
      }
    );
    if (!r.ok) logger.warn(`[WhatsApp] sendText failed: ${await r.text()}`);
  } catch (err) {
    logger.error(`[WhatsApp] sendText error: ${err.message}`);
  }
}

async function _sendDocument(to, buffer, filename) {
  if (!process.env.WHATSAPP_API_URL || !process.env.WHATSAPP_API_KEY) return;

  try {
    const FormData = require('form-data');
    const form     = new FormData();
    form.append('file', buffer, { filename, contentType: 'application/pdf' });

    const r = await fetch(
      `${process.env.WHATSAPP_API_URL}/api/v1/sendSessionFile/${to}`,
      {
        method:  'POST',
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_API_KEY}`,
          ...form.getHeaders(),
        },
        body: form,
      }
    );
    if (!r.ok) logger.warn(`[WhatsApp] sendDocument failed: ${await r.text()}`);
  } catch (err) {
    logger.error(`[WhatsApp] sendDocument error: ${err.message}`);
  }
}

// ── DB Helpers ────────────────────────────────────────────────────

async function _findEmployeeByPhone(waId) {
  // Phone in DB may be stored without country code or with +91
  const variants = [
    waId,
    waId.replace(/^91/, ''),
    '+' + waId,
    '0' + waId.replace(/^91/, ''),
  ];

  // Note: phone is encrypted if PII encryption is enabled
  // For phone-based lookup, store phone in a separate searchable field
  // or use a phone_hash column for lookup
  return prisma.employee.findFirst({
    where: {
      phone: { in: variants },
      status: { not: 'EXITED' },
    },
    select: { id: true, name: true, tenantId: true, uan: true, phone: true, esicNumber: true },
  });
}

async function _getLastPayrollRow(employeeId) {
  return prisma.payrollRow.findFirst({
    where: { employeeId, run: { status: { in: ['COMPLETED', 'LOCKED'] } } },
    include: { run: { select: { id: true, month: true, year: true } } },
    orderBy: [{ run: { year: 'desc' } }, { run: { month: 'desc' } }],
  });
}

function _parseCommand(text) {
  const clean = text.toLowerCase().trim();
  if (clean.includes('payslip') || clean.includes('slip')) return 'payslip';
  if (clean.includes('salary') || clean.includes('pay'))   return 'salary';
  if (clean.includes('pf') || clean.includes('epf') || clean.includes('uan')) return 'pf';
  if (clean.includes('attend'))                             return 'attend';
  if (clean.includes('help') || clean.includes('hi') || clean.includes('hello')) return 'help';
  return 'unknown';
}

module.exports = { handleIncomingMessage };
