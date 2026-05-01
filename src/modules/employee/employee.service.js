'use strict';

// ═══════════════════════════════════════════════════════════════════
// employee.service.js — Business logic for employee domain
// Handles: PII encryption, UAN uniqueness, plan limits, audit
// ═══════════════════════════════════════════════════════════════════

const repo    = require('./employee.repository');
const audit   = require('../../services/auditService');
const storage = require('../../services/storageService');
const { encryptPII, decryptPII, maskPII } = require('../../utils/encryption');

// ── Create Employee ───────────────────────────────────────────────

async function createEmployee(tenantId, rawData, actorUserId, tenant) {
  // Plan limit check
  const currentCount = await repo.countActive(tenantId);
  const limit = tenant?.maxEmployees || 100;
  if (currentCount >= limit) {
    const err = new Error(
      `Employee limit reached (${currentCount}/${limit}). Upgrade your plan to add more employees.`
    );
    err.statusCode = 402;
    throw err;
  }

  // UAN uniqueness check
  if (rawData.uan) {
    const existing = await repo.findByUAN(tenantId, rawData.uan.trim());
    if (existing) {
      const err = new Error(`UAN ${rawData.uan} is already registered (Employee: ${existing.name})`);
      err.statusCode = 409;
      throw err;
    }
  }

  // Encrypt PII before DB write
  const encryptedData = encryptPII(_sanitize(rawData));

  const employee = await repo.create(tenantId, encryptedData);

  await audit.log({
    tenantId,
    userId:     actorUserId,
    action:     'CREATE',
    entityType: 'EMPLOYEE',
    entityId:   employee.id,
    newValues:  maskPII(_sanitize(rawData)), // Masked PII in audit log
  });

  return decryptPII(employee);
}

// ── Get All Employees ─────────────────────────────────────────────

async function getEmployees(tenantId, queryParams) {
  const result = await repo.findAll(tenantId, queryParams);

  // Decrypt PII for each employee
  result.employees = result.employees.map(emp => {
    // Only include masked PII in list view (not full data)
    const decrypted = decryptPII(emp);
    return maskPII(decrypted); // List view: show masked last 4 digits
  });

  return result;
}

// ── Get Single Employee ───────────────────────────────────────────

async function getEmployee(tenantId, employeeId) {
  const employee = await repo.findById(employeeId, tenantId);
  if (!employee) {
    const err = new Error('Employee not found');
    err.statusCode = 404;
    throw err;
  }

  // Full decryption for detail view (authenticated + authorized)
  return decryptPII(employee);
}

// ── Update Employee ───────────────────────────────────────────────

async function updateEmployee(tenantId, employeeId, rawData, actorUserId) {
  const existing = await repo.findById(employeeId, tenantId);
  if (!existing) {
    const err = new Error('Employee not found');
    err.statusCode = 404;
    throw err;
  }

  // If UAN being changed, check uniqueness
  if (rawData.uan && rawData.uan !== decryptPII(existing).uan) {
    const conflict = await repo.findByUAN(tenantId, rawData.uan);
    if (conflict && conflict.id !== employeeId) {
      const err = new Error(`UAN ${rawData.uan} is already registered for ${conflict.name}`);
      err.statusCode = 409;
      throw err;
    }
  }

  const encryptedData = encryptPII(_sanitize(rawData));
  const updated = await repo.update(employeeId, tenantId, encryptedData);

  await audit.log({
    tenantId,
    userId:     actorUserId,
    action:     'UPDATE',
    entityType: 'EMPLOYEE',
    entityId:   employeeId,
    oldValues:  maskPII(_sanitize(decryptPII(existing))),
    newValues:  maskPII(_sanitize(rawData)),
  });

  return decryptPII(updated);
}

// ── Upload Document ───────────────────────────────────────────────

async function uploadDocument(tenantId, employeeId, file, docType, actorUserId) {
  // Verify employee belongs to tenant
  const employee = await repo.findById(employeeId, tenantId);
  if (!employee) {
    const err = new Error('Employee not found');
    err.statusCode = 404;
    throw err;
  }

  const fileKey = await storage.upload(file, `employees/${tenantId}/${employeeId}`);

  const doc = await storage.createDocRecord({
    employeeId,
    docType,
    fileName:        file.originalname,
    fileKey,
    fileSize:        file.size,
    mimeType:        file.mimetype,
    storageProvider: storage.getProvider(),
  });

  await audit.log({
    tenantId,
    userId:     actorUserId,
    action:     'DOCUMENT_UPLOAD',
    entityType: 'EMPLOYEE',
    entityId:   employeeId,
    metadata:   { docType, fileName: file.originalname },
  });

  return doc;
}

// ── Exit Employee from Tender ─────────────────────────────────────

async function exitEmployee(tenantId, tenderEmployeeId, exitData, actorUserId) {
  const te = await repo.exitEmployee(tenderEmployeeId, tenantId, exitData);

  await audit.log({
    tenantId,
    userId:     actorUserId,
    action:     'EMPLOYEE_EXIT',
    entityType: 'EMPLOYEE',
    entityId:   te.employeeId,
    newValues:  { exitDate: exitData.exitDate, exitReason: exitData.exitReason },
  });

  return te;
}

// ── Private helpers ───────────────────────────────────────────────

function _sanitize(data) {
  const clean = { ...data };

  // Convert empty strings → null for optional fields
  const optionalFields = [
    'phone', 'email', 'address', 'aadhaar', 'pan', 'uan',
    'pfNumber', 'esicNumber', 'bankAccount', 'ifscCode', 'bankName',
    'fatherName', 'photoUrl', 'gender',
  ];
  for (const f of optionalFields) {
    if (clean[f] === '') clean[f] = null;
  }

  // Parse DOB
  if (clean.dob === '' || clean.dob === null || clean.dob === undefined) {
    clean.dob = null;
  } else if (typeof clean.dob === 'string') {
    const parsed = new Date(clean.dob);
    clean.dob = isNaN(parsed.getTime()) ? null : parsed;
  }

  // Normalize UAN to uppercase string
  if (clean.uan) clean.uan = String(clean.uan).trim();
  if (clean.pan) clean.pan = String(clean.pan).toUpperCase().trim();

  return clean;
}

module.exports = {
  createEmployee,
  getEmployees,
  getEmployee,
  updateEmployee,
  uploadDocument,
  exitEmployee,
};
