'use strict';

/**
 * relievers.service.js — Standby worker (reliever) pool management
 *
 * This is a MANPOWER-INDUSTRY-SPECIFIC feature that no generic HRMS has.
 *
 * BUSINESS PROBLEM:
 *   Manpower companies must cover absent workers at client sites immediately.
 *   They maintain a pool of trained, idle workers (relievers) ready to deploy.
 *   When someone calls in sick at Site A, a reliever from the pool goes in.
 *
 * FEATURES:
 *  1. Register employees as relievers (with specialization + city)
 *  2. Find available relievers for a requirement
 *  3. Deploy reliever to a tender (marks them unavailable)
 *  4. Return reliever to pool when done
 *  5. Track deployment history
 */

const prisma = require('../../config/database');

// ── List Pool ─────────────────────────────────────────────────────

async function getPool(tenantId, { specialization, city, available } = {}) {
  const where = { tenantId };
  if (specialization) where.specialization = specialization;
  if (city)           where.preferredCity  = { contains: city, mode: 'insensitive' };
  if (available !== undefined) where.isAvailable = available === 'true' || available === true;

  const relievers = await prisma.relieversPool.findMany({
    where,
    include: {
      employee:      { select: { id: true, name: true, sr: true, phone: true, uan: true } },
      currentTender: { select: { id: true, name: true, code: true } },
    },
    orderBy: [{ isAvailable: 'desc' }, { employee: { name: 'asc' } }],
  });

  const summary = {
    total:       relievers.length,
    available:   relievers.filter(r => r.isAvailable).length,
    deployed:    relievers.filter(r => !r.isAvailable).length,
    bySpecialization: {},
  };
  relievers.forEach(r => {
    const spec = r.specialization || 'General';
    if (!summary.bySpecialization[spec]) {
      summary.bySpecialization[spec] = { total: 0, available: 0 };
    }
    summary.bySpecialization[spec].total++;
    if (r.isAvailable) summary.bySpecialization[spec].available++;
  });

  return { summary, relievers };
}

// ── Add to Pool ────────────────────────────────────────────────────

async function addToPool(tenantId, { employeeId, specialization, preferredCity, notes }) {
  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, tenantId },
  });
  if (!employee) {
    const e = new Error('Employee not found'); e.statusCode = 404; throw e;
  }

  // Check not already in pool
  const existing = await prisma.relieversPool.findFirst({
    where: { tenantId, employeeId },
  });
  if (existing) {
    const e = new Error(`${employee.name} is already in the reliever pool`);
    e.statusCode = 409; throw e;
  }

  return prisma.relieversPool.create({
    data: { tenantId, employeeId, specialization, preferredCity, notes, isAvailable: true },
    include: { employee: { select: { id: true, name: true, phone: true } } },
  });
}

// ── Find Available Relievers ──────────────────────────────────────

/**
 * findAvailableRelievers — smart matching for deployment
 *
 * @param {string} specialization — "Security Guard", "Housekeeping", etc.
 * @param {string} city           — deployment city
 * @param {number} count          — how many needed
 */
async function findAvailableRelievers(tenantId, { specialization, city, count = 1 }) {
  const where = { tenantId, isAvailable: true };

  if (specialization) {
    // Exact match first, then fall back to similar
    where.specialization = specialization;
  }
  if (city) {
    where.preferredCity = { contains: city, mode: 'insensitive' };
  }

  let relievers = await prisma.relieversPool.findMany({
    where,
    include: {
      employee: { select: { id: true, name: true, phone: true, sr: true } },
    },
    take: count,
    orderBy: { updatedAt: 'asc' }, // FIFO: longest-idle first
  });

  // If not enough with city match, expand to all cities
  if (relievers.length < count && city) {
    const moreIds  = relievers.map(r => r.id);
    const fallback = await prisma.relieversPool.findMany({
      where: {
        tenantId, isAvailable: true,
        id:             { notIn: moreIds },
        specialization: specialization || undefined,
      },
      include: { employee: { select: { id: true, name: true, phone: true, sr: true } } },
      take:    count - relievers.length,
      orderBy: { updatedAt: 'asc' },
    });
    relievers = [...relievers, ...fallback];
  }

  return {
    requested:  count,
    found:      relievers.length,
    sufficient: relievers.length >= count,
    relievers,
  };
}

// ── Deploy Reliever ────────────────────────────────────────────────

async function deployReliever(tenantId, relieverPoolId, { tenderId, notes, deployedBy }) {
  const reliever = await prisma.relieversPool.findFirst({
    where: { id: relieverPoolId, tenantId },
    include: { employee: true },
  });
  if (!reliever) { const e = new Error('Reliever not found'); e.statusCode = 404; throw e; }
  if (!reliever.isAvailable) {
    const e = new Error(`${reliever.employee.name} is already deployed at ${reliever.currentTender?.name || 'another site'}`);
    e.statusCode = 409; throw e;
  }

  // Verify tender belongs to tenant
  const tender = await prisma.tender.findFirst({ where: { id: tenderId, tenantId } });
  if (!tender) { const e = new Error('Tender not found'); e.statusCode = 404; throw e; }

  return prisma.relieversPool.update({
    where: { id: relieverPoolId },
    data: {
      isAvailable:     false,
      currentTenderId: tenderId,
      availableFrom:   null,
      notes:           notes || reliever.notes,
    },
    include: {
      employee:      { select: { id: true, name: true, phone: true } },
      currentTender: { select: { id: true, name: true, code: true } },
    },
  });
}

// ── Return to Pool ────────────────────────────────────────────────

async function returnToPool(tenantId, relieverPoolId, { availableFrom } = {}) {
  const reliever = await prisma.relieversPool.findFirst({
    where: { id: relieverPoolId, tenantId },
    include: { employee: { select: { name: true } } },
  });
  if (!reliever) { const e = new Error('Reliever not found'); e.statusCode = 404; throw e; }

  return prisma.relieversPool.update({
    where: { id: relieverPoolId },
    data: {
      isAvailable:     true,
      currentTenderId: null,
      availableFrom:   availableFrom ? new Date(availableFrom) : null,
    },
    include: { employee: { select: { id: true, name: true, phone: true } } },
  });
}

// ── Remove from Pool ──────────────────────────────────────────────

async function removeFromPool(tenantId, relieverPoolId) {
  const reliever = await prisma.relieversPool.findFirst({
    where: { id: relieverPoolId, tenantId },
  });
  if (!reliever) { const e = new Error('Reliever not found'); e.statusCode = 404; throw e; }
  if (!reliever.isAvailable) {
    const e = new Error('Cannot remove a currently deployed reliever. Return them to pool first.');
    e.statusCode = 409; throw e;
  }
  return prisma.relieversPool.delete({ where: { id: relieverPoolId } });
}

module.exports = {
  getPool, addToPool, findAvailableRelievers,
  deployReliever, returnToPool, removeFromPool,
};
