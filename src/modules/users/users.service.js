'use strict';

/**
 * users.service.js — User management within a tenant
 *
 * Features:
 *  1. List users in tenant
 *  2. Invite new user (send email with temp password)
 *  3. Update user role
 *  4. Deactivate user (soft delete)
 *  5. Change own password
 *  6. Per-tender permission assignment (for fine-grained RBAC)
 */

const prisma   = require('../../config/database');
const bcrypt   = require('bcrypt');
const crypto   = require('crypto');
const audit    = require('../../services/auditService');
const notify   = require('../../services/notificationService');
const { validatePassword, ROLE_PERMISSIONS } = require('../../middleware/auth');

const VALID_ROLES = ['COMPANY_ADMIN', 'ACCOUNTS', 'HR_MANAGER', 'COMPLIANCE', 'VIEWER'];

// ── List Users ────────────────────────────────────────────────────

async function getUsers(tenantId) {
  return prisma.user.findMany({
    where:  { tenantId },
    select: {
      id: true, name: true, email: true, role: true,
      isActive: true, phone: true, createdAt: true,
    },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
  });
}

// ── Invite User ───────────────────────────────────────────────────

async function inviteUser(tenantId, { name, email, role, phone }, invitedByUserId, tenant) {
  if (!name || !email || !role) {
    const e = new Error('name, email, role are required'); e.statusCode = 400; throw e;
  }
  if (!VALID_ROLES.includes(role)) {
    const e = new Error(`Invalid role: ${role}. Must be one of: ${VALID_ROLES.join(', ')}`);
    e.statusCode = 400; throw e;
  }

  // Check not already exists
  const existing = await prisma.user.findFirst({
    where: { email: email.toLowerCase(), tenantId },
  });
  if (existing) {
    const e = new Error(`User with email ${email} already exists in this company`);
    e.statusCode = 409; throw e;
  }

  // Generate temporary password
  const tempPassword = crypto.randomBytes(6).toString('hex'); // 12 char hex
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  const user = await prisma.user.create({
    data: {
      tenantId,
      name:         name.trim(),
      email:        email.toLowerCase().trim(),
      passwordHash,
      role,
      phone:        phone || null,
      isActive:     true,
      mustChangePassword: true, // Force password change on first login
    },
    select: {
      id: true, name: true, email: true, role: true, isActive: true, createdAt: true,
    },
  });

  // Send invite email with temp credentials
  notify.sendEmail({
    to:      email,
    subject: `You've been invited to ${tenant.name} on MTOS`,
    html:    _inviteEmailHTML(name, tenant.name, email, tempPassword),
  }).catch(() => {});

  await audit.log({
    tenantId, userId: invitedByUserId,
    action: 'USER_INVITE', entityType: 'USER', entityId: user.id,
    newValues: { name, email, role },
  });

  return { user, tempPasswordSent: true };
}

// ── Update Role ───────────────────────────────────────────────────

async function updateUserRole(tenantId, userId, newRole, actorUserId) {
  if (!VALID_ROLES.includes(newRole)) {
    const e = new Error(`Invalid role: ${newRole}`); e.statusCode = 400; throw e;
  }

  const user = await prisma.user.findFirst({ where: { id: userId, tenantId } });
  if (!user) { const e = new Error('User not found'); e.statusCode = 404; throw e; }

  // Cannot demote yourself
  if (userId === actorUserId) {
    const e = new Error('You cannot change your own role'); e.statusCode = 403; throw e;
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data:  { role: newRole },
    select: { id: true, name: true, email: true, role: true },
  });

  await audit.log({
    tenantId, userId: actorUserId,
    action: 'USER_ROLE_CHANGE', entityType: 'USER', entityId: userId,
    oldValues: { role: user.role }, newValues: { role: newRole },
  });

  return updated;
}

// ── Deactivate User ───────────────────────────────────────────────

async function deactivateUser(tenantId, userId, actorUserId) {
  const user = await prisma.user.findFirst({ where: { id: userId, tenantId } });
  if (!user) { const e = new Error('User not found'); e.statusCode = 404; throw e; }
  if (userId === actorUserId) {
    const e = new Error('You cannot deactivate your own account'); e.statusCode = 403; throw e;
  }

  // Must leave at least 1 active admin
  if (user.role === 'COMPANY_ADMIN') {
    const adminCount = await prisma.user.count({
      where: { tenantId, role: 'COMPANY_ADMIN', isActive: true },
    });
    if (adminCount <= 1) {
      const e = new Error('Cannot deactivate the only active company admin');
      e.statusCode = 409; throw e;
    }
  }

  await prisma.user.update({ where: { id: userId }, data: { isActive: false } });

  await audit.log({
    tenantId, userId: actorUserId,
    action: 'USER_DEACTIVATE', entityType: 'USER', entityId: userId,
    oldValues: { name: user.name, role: user.role },
  });

  return { deactivated: true };
}

// ── Change Password ───────────────────────────────────────────────

async function changePassword(userId, { currentPassword, newPassword }) {
  const errors = validatePassword(newPassword);
  if (errors.length > 0) {
    const e = new Error(errors.join('. ')); e.statusCode = 400; throw e;
  }

  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { id: true, passwordHash: true },
  });

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    const e = new Error('Current password is incorrect'); e.statusCode = 401; throw e;
  }

  const newHash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({
    where: { id: userId },
    data:  { passwordHash: newHash, mustChangePassword: false },
  });

  return { changed: true };
}

// ── Per-Tender Permissions ────────────────────────────────────────

async function setTenderPermission(tenantId, { userId, tenderId, canEdit, canRunPayroll, canView }, actorUserId) {
  // Verify both user and tender belong to this tenant
  const [user, tender] = await Promise.all([
    prisma.user.findFirst({ where: { id: userId, tenantId } }),
    prisma.tender.findFirst({ where: { id: tenderId, tenantId } }),
  ]);
  if (!user)   { const e = new Error('User not found');   e.statusCode = 404; throw e; }
  if (!tender) { const e = new Error('Tender not found'); e.statusCode = 404; throw e; }

  const permission = await prisma.userTenderPermission.upsert({
    where:  { userId_tenderId: { userId, tenderId } },
    update: { canEdit: canEdit || false, canRunPayroll: canRunPayroll || false, canView: canView !== false },
    create: { userId, tenderId, canEdit: canEdit || false, canRunPayroll: canRunPayroll || false, canView: canView !== false },
  });

  await audit.log({
    tenantId, userId: actorUserId,
    action: 'TENDER_PERMISSION_SET', entityType: 'USER', entityId: userId,
    newValues: { tenderId, canEdit, canRunPayroll },
  });

  return permission;
}

// ── Helper ────────────────────────────────────────────────────────

function _inviteEmailHTML(name, companyName, email, tempPassword) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1e40af; color: white; padding: 24px; border-radius: 8px 8px 0 0;">
        <h2 style="margin: 0;">You've been invited to MTOS</h2>
      </div>
      <div style="padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <p>Hi <strong>${name}</strong>,</p>
        <p>You've been added to <strong>${companyName}</strong> on MTOS (Manpower Tender Operating System).</p>
        <p><strong>Your login details:</strong></p>
        <table style="background: #f9fafb; width: 100%; border-radius: 6px; padding: 12px; border: 1px solid #e5e7eb;">
          <tr><td style="padding: 6px;"><strong>URL</strong></td><td>${process.env.APP_URL || 'https://app.mtos.in'}</td></tr>
          <tr><td style="padding: 6px;"><strong>Email</strong></td><td>${email}</td></tr>
          <tr><td style="padding: 6px;"><strong>Temp Password</strong></td><td><code style="background:#fff; padding:2px 6px; border-radius:3px;">${tempPassword}</code></td></tr>
        </table>
        <p style="color: #dc2626; margin-top: 16px;"><strong>⚠️ You will be asked to change your password on first login.</strong></p>
        <a href="${process.env.APP_URL || 'https://app.mtos.in'}"
           style="display: inline-block; margin-top: 16px; padding: 12px 24px;
                  background: #1e40af; color: white; border-radius: 6px; text-decoration: none; font-weight: 700;">
          Log In to MTOS →
        </a>
      </div>
    </div>
  `;
}

module.exports = {
  getUsers, inviteUser, updateUserRole, deactivateUser,
  changePassword, setTenderPermission,
};
