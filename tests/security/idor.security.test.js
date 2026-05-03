'use strict';

/**
 * Security Tests — Cross-tenant IDOR and Authentication
 *
 * These tests reproduce the exact attack scenarios from the audit report
 * and confirm that each fix prevents exploitation.
 *
 * Tests use mocked Prisma so no real DB is needed.
 */

const {
  findExistingRun,
  lockRun,
  getTenderForPayroll,
  createRunWithRows,
} = require('../../src/repositories/payroll.repository');

const {
  verifyRazorpayWebhook,
  initWebhookVerification,
  parseWebhookPayload,
  captureRawBody,
  _resetForTest,
} = require('../../src/middleware/webhookVerification');

const crypto = require('crypto');

// ─── Prisma mock ──────────────────────────────────────────────────────────────

function makePrismaMock(overrides = {}) {
  return {
    payrollRun: {
      findFirst:   jest.fn(async () => null),
      update:      jest.fn(async (args) => args.data),
      updateMany:  jest.fn(async () => ({ count: 1 })),
      create:      jest.fn(async (args) => ({ id: 'run_new', ...args.data })),
    },
    payrollRow: {
      createMany: jest.fn(async () => ({ count: 0 })),
    },
    tender: {
      findFirst: jest.fn(async () => null),
    },
    employeeLoan: {
      update: jest.fn(async () => ({})),
    },
    $transaction: jest.fn(async (fn) => fn({
      payrollRun:   { create: jest.fn(async (a) => ({ id: 'run_tx', ...a.data })), },
      payrollRow:   { createMany: jest.fn(async () => ({})) },
      employeeLoan: { update: jest.fn(async () => ({})) },
    })),
    ...overrides,
  };
}

// ─── CRIT-03: findExistingRun — tenantId isolation ────────────────────────────

describe('CRIT-03 — findExistingRun tenantId isolation', () => {
  test('includes tenantId in the where clause', async () => {
    const prisma = makePrismaMock();
    await findExistingRun(prisma, 'tenant_A', 'tender_B', 1, 2026);

    expect(prisma.payrollRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant_A' }),
      })
    );
  });

  test('throws when tenantId is omitted (attack vector closed)', async () => {
    const prisma = makePrismaMock();
    // Old bug: findExistingRun(prisma, tenderId, month, year) — no tenantId
    await expect(findExistingRun(prisma, undefined, 'tender_B', 1, 2026))
      .rejects.toThrow(/tenantId is required/);
  });

  test('tenant_A query cannot see tenant_B run — Prisma filter prevents it', async () => {
    const tenantBRun = { id: 'run_B', tenantId: 'tenant_B', status: 'COMPLETED' };
    // Simulate Prisma correctly filtering: tenant_A query returns null
    const prisma = makePrismaMock({
      payrollRun: {
        findFirst: jest.fn(async ({ where }) => {
          // Real Prisma would filter by tenantId — we simulate that here
          if (where.tenantId !== 'tenant_B') return null;
          return tenantBRun;
        }),
      },
    });

    const result = await findExistingRun(prisma, 'tenant_A', tenantBRun.id, 1, 2026);
    expect(result).toBeNull(); // tenant_A cannot see tenant_B's run
  });
});

// ─── HIGH-03: lockRun — tenantId isolation ────────────────────────────────────

describe('HIGH-03 — lockRun uses updateMany with tenantId', () => {
  test('uses updateMany (not update) with tenantId in where clause', async () => {
    const prisma = makePrismaMock();
    await lockRun(prisma, 'tenant_A', 'run_001', 'user_001');

    expect(prisma.payrollRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id:       'run_001',
          tenantId: 'tenant_A',
        }),
      })
    );
    // Must NOT use prisma.payrollRun.update (which has no tenantId guard)
    expect(prisma.payrollRun.update).not.toHaveBeenCalled();
  });

  test('throws RUN_NOT_FOUND_OR_LOCKED when count === 0 (cross-tenant attempt)', async () => {
    const prisma = makePrismaMock({
      payrollRun: {
        updateMany: jest.fn(async () => ({ count: 0 })), // foreign runId
        update:     jest.fn(),
      },
    });

    await expect(lockRun(prisma, 'tenant_A', 'run_from_tenant_B', 'user_A'))
      .rejects.toMatchObject({ code: 'RUN_NOT_FOUND_OR_LOCKED' });
  });

  test('throws when tenantId is missing', async () => {
    const prisma = makePrismaMock();
    await expect(lockRun(prisma, undefined, 'run_001', 'user_001'))
      .rejects.toThrow(/tenantId is required/);
  });
});

// ─── HIGH-05: getTenderForPayroll — tenantId isolation ────────────────────────

describe('HIGH-05 — getTenderForPayroll includes tenantId filter', () => {
  test('includes tenantId in the where clause', async () => {
    const prisma = makePrismaMock();
    await getTenderForPayroll(prisma, 'tenant_A', 'tender_001');

    expect(prisma.tender.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id:       'tender_001',
          tenantId: 'tenant_A',
        }),
      })
    );
  });

  test('tenant_A cannot load tenant_B tender — returns null', async () => {
    const tenantBTender = { id: 'tender_B', tenantId: 'tenant_B' };
    const prisma = makePrismaMock({
      tender: {
        findFirst: jest.fn(async ({ where }) => {
          if (where.tenantId !== 'tenant_B') return null;
          return tenantBTender;
        }),
      },
    });

    const result = await getTenderForPayroll(prisma, 'tenant_A', 'tender_B');
    expect(result).toBeNull();
  });

  test('throws when tenantId is omitted', async () => {
    const prisma = makePrismaMock();
    await expect(getTenderForPayroll(prisma, undefined, 'tender_001'))
      .rejects.toThrow(/tenantId is required/);
  });
});

// ─── MED-01: createRunWithRows — loan updates inside transaction ───────────────

describe('MED-01 — loan balance updates inside transaction', () => {
  test('passes loan updates into the $transaction callback', async () => {
    const loanUpdates = [
      { loanId: 'loan_001', newBalance: 45000, newRemainingEmi: 9 },
    ];

    const txUpdateFn = jest.fn(async () => ({}));
    const prisma = makePrismaMock({
      $transaction: jest.fn(async (fn) => {
        return fn({
          payrollRun:   { create: jest.fn(async () => ({ id: 'run_tx' })) },
          payrollRow:   { createMany: jest.fn(async () => ({})) },
          employeeLoan: { update: txUpdateFn },
        });
      }),
    });

    await createRunWithRows(prisma, 'tenant_A', { tenderId: 't1', month: 1, year: 2026 }, [], loanUpdates);

    // Loan update must be called INSIDE the transaction
    expect(txUpdateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'loan_001' }),
        data:  expect.objectContaining({ remainingBalance: 45000 }),
      })
    );
  });

  test('zero loan updates — no loan DB calls made', async () => {
    const txUpdateFn = jest.fn(async () => ({}));
    const prisma = makePrismaMock({
      $transaction: jest.fn(async (fn) => {
        return fn({
          payrollRun:   { create: jest.fn(async () => ({ id: 'run_tx' })) },
          payrollRow:   { createMany: jest.fn(async () => ({})) },
          employeeLoan: { update: txUpdateFn },
        });
      }),
    });

    await createRunWithRows(prisma, 'tenant_A', {}, [], []);
    expect(txUpdateFn).not.toHaveBeenCalled();
  });
});

// ─── HIGH-06: Razorpay webhook signature verification ─────────────────────────

describe('HIGH-06 — Razorpay webhook signature verification', () => {
  const WEBHOOK_SECRET = 'test_webhook_secret_abc123xyz';

  function makeSignedRequest(body, secret = WEBHOOK_SECRET) {
    const rawBody  = Buffer.from(JSON.stringify(body));
    const sig      = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return {
      headers: { 'x-razorpay-signature': sig },
      rawBody,
      body,
      ip:   '1.2.3.4',
      path: '/api/subscription/webhook',
      get:  (h) => h === 'user-agent' ? 'test-agent' : undefined,
    };
  }

  beforeEach(() => {
    _resetForTest();
    initWebhookVerification(WEBHOOK_SECRET);
  });
  afterEach(() => _resetForTest());

  test('calls next() for valid signature', () => {
    const req  = makeSignedRequest({ event: 'subscription.activated' });
    const res  = { status: jest.fn(() => res), json: jest.fn() };
    const next = jest.fn();

    verifyRazorpayWebhook(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('returns 400 for wrong signature — spoofed event rejected', () => {
    const req = makeSignedRequest({ event: 'subscription.activated' }, 'wrong_secret');
    const res = { status: jest.fn(() => res), json: jest.fn() };
    const next = jest.fn();

    verifyRazorpayWebhook(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 400 when signature header is missing', () => {
    const req  = { headers: {}, rawBody: Buffer.from('{}'), body: {} };
    const res  = { status: jest.fn(() => res), json: jest.fn() };
    const next = jest.fn();

    verifyRazorpayWebhook(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 400 when rawBody is absent (no captureRawBody middleware)', () => {
    const req  = { headers: { 'x-razorpay-signature': 'abc' }, body: {} };
    const res  = { status: jest.fn(() => res), json: jest.fn() };
    const next = jest.fn();

    verifyRazorpayWebhook(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('initWebhookVerification throws when secret is empty', () => {
    _resetForTest();
    expect(() => initWebhookVerification('')).toThrow(/HIGH-06/);
    expect(() => initWebhookVerification(undefined)).toThrow(/HIGH-06/);
  });

  test('spoofed free-upgrade payload is rejected', () => {
    // Reproduce the exact attack from the audit report
    const spoofedPayload = {
      event: 'subscription.activated',
      payload: { subscription: { entity: { id: 'sub_fake', status: 'active' } } },
    };
    // Signed with WRONG secret (attacker doesn't know the real one)
    const req = makeSignedRequest(spoofedPayload, 'attacker_guessed_secret');
    const res = { status: jest.fn(() => res), json: jest.fn() };
    const next = jest.fn();

    verifyRazorpayWebhook(req, res, next);
    expect(next).not.toHaveBeenCalled();  // spoofed event blocked
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('parseWebhookPayload extracts subscription details', () => {
    const body = {
      event: 'subscription.activated',
      payload: {
        subscription: {
          entity: { id: 'sub_real_123', status: 'active', plan_id: 'plan_biz' }
        }
      }
    };
    const parsed = parseWebhookPayload(body);
    expect(parsed.event).toBe('subscription.activated');
    expect(parsed.subscriptionId).toBe('sub_real_123');
    expect(parsed.status).toBe('active');
  });

  test('parseWebhookPayload throws on malformed payload', () => {
    expect(() => parseWebhookPayload({})).toThrow(/missing "event"/);
    expect(() => parseWebhookPayload({ event: 'test' })).toThrow(/missing subscription/);
  });
});

// ─── HIGH-01: Impersonation audit logging ────────────────────────────────────

describe('HIGH-01 — Impersonation flag sets req.auditActors correctly', () => {
  const { protect } = require('../../src/middleware/auth');
  const jwt = require('jsonwebtoken');

  const FAKE_SECRET = 'testsecret'.repeat(4);

  beforeEach(() => { process.env.JWT_SECRET = FAKE_SECRET; });
  afterEach(() => { delete process.env.JWT_SECRET; });

  function makeToken(payload) {
    return jwt.sign(payload, FAKE_SECRET, { expiresIn: '1h' });
  }

  async function runMiddleware(token, getUserById) {
    const middleware = await protect(getUserById);
    const req  = { headers: { authorization: `Bearer ${token}` } };
    const res  = { status: jest.fn(() => res), json: jest.fn() };
    const next = jest.fn();
    await middleware(req, res, next);
    return { req, res, next };
  }

  test('sets req.isImpersonation=false for normal token', async () => {
    const token = makeToken({ userId: 'user_1' });
    const getUserById = jest.fn(async () => ({ id: 'user_1', role: 'COMPANY_ADMIN', tenantId: 't1', isActive: true }));

    const { req, next } = await runMiddleware(token, getUserById);
    expect(next).toHaveBeenCalled();
    expect(req.isImpersonation).toBe(false);
    expect(req.impersonatedBy).toBeNull();
    expect(req.auditActors.actorId).toBe('user_1');
  });

  test('sets req.impersonatedBy and req.auditActors correctly during impersonation', async () => {
    const token = makeToken({
      userId:          'company_admin_1',
      isImpersonation: true,
      impersonatedBy:  'super_admin_1',
    });

    const getUserById = jest.fn(async (id) => {
      if (id === 'company_admin_1') return { id: 'company_admin_1', role: 'COMPANY_ADMIN', tenantId: 't1', isActive: true };
      if (id === 'super_admin_1')   return { id: 'super_admin_1', role: 'SUPER_ADMIN', isActive: true };
      return null;
    });

    const { req, next } = await runMiddleware(token, getUserById);
    expect(next).toHaveBeenCalled();

    // HIGH-01 fix: audit trail shows super_admin as the actor, not the victim
    expect(req.isImpersonation).toBe(true);
    expect(req.impersonatedBy.id).toBe('super_admin_1');
    expect(req.auditActors.actorId).toBe('super_admin_1');         // true actor
    expect(req.auditActors.impersonatingId).toBe('company_admin_1'); // victim
    expect(req.auditActors.isImpersonation).toBe(true);
  });

  test('rejects impersonation token with non-SUPER_ADMIN origin', async () => {
    const token = makeToken({
      userId:          'company_admin_1',
      isImpersonation: true,
      impersonatedBy:  'another_company_admin',  // not a super admin
    });

    const getUserById = jest.fn(async (id) => {
      if (id === 'company_admin_1')      return { id: 'company_admin_1', role: 'COMPANY_ADMIN', isActive: true };
      if (id === 'another_company_admin') return { id: 'another_company_admin', role: 'COMPANY_ADMIN', isActive: true };
      return null;
    });

    const { res, next } = await runMiddleware(token, getUserById);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('rejects impersonation token missing impersonatedBy field', async () => {
    const token = makeToken({ userId: 'u1', isImpersonation: true }); // no impersonatedBy
    const getUserById = jest.fn(async () => ({ id: 'u1', role: 'COMPANY_ADMIN', isActive: true }));

    const { res, next } = await runMiddleware(token, getUserById);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
