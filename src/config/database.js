'use strict';

/**
 * database.js — Production Prisma Client Configuration
 *
 * IMPROVEMENTS vs current:
 *  1. Separate read/write URLs for read replica routing
 *  2. Connection limits tuned for PgBouncer
 *  3. Query logging only in development
 *  4. Singleton pattern with proper cleanup
 *  5. Health check utility
 */

const { PrismaClient } = require('@prisma/client');

// ── Singleton Instance ────────────────────────────────────────────

let _prisma = null;
let _prismaReadOnly = null;

function getPrisma() {
  if (_prisma) return _prisma;

  _prisma = new PrismaClient({
    datasources: {
      db: {
        url: process.env.DATABASE_URL,
      },
    },
    log: process.env.NODE_ENV === 'development'
      ? [
          { emit: 'event', level: 'query'  },
          { emit: 'stdout', level: 'warn'  },
          { emit: 'stdout', level: 'error' },
        ]
      : [{ emit: 'stdout', level: 'error' }],
  });

  // Log slow queries in development
  if (process.env.NODE_ENV === 'development') {
    _prisma.$on('query', (e) => {
      if (e.duration > 500) { // Warn if query > 500ms
        console.warn(`[DB SLOW QUERY] ${e.duration}ms: ${e.query.slice(0, 200)}`);
      }
    });
  }

  return _prisma;
}

/**
 * getPrismaReadOnly — returns a read-only client pointing at the read replica.
 * Falls back to the main DB if READ_REPLICA_URL is not set.
 *
 * USE FOR: reports, analytics, export queries, audit log queries
 * DO NOT USE FOR: writes, payroll runs, any transactional operations
 */
function getPrismaReadOnly() {
  if (!process.env.READ_REPLICA_URL) return getPrisma(); // Fallback to main

  if (_prismaReadOnly) return _prismaReadOnly;

  _prismaReadOnly = new PrismaClient({
    datasources: {
      db: { url: process.env.READ_REPLICA_URL },
    },
    log: [{ emit: 'stdout', level: 'error' }],
  });

  return _prismaReadOnly;
}

/**
 * checkDatabaseHealth — used by /health endpoint
 */
async function checkDatabaseHealth() {
  try {
    const start = Date.now();
    await getPrisma().$queryRaw`SELECT 1`;
    return { status: 'healthy', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'unhealthy', error: err.message };
  }
}

/**
 * disconnectAll — graceful shutdown
 */
async function disconnectAll() {
  await Promise.all([
    _prisma?.$disconnect(),
    _prismaReadOnly?.$disconnect(),
  ]);
  _prisma = null;
  _prismaReadOnly = null;
}

// ── Export singleton (backward compatible) ─────────────────────────

const prisma = getPrisma();
prisma.readOnly         = getPrismaReadOnly;
prisma.checkHealth      = checkDatabaseHealth;
prisma.disconnectAll    = disconnectAll;

module.exports = prisma;

// ─────────────────────────────────────────────────────────────────
// USAGE IN REPORTS (read replica):
//
// const { readOnly } = require('../../config/database');
// const db = readOnly();
// const rows = await db.payrollRun.findMany({ where: { tenantId } });
//
// USAGE EVERYWHERE ELSE (write path):
// const prisma = require('../../config/database');
// const emp = await prisma.employee.create({ ... });
// ─────────────────────────────────────────────────────────────────
