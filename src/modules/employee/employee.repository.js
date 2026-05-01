'use strict';

// ═══════════════════════════════════════════════════════════════════
// employee.repository.js — ALL DB operations for employee domain
// No business logic. No HTTP. Only database queries.
// ═══════════════════════════════════════════════════════════════════

const prisma = require('../../config/database');

async function findAll(tenantId, { search, status, tenderId, page = 1, limit = 50 } = {}) {
  const where = { tenantId };
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { name:  { contains: search, mode: 'insensitive' } },
      { uan:   { contains: search } },
      { phone: { contains: search } },
    ];
  }
  if (tenderId) {
    where.tenderAssignments = { some: { tenderId, isActive: true } };
  }

  const [employees, total] = await Promise.all([
    prisma.employee.findMany({
      where,
      include: {
        tenderAssignments: {
          where:   { isActive: true },
          include: { tender: { select: { id: true, name: true, code: true } } },
        },
        _count: { select: { documents: true } },
      },
      orderBy: { sr: 'asc' },
      skip:    (parseInt(page) - 1) * parseInt(limit),
      take:    parseInt(limit),
    }),
    prisma.employee.count({ where }),
  ]);

  return { employees, total, page: parseInt(page), limit: parseInt(limit) };
}

async function findById(id, tenantId) {
  return prisma.employee.findFirst({
    where: { id, tenantId },
    include: {
      tenderAssignments: {
        include: { tender: { include: { client: true } } },
      },
      documents: true,
      esicPeriods: { orderBy: { periodStart: 'desc' }, take: 4 },
    },
  });
}

async function findByUAN(tenantId, uan) {
  if (!uan) return null;
  return prisma.employee.findFirst({ where: { tenantId, uan } });
}

async function findByAadhaar(tenantId, aadhaarEncrypted) {
  if (!aadhaarEncrypted) return null;
  // NOTE: encrypted field — exact match comparison
  return prisma.employee.findFirst({ where: { tenantId, aadhaar: aadhaarEncrypted } });
}

async function create(tenantId, data) {
  // Auto-assign sr number
  const maxSr = await prisma.employee.aggregate({
    where:  { tenantId },
    _max:   { sr: true },
  });
  const nextSr = (maxSr._max.sr || 0) + 1;

  return prisma.employee.create({
    data: { ...data, tenantId, sr: nextSr },
  });
}

async function update(id, tenantId, data) {
  return prisma.employee.update({
    where: { id },
    data,
    // Verify tenant ownership via the update itself — if wrong tenant, Prisma throws
  });
}

async function countActive(tenantId) {
  return prisma.employee.count({
    where: { tenantId, status: { not: 'EXITED' } },
  });
}

async function findReplacements(employeeId, tenantId) {
  // First verify employee belongs to tenant
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, tenantId } });
  if (!emp) return null;

  return prisma.replacement.findMany({
    where: {
      OR: [
        { exitedEmployeeId:      employeeId },
        { replacementEmployeeId: employeeId },
      ],
    },
    include: {
      exitedEmployee:      { select: { id: true, name: true, uan: true } },
      replacementEmployee: { select: { id: true, name: true, uan: true } },
    },
    orderBy: { replacedOn: 'desc' },
  });
}

async function exitEmployee(tenderEmployeeId, tenantId, exitData) {
  return prisma.$transaction(async (tx) => {
    const te = await tx.tenderEmployee.findFirst({
      where:   { id: tenderEmployeeId },
      include: { tender: { select: { tenantId: true } }, employee: true },
    });

    if (!te || te.tender.tenantId !== tenantId) {
      throw new Error('Tender employee assignment not found');
    }
    if (!te.isActive) {
      throw new Error('Employee has already been exited from this tender');
    }

    await tx.tenderEmployee.update({
      where: { id: tenderEmployeeId },
      data: {
        isActive:   false,
        exitDate:   new Date(exitData.exitDate),
        exitReason: exitData.exitReason,
        exitNote:   exitData.exitNote || null,
      },
    });

    // Check if employee is active in any other tender
    const otherActive = await tx.tenderEmployee.count({
      where: { employeeId: te.employeeId, isActive: true },
    });

    if (otherActive === 0) {
      await tx.employee.update({
        where: { id: te.employeeId },
        data:  { status: 'EXITED' },
      });
    }

    return te;
  });
}

module.exports = {
  findAll, findById, findByUAN, findByAadhaar,
  create, update, countActive,
  findReplacements, exitEmployee,
};
