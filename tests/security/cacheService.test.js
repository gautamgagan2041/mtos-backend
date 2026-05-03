'use strict';

const {
  scanKeys, withLock, acquireLock, releaseLock,
  LockTakenError, LockServiceError,
  invalidatePtConfig, get, set, del,
  _setClientForTest, _clearClientForTest,
  KEY,
} = require('../../src/cache/cacheService');

// ─── Mock Redis client factory ────────────────────────────────────────────────

function makeMockRedis(overrides = {}) {
  const store = new Map();
  return {
    scan: jest.fn(async (cursor, _match, pattern, _count, count) => {
      // Simple mock: return all matching keys in one call, then cursor=0
      if (cursor !== '0') return ['0', []];
      const all = [...store.keys()].filter(k => {
        const pat = pattern.replace(/\*/g, '.*');
        return new RegExp('^' + pat + '$').test(k);
      });
      return ['0', all];
    }),
    get:    jest.fn(async (key) => store.get(key) ?? null),
    setex:  jest.fn(async (key, _ttl, val) => { store.set(key, val); return 'OK'; }),
    del:    jest.fn(async (key) => { store.delete(key); return 1; }),
    set:    jest.fn(async (key, val, nx, ex, ttl) => {
      if (nx === 'NX' && store.has(key)) return null;
      store.set(key, val);
      return 'OK';
    }),
    eval:   jest.fn(async (_script, _numKeys, key, owner) => {
      if (store.get(key) === owner) { store.delete(key); return 1; }
      return 0;
    }),
    pipeline: jest.fn(() => ({
      del:  jest.fn(),
      exec: jest.fn(async () => [[null, 1]]),
    })),
    call: jest.fn(),
    ...overrides,
  };
}

beforeEach(() => _clearClientForTest());
afterEach(() => _clearClientForTest());

// ─── CRIT-05: SCAN not KEYS ───────────────────────────────────────────────────

describe('CRIT-05 — scanKeys uses SCAN cursor, never KEYS', () => {
  test('scanKeys calls redis.scan, never redis.keys', async () => {
    const mock = makeMockRedis();
    mock.keys = jest.fn(); // should NEVER be called
    _setClientForTest(mock);

    await scanKeys('pt:config:tenant1:*');

    expect(mock.scan).toHaveBeenCalled();
    expect(mock.keys).not.toHaveBeenCalled();
  });

  test('scanKeys iterates until cursor returns 0', async () => {
    // Simulate a two-page result
    const mock = makeMockRedis();
    let callCount = 0;
    mock.scan = jest.fn(async (cursor) => {
      callCount++;
      if (cursor === '0')  return ['42', ['key:1', 'key:2']];
      if (cursor === '42') return ['0',  ['key:3']];
      return ['0', []];
    });
    _setClientForTest(mock);

    const keys = await scanKeys('key:*');
    expect(keys).toEqual(['key:1', 'key:2', 'key:3']);
    expect(callCount).toBe(2);
  });

  test('scanKeys returns empty array when no keys match', async () => {
    _setClientForTest(makeMockRedis());
    const keys = await scanKeys('nonexistent:*');
    expect(keys).toHaveLength(0);
  });
});

// ─── HIGH-04: Typed lock errors ───────────────────────────────────────────────

describe('HIGH-04 — acquireLock throws typed errors', () => {
  test('acquireLock returns true when lock is obtained', async () => {
    _setClientForTest(makeMockRedis());
    const result = await acquireLock('lock:payroll:t1:tender1:1:2026');
    expect(result).toBe(true);
  });

  test('acquireLock throws LockTakenError when key already exists', async () => {
    const mock = makeMockRedis();
    // SET NX returns null when key exists
    mock.set = jest.fn(async () => null);
    _setClientForTest(mock);

    await expect(acquireLock('lock:test'))
      .rejects.toThrow(LockTakenError);
    await expect(acquireLock('lock:test'))
      .rejects.toMatchObject({ code: 'LOCK_TAKEN' });
  });

  test('acquireLock throws LockServiceError when Redis is unavailable', async () => {
    const mock = makeMockRedis();
    mock.set = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
    _setClientForTest(mock);

    await expect(acquireLock('lock:test'))
      .rejects.toThrow(LockServiceError);
    await expect(acquireLock('lock:test'))
      .rejects.toMatchObject({ code: 'LOCK_SERVICE_UNAVAILABLE' });
  });

  test('LockTakenError and LockServiceError are distinguishable by code', async () => {
    const taken   = new LockTakenError('k');
    const svcErr  = new LockServiceError('k', new Error('down'));
    expect(taken.code).toBe('LOCK_TAKEN');
    expect(svcErr.code).toBe('LOCK_SERVICE_UNAVAILABLE');
    expect(taken.code).not.toBe(svcErr.code);  // HIGH-04: the key distinction
  });
});

// ─── withLock correctness ─────────────────────────────────────────────────────

describe('withLock()', () => {
  test('executes fn() and releases lock on success', async () => {
    const mock = makeMockRedis();
    _setClientForTest(mock);

    let executed = false;
    await withLock('lock:test', async () => { executed = true; });

    expect(executed).toBe(true);
    expect(mock.eval).toHaveBeenCalled(); // releaseLock called
  });

  test('releases lock even when fn() throws', async () => {
    const mock = makeMockRedis();
    _setClientForTest(mock);

    await expect(
      withLock('lock:test', async () => { throw new Error('business error'); })
    ).rejects.toThrow('business error');

    expect(mock.eval).toHaveBeenCalled(); // lock was released in finally
  });

  test('propagates LockTakenError when lock is already held', async () => {
    const mock = makeMockRedis();
    mock.set = jest.fn(async () => null); // always taken
    _setClientForTest(mock);

    await expect(withLock('lock:test', async () => {}))
      .rejects.toThrow(LockTakenError);
  });
});

// ─── MED-04: PT cache invalidation ───────────────────────────────────────────

describe('MED-04 — PT config cache invalidation', () => {
  test('invalidatePtConfig deletes the correct cache key', async () => {
    const mock = makeMockRedis();
    _setClientForTest(mock);

    await invalidatePtConfig('tenant123', 'KARNATAKA');

    // Should call del with the correct key
    expect(mock.del).toHaveBeenCalledWith(KEY.ptConfig('tenant123', 'KARNATAKA'));
  });

  test('get returns null after invalidation', async () => {
    const mock = makeMockRedis();
    _setClientForTest(mock);

    const key = KEY.ptConfig('tenant1', 'MAHARASHTRA');
    await set(key, [{ minWage: 0, maxWage: 10000, monthlyPT: 175 }], 3600);
    expect(await get(key)).not.toBeNull();

    await invalidatePtConfig('tenant1', 'MAHARASHTRA');
    expect(await get(key)).toBeNull();
  });
});
