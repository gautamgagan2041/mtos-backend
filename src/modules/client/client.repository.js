'use strict';

// ═══════════════════════════════════════════════════════════════════
// client.repository.js
// ═══════════════════════════════════════════════════════════════════

const prisma = require('../../config/database');

async function findAll(tenantId, { search, isActive = true } = {}) {
  const where = { tenantId, isActive: isActive !== 'false' };
  if (search) {
    where.OR = [
      { name:      { contains: search, mode: 'insensitive' } },
      { shortName: { contains: search, mode: 'insensitive' } },
      { gstin:     { contains: search, mode: 'insensitive' } },
    ];
  }
  return prisma.client.findMany({
    where,
    include: {
      _count: {
        select: {
          tenders: { where: { status: 'ACTIVE' } },
        },
      },
    },
    orderBy: { name: 'asc' },
  });
}

async function findById(id, tenantId) {
  return prisma.client.findFirst({
    where: { id, tenantId },
    include: {
      tenders: {
        where:   { status: { in: ['ACTIVE', 'COMPLETED'] } },
        include: { _count: { select: { employees: { where: { isActive: true } } } } },
        orderBy: { createdAt: 'desc' },
      },
      _count: { select: { tenders: true } },
    },
  });
}

async function findByGSTIN(tenantId, gstin) {
  if (!gstin) return null;
  return prisma.client.findFirst({ where: { tenantId, gstin, isActive: true } });
}

async function create(tenantId, data) {
  return prisma.client.create({ data: { ...data, tenantId } });
}

async function update(id, tenantId, data) {
  return prisma.client.update({ where: { id }, data });
}

async function deactivate(id, tenantId) {
  return prisma.$transaction([
    prisma.client.update({ where: { id }, data: { isActive: false } }),
    prisma.tender.updateMany({
      where: { clientId: id, tenantId, status: { in: ['ACTIVE', 'DRAFT'] } },
      data:  { status: 'TERMINATED' },
    }),
  ]);
}

module.exports = { findAll, findById, findByGSTIN, create, update, deactivate };
