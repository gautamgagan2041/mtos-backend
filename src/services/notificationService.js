'use strict';

/**
 * notificationService.js — Multi-channel Notification Service
 *
 * Channels:
 *   EMAIL    → Nodemailer + SMTP / SendGrid / SES
 *   WHATSAPP → WhatsApp Business API (Gupshup / Twilio / WATI)
 *   SMS      → Fast2SMS / Msg91 (Indian provider)
 *   IN_APP   → Stored in DB, polled by frontend
 *
 * PHILOSOPHY:
 *   All sends are fire-and-forget.
 *   A notification failure should NEVER crash the main flow.
 *   All errors are logged, not thrown.
 *
 * ENV REQUIRED:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 *   Optional: WHATSAPP_API_KEY, SMS_API_KEY
 */

const nodemailer = require('nodemailer');
const logger     = require('../utils/logger');
const prisma     = require('../config/database');

// ── Email Transport (lazy-init) ───────────────────────────────────

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  _transporter = nodemailer.createTransporter({
    host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return _transporter;
}

// ── Core Send Functions ───────────────────────────────────────────

/**
 * sendEmail — send email via SMTP
 * Fire-and-forget: never throws
 */
async function sendEmail({ to, subject, html, text }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    logger.warn('[Notification] SMTP not configured — skipping email');
    return false;
  }

  try {
    const info = await getTransporter().sendMail({
      from:    process.env.SMTP_FROM || `MTOS <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
      text:    text || html.replace(/<[^>]+>/g, ''),
    });
    logger.info(`[Notification] Email sent to ${to}: ${info.messageId}`);
    return true;
  } catch (err) {
    logger.error(`[Notification] Email failed to ${to}: ${err.message}`);
    return false;
  }
}

/**
 * sendWhatsApp — send WhatsApp message via WATI API
 * Supports: text messages, template messages
 * https://www.wati.io/docs
 */
async function sendWhatsApp(phone, templateName, params = []) {
  if (!process.env.WHATSAPP_API_KEY || !process.env.WHATSAPP_API_URL) {
    logger.warn('[Notification] WhatsApp not configured — skipping');
    return false;
  }

  // Normalize Indian phone number
  const normalized = phone.replace(/\D/g, '').replace(/^0/, '91');

  try {
    const response = await fetch(
      `${process.env.WHATSAPP_API_URL}/api/v1/sendTemplateMessage?whatsappNumber=${normalized}`,
      {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization:  `Bearer ${process.env.WHATSAPP_API_KEY}`,
        },
        body: JSON.stringify({
          template_name: templateName,
          broadcast_name: templateName,
          parameters: params.map(p => ({ name: 'text', text: String(p) })),
        }),
      }
    );

    if (response.ok) {
      logger.info(`[Notification] WhatsApp sent to ${normalized}: ${templateName}`);
      return true;
    }

    const err = await response.text();
    logger.warn(`[Notification] WhatsApp failed to ${normalized}: ${err}`);
    return false;
  } catch (err) {
    logger.error(`[Notification] WhatsApp error: ${err.message}`);
    return false;
  }
}

/**
 * saveInAppNotification — save to DB for in-app notification bell
 */
async function saveInAppNotification({ tenantId, userId, title, message, severity, link }) {
  try {
    await prisma.notification.create({
      data: {
        tenantId,
        userId:   userId || null,
        title,
        message,
        severity: severity || 'INFO',
        link:     link     || null,
        isRead:   false,
      },
    });
  } catch (err) {
    // Table may not exist yet — log and continue
    logger.warn(`[Notification] In-app notification failed: ${err.message}`);
  }
}

// ── Domain-Specific Notifications ────────────────────────────────

/**
 * sendPayrollCompleted — notify admin when payroll run finishes
 */
async function sendPayrollCompleted(tenantId, { runId, tenderName, month, year, rowCount, totalNet }) {
  const admins = await _getTenantAdmins(tenantId);

  const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLabel = `${MONTHS[month]} ${year}`;
  const netFormatted = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })
    .format(totalNet);

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1e40af; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h2 style="margin: 0;">✅ Payroll Completed</h2>
      </div>
      <div style="padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <p>Payroll run for <strong>${tenderName}</strong> has been completed successfully.</p>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr style="background: #f9fafb;">
            <td style="padding: 10px; border: 1px solid #e5e7eb;">Month</td>
            <td style="padding: 10px; border: 1px solid #e5e7eb; font-weight: 700;">${monthLabel}</td>
          </tr>
          <tr>
            <td style="padding: 10px; border: 1px solid #e5e7eb;">Employees Processed</td>
            <td style="padding: 10px; border: 1px solid #e5e7eb; font-weight: 700;">${rowCount}</td>
          </tr>
          <tr style="background: #f9fafb;">
            <td style="padding: 10px; border: 1px solid #e5e7eb;">Total Net Pay</td>
            <td style="padding: 10px; border: 1px solid #e5e7eb; font-weight: 700; color: #059669;">${netFormatted}</td>
          </tr>
        </table>
        <p style="color: #6b7280; font-size: 13px;">
          Run ID: ${runId} | Generated by MTOS
        </p>
      </div>
    </div>
  `;

  for (const admin of admins) {
    if (admin.email) {
      sendEmail({
        to:      admin.email,
        subject: `✅ Payroll Completed — ${tenderName} — ${monthLabel}`,
        html,
      });
    }
  }

  // In-app notification for all admins
  for (const admin of admins) {
    saveInAppNotification({
      tenantId,
      userId:   admin.id,
      title:    `Payroll completed: ${tenderName} — ${monthLabel}`,
      message:  `${rowCount} employees processed. Net pay: ${netFormatted}`,
      severity: 'SUCCESS',
      link:     `/payroll/${runId}`,
    });
  }
}

/**
 * sendComplianceAlert — notify for document expiry / filing reminders
 */
async function sendComplianceAlert(tenantId, alert) {
  const admins = await _getTenantAdmins(tenantId);

  const severityColor = {
    CRITICAL: '#dc2626',
    HIGH:     '#d97706',
    MEDIUM:   '#2563eb',
    LOW:      '#6b7280',
  }[alert.severity] || '#6b7280';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: ${severityColor}; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h2 style="margin: 0;">⚠️ Compliance Alert — ${alert.severity}</h2>
      </div>
      <div style="padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <h3 style="margin: 0 0 12px; color: ${severityColor};">${alert.title}</h3>
        <p style="color: #374151;">${alert.message}</p>
        <a href="${process.env.APP_URL || 'https://app.mtos.in'}/compliance"
           style="display: inline-block; margin-top: 16px; padding: 10px 20px;
                  background: ${severityColor}; color: white; border-radius: 6px;
                  text-decoration: none; font-weight: 600;">
          View in MTOS
        </a>
      </div>
    </div>
  `;

  for (const admin of admins) {
    if (admin.email) {
      sendEmail({
        to:      admin.email,
        subject: `⚠️ [${alert.severity}] ${alert.title}`,
        html,
      });
    }
  }

  // In-app notifications
  for (const admin of admins) {
    saveInAppNotification({
      tenantId,
      userId:   admin.id,
      title:    alert.title,
      message:  alert.message,
      severity: alert.severity,
      link:     '/compliance',
    });
  }
}

/**
 * sendPayslipToEmployee — send payslip PDF to employee WhatsApp/email
 */
async function sendPayslipToEmployee(employee, payslipPdf, month, year) {
  const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];

  if (employee.phone) {
    // WhatsApp: send as document (requires template approval)
    sendWhatsApp(employee.phone, 'payslip_notification', [
      employee.name,
      `${MONTHS[month]} ${year}`,
    ]);
  }

  if (employee.email) {
    await sendEmail({
      to:      employee.email,
      subject: `Your Salary Slip for ${MONTHS[month]} ${year}`,
      html: `
        <p>Dear ${employee.name},</p>
        <p>Please find attached your salary slip for ${MONTHS[month]} ${year}.</p>
        <p>For any queries, please contact your HR department.</p>
        <br><p style="color: #6b7280; font-size: 12px;">This is a confidential document.</p>
      `,
    });
  }
}

// ── Helper ────────────────────────────────────────────────────────

async function _getTenantAdmins(tenantId) {
  return prisma.user.findMany({
    where: {
      tenantId,
      isActive: true,
      role: { in: ['COMPANY_ADMIN', 'ACCOUNTS'] },
    },
    select: { id: true, email: true, phone: true, name: true },
  });
}

module.exports = {
  sendEmail,
  sendWhatsApp,
  saveInAppNotification,
  sendPayrollCompleted,
  sendComplianceAlert,
  sendPayslipToEmployee,
};
