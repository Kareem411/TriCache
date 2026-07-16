/**
 * Tests for the production-audit fixes (P0/P1).
 *
 * Redis is disabled by default in these tests (NODE_ENV = test), so the
 * L2/disk fallback paths in mget() are exercised with Redis disabled or via
 * the disk tier, and increment() fail-open / fail-closed behaviour is tested
 * through error injection on the L2 path where relevant.
 */
import { describe, it, expect, vi } from 'vitest';
import { CacheService } from '../src/cache-service';
import { CachePriority } from '../src/types';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';

function tempDir() {
  return join(tmpdir(), `tricache-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeSvc(extra: Record<string, unknown> = {}) {
  const diskDir = tempDir();
  const svc = CacheService.reset({
    disableRedis: true,
    l1MaxBytes: 20 * 1024 * 1024,
    l1MaxEntries: 500,
    diskCacheDir: diskDir,
    ...extra,
  });
  return { svc, diskDir };
}

describe('P0b — create() singleton divergence detection', () => {
  it('warns (does not throw) on a second create() with divergent options by default', () => {
    const diskDir = tempDir();
    const warn = vi.fn();
    const logger = { debug: () => {}, info: () => {}, warn, error: () => {} };
    CacheService.reset({ namespace: 'shop', redisHost: 'a.redis', logger, diskCacheDir: diskDir });
    CacheService.create({ namespace: 'shop', redisHost: 'b.redis', logger, diskCacheDir: diskDir });
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain('singleton already initialised');
    expect(msg).toContain('redisHost');
    const m = CacheService.create({ namespace: 'shop', logger, diskCacheDir: diskDir });
    expect(m.metrics().counters.singletonDivergences).toBeGreaterThanOrEqual(1);
  });

  it('throws when strictSingleton is enabled and options diverge', () => {
    const diskDir = tempDir();
    const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    // The EXISTING singleton must carry strictSingleton: true — the flag is
    // read from the live instance, not the diverging call. reset() ensures a
    // clean singleton (also clears any 'shop' left by the prior test).
    CacheService.reset({ namespace: 'shop', redisHost: 'a.redis', strictSingleton: true, logger, diskCacheDir: diskDir });
    expect(() =>
      CacheService.create({ namespace: 'shop', redisHost: 'b.redis', logger, diskCacheDir: diskDir }),
    ).toThrow(/strictSingleton/);
  });

  it('does NOT flag when the second create() passes no divergent options', () => {
    const diskDir = tempDir();
    const warn = vi.fn();
    const logger = { debug: () => {}, info: () => {}, warn, error: () => {} };
    CacheService.reset({ namespace: 'shop', redisHost: 'a.redis', logger, diskCacheDir: diskDir });
    CacheService.create({ namespace: 'shop', logger, diskCacheDir: diskDir });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('P0a — increment() fail-open is observable; failClosed re-throws', () => {
  it('with Redis disabled, returns accumulating local count (1,2,3) and bumps no counterErrors', async () => {
    const { svc } = makeSvc();
    expect(await svc.increment('hits', 60)).toBe(1);
    expect(await svc.increment('hits', 60)).toBe(2);
    expect(await svc.increment('hits', 60)).toBe(3);
    expect(svc.metrics().counters.errors).toBe(0);
  });

  it('warns once when falling back to the in-process counter (Redis disabled)', async () => {
    const { svc } = makeSvc();
    const warn = vi.fn();
    (svc as unknown as { logger: { debug: () => void; info: () => void; warn: () => void; error: () => void } })
      .logger = { debug: () => {}, info: () => {}, warn, error: () => {} };
    await svc.increment('hits', 60);
    await svc.increment('hits', 60);
    expect(warn).toHaveBeenCalledTimes(1);
    expect((warn.mock.calls[0][0] as string).toLowerCase()).toContain('not fleet-wide');
  });

  it('failClosed re-throws the underlying Redis error instead of returning 0', async () => {
    const diskDir = tempDir();
    // disableRedis:false forces Redis-enabled mode (test env would auto-disable
    // it); redisPort 1 is unreachable so getRedis() rejects -> increment throws.
    const svc = CacheService.reset({ redisHost: '127.0.0.1', redisPort: 1, disableRedis: false, failClosed: true, diskCacheDir: diskDir });
    await expect(svc.increment('hits', 60)).rejects.toBeDefined();
    expect(svc.metrics().counters.errors).toBeGreaterThanOrEqual(1);
  });
});

describe('P1b — set() infers priority from the bare key, not the namespaced key', () => {
  it('a namespace whose prefix matches a priority substring does not leak into priority inference', async () => {
    // namespace 'auth' would, if un-namespaced inference were broken, make every
    // key appear to contain 'auth:' and become CRITICAL. With a bare key that has
    // NO priority substring, the inferred priority must stay NORMAL.
    const { svc } = makeSvc({ namespace: 'auth' });
    await svc.set('widgets:1', { id: 1 }, 60);
    const k = svc['nk']('widgets:1');
    const entry = svc['l1'].getEntry(k);
    expect(entry?.priority).toBe(CachePriority.NORMAL);
  });
});

describe('P1c — L2 circuit breaker caps HALF_OPEN to a single probe', () => {
  it('only the first isAllowed() in HALF_OPEN returns true; concurrent callers are rejected', () => {
    const svc = makeSvc().svc;
    const cb = svc['cb'] as {
      isAllowed(): boolean; onFailure(): void; onSuccess(): void;
      openedAt: number;
    };
    for (let i = 0; i < 5; i++) cb.onFailure();   // force OPEN
    cb.openedAt = Date.now() - 30_001;             // cooldown elapsed -> next call probes
    expect(cb.isAllowed()).toBe(true);   // first probe permitted
    expect(cb.isAllowed()).toBe(false);  // concurrent caller rejected
    expect(cb.isAllowed()).toBe(false);  // third rejected too
    cb.onSuccess();                       // probe resolves -> CLOSED
    expect(cb.isAllowed()).toBe(true);   // closed again -> allowed
  });
});

describe('P1a — mget() three-tier fallback (ordering + counters)', () => {
  it('preserves input order and counts exactly one L1 hit per cached key, one fetch for the rest', async () => {
    const { svc } = makeSvc();
    await svc.set('k1', 'v1', 60);
    await svc.set('k3', 'v3', 60);
    const fetch = vi.fn(async (miss: string[]) => {
      const out: Record<string, string> = {};
      for (const k of miss) out[k] = `fetched:${k}`;
      return out;
    });
    const res = await svc.mget(['k1', 'k2', 'k3', 'k4'], fetch, 60);
    expect(res).toEqual(['v1', 'fetched:k2', 'v3', 'fetched:k4']);
    expect(fetch).toHaveBeenCalledOnce();
    const m = svc.metrics();
    expect(m.gets.l1Hits).toBe(2);
    expect(m.gets.fetches).toBe(1);
    expect(m.gets.l2Hits).toBe(0);
    expect(m.gets.diskHits).toBe(0);
    expect(m.counters.errors).toBe(0);
  });

  it('does not double-count when all keys are L1 hits (no fetch, no l2/disk hits)', async () => {
    const { svc } = makeSvc();
    await svc.set('a', 'va', 60);
    await svc.set('b', 'vb', 60);
    await svc.set('c', 'vc', 60);
    const fetch = vi.fn(async (miss: string[]) => {
      const out: Record<string, string> = {};
      for (const k of miss) out[k] = `fetched:${k}`;
      return out;
    });
    const res = await svc.mget(['a', 'b', 'c'], fetch, 60);
    expect(res).toEqual(['va', 'vb', 'vc']);
    expect(fetch).not.toHaveBeenCalled();
    const m = svc.metrics();
    expect(m.gets.l1Hits).toBe(3);
    expect(m.gets.fetches).toBe(0);
    expect(m.gets.l2Hits).toBe(0);
    expect(m.gets.diskHits).toBe(0);
  });

  it('handles interleaved L1 hits + L2 hits + full misses without index corruption', async () => {
    // This is the sparse missIndexes case: positions 0 and 1 are L1 hits, so
    // missIndexes is [2, 3] (sparse) — exactly where the L2 branch must index by
    // j, not by idx, or it corrupts the parallel arrays. Redis is faked via a
    // mock so we exercise the real L2 code path deterministically.
    const { svc } = makeSvc({ disableRedis: false, redisHost: '127.0.0.1' });
    await svc.set('hit0', 'v0', 60);
    await svc.set('hit1', 'v1', 60);

    const fakeRaw = JSON.stringify('fromRedis');
    const fakeClient = {
      multi: () => {
        const c: any = {
          get(_k: string) { return this; },
          async exec() {
            // missKeys after L1 = ['miss2','miss3']; return a hit for miss2, null for miss3
            return [['', fakeRaw], [null, null]] as Array<[string, string | null]>;
          },
        };
        return c;
      },
    };
    svc['getRedis'] = (async () => fakeClient) as unknown as () => Promise<any>;

    const fetch = vi.fn(async (miss: string[]) => {
      const out: Record<string, string> = {};
      for (const k of miss) out[k] = `fetched:${k}`;
      return out;
    });
    const res = await svc.mget(['hit0', 'hit1', 'miss2', 'miss3'], fetch, 60);
    // hit0, hit1 from L1; miss2 from the faked L2; miss3 from fetchFn.
    expect(res).toEqual(['v0', 'v1', 'fromRedis', 'fetched:miss3']);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toEqual(['miss3']); // only the true miss
    const m = svc.metrics();
    expect(m.gets.l1Hits).toBe(2);
    expect(m.gets.l2Hits).toBe(1);
    expect(m.gets.fetches).toBe(1);
    expect(m.gets.diskHits).toBe(0);
  });
});
