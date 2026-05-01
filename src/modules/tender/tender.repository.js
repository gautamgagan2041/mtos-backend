'use strict';

/**
 * tender.repository.js
 * Pure DB layer — no business logic, no HTTP, no auditing.
 * Every query scopes to tenantId.
 */

const prisma = require('../../config/database');

// ── List / Search ─────────────────────────────────────────────────

async function findAll(tenantId, { status, clientId, search } = {}) {
  const where = { tenantId };
  if (status)   where.status   = status;
  if (clientId) where.clientId = clientId;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { code: { contains: search, mode: 'insensitive' } },
    ];
  }

  return prisma.tender.findMany({
    where,
    include: {
      client:  { select: { id: true, name: true, shortName: true, state: true } },
      _count:  { select: { employees: { where: { isActive: true } }, payrollRuns: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

async function findById(id, tenantId) {
  return prisma.tender.findFirst({
    where: { id, tenantId },
    include: {
      client: true,
      legacySalaryStructures: true,
      salaryStructure: {
        include: {
          components: {
            where:   { isActive: true },
            include: { component: true },
            orderBy: { component: { displayOrder: 'asc' } },
          },
        },
      },
      employees: {
        where:   { isActive: true },
        include: { employee: { select: { id: true, name: true, sr: true, uan: true, esicNumber: true } } },
        orderBy: { employee: { sr: 'asc' } },
      },
      _count: { select: { employees: true, payrollRuns: true } },
    },
  });
}

async function findByCode(tenantId, code) {
  return prisma.tender.findFirst({ where: { tenantId, code } });
}

// ── CRUD ──────────────────────────────────────────────────────────

async function create(tenantId, data) {
  const { salaryStructures, ...tenderData } = data;
  return prisma.tender.create({
    data: {
      ...tenderData,
      tenantId,
      startDate: new Date(tenderData.startDate),
      endDate:   new Date(tenderData.endDate),
      legacySalaryStructures: salaryStructures?.length
        ? { create: salaryStructures }
        : undefined,
    },
    include: { legacySalaryStructures: true, client: true },
  });
}

async function update(id, tenantId, data) {
  const { salaryStructures, ...tenderData } = data;
  return prisma.tender.update({
    where: { id },
    data: {
      ...tenderData,
      startDate: tenderData.startDate ? new Date(tenderData.startDate) : undefined,
      endDate:   tenderData.endDate   ? new Date(tenderData.endDate)   : undefined,
    },
  });
}

async function assignSalaryStructure(id, tenantId, salaryStructureId) {
  return prisma.tender.update({
    where: { id },
    data:  { salaryStructureId: salaryStructureId || null },
    include: {
      salaryStructure: {
        include: {
          components: {
            where:   { isActive: true },
            include: { component: true },
          },
        },
      },
    },
  });
}

// ── Employees on Tender ───────────────────────────────────────────

async function getEmployees(tenderId, { month, year } = {}) {
  return prisma.tenderEmployee.findMany({
    where:   { tenderId, isActive: true },
    include: {
      employee:   true,
      attendance: month && year
        ? { where: { month: Number(month), year: Number(year) } }
        : false,
    },
    orderBy: { employee: { sr: 'asc' } },
  });
}

async function addEmployee(tenderId, tenantId, employeeData) {
  return prisma.$transaction(async (tx) => {
    // Verify employee belongs to tenant
    const emp = await tx.employee.findFirst({
      where: { id: employeeData.employeeId, tenantId },
    });
    if (!emp) throw new Error('Employee not found in this company');

    // Check not already active on this tender
    const existing = await tx.tenderEmployee.findFirst({
      where: { tenderId, employeeId: employeeData.employeeId, isActive: true },
    });
    if (existing) throw new Error('Employee is already active on this tender');

    const te = await tx.tenderEmployee.create({
      data: { ...employeeData, tenderId },
      include: { employee: true },
    });

    // Update employee status to ACTIVE if not already
    if (emp.status !== 'ACTIVE') {
      await tx.employee.update({
        where: { id: emp.id },
        data:  { status: 'ACTIVE' },
      });
    }

    return te;
  });
}

// ── Salary Structure ──────────────────────────────────────────────

async function upsertLegacySalaryStructure(tenderId, rank, data) {
  return prisma.tenderSalaryStructure.upsert({
    where:  { tenderId_rank: { tenderId, rank } },
    update: data,
    create: { tenderId, rank, ...data },
  });
}

// ── Profitability Data ────────────────────────────────────────────

async function getProfitabilityData(tenderId, tenantId) {
  return prisma.tender.findFirst({
    where: { id: tenderId, tenantId },
    include: {
      client:  { select: { name: true, gstin: true } },
      payrollRuns: {
        where:   { status: { in: ['COMPLETED', 'LOCKED'] } },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        take:    12,
        select: {
          id: true, month: true, year: true, status: true,
          totalGross: true, totalNet: true,
          totalPFEE: true, totalPFER: true,
          totalESIC: true, totalPT: true,
          totalProvisions: true, totalEmployerCosts: true,
          totalCostToClient: true,
          _count: { select: { rows: true } },
        },
      },
      invoices: {
        where:   { status: { not: 'CANCELLED' } },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        take:    12,
        select: {
          id: true, month: true, year: true,
          grandTotal: true, status: true,
        },
      },
      employees: {
        where: { isActive: true },
        select: {
          id: true, rank: true,
          employee: { select: { name: true } },
        },
      },
    },
  });
}

// ── Expiry Check ──────────────────────────────────────────────────

async function findExpiringSoon(tenantId, daysAhead = 60) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + daysAhead);

  return prisma.tender.findMany({
    where: {
      tenantId,
      status:  'ACTIVE',
      endDate: { lte: cutoff, gte: new Date() },
    },
    include: {
      client:    { select: { name: true } },
      employees: { where: { isActive: true }, select: { id: true } },
    },
    orderBy: { endDate: 'asc' },
  });
}

// ── Pay Components & Salary Structures ───────────────────────────

async function listPayComponents(tenantId) {
  return prisma.payComponent.findMany({
    where:   { tenantId, isActive: true },
    orderBy: [{ type: 'asc' }, { displayOrder: 'asc' }],
  });
}

async function createPayComponent(tenantId, data) {
  return prisma.payComponent.create({ data: { ...data, tenantId } });
}

async function listSalaryStructures(tenantId) {
  return prisma.salaryStructure.findMany({
    where:   { tenantId, isActive: true },
    include: {
      components: {
        where:   { isActive: true },
        include: { component: true },
        orderBy: { component: { displayOrder: 'asc' } },
      },
    },
    orderBy: { name: 'asc' },
  });
}

async function createSalaryStructure(tenantId, { name, description, pfRule, pfCap, baseDivisor, components }) {
  return prisma.salaryStructure.create({
    data: {
      tenantId, name, description,
      pfRule:      pfRule      || 'CAPPED',
      pfCap:       pfCap       || 15000,
      baseDivisor: baseDivisor || 26,
      components: components?.length ? {
        create: components.map(c => ({
          componentId:     c.componentId,
          calculationType: c.calculationType,
          value:           c.value           || null,
          formula:         c.formula         || null,
          threshold:       c.threshold       || null,
          thresholdBonus:  c.thresholdBonus  || null,
          isActive:        true,
        })),
      } : undefined,
    },
    include: { components: { include: { component: true } } },
  });
}

module.exports = {
  findAll, findById, findByCode,
  create, update, assignSalaryStructure,
  getEmployees, addEmployee,
  upsertLegacySalaryStructure,
  getProfitabilityData, findExpiringSoon,
  listPayComponents, createPayComponent,
  listSalaryStructures, createSalaryStructure,
};
