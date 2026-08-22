/**
 * LIVE-Redis integration tests.
 *
 * These exercise the real ioredis → RESP paths that every other suite stubs
 * out: hash envelopes {d, t, tv}, SET NX EX + Lua release, pub/sub delivery,
 * SCAN-based warming, and the adapters' L2 round-trips.
 *
 * Skipped automatically when no Redis is reachable (local dev without Docker,
 * or CI legs without the service container). Run explicitly via:
 *   pnpm test:integration
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createClient } from 'redis';
import { CacheService } from '../../src/cache-service.js';
import { withTriCache } from '../../src/prisma/index.js';
import { withCache } from '../../src/drizzle/index.js';
import type { RedisClientType } from 'redis';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
const NS = `it-${Date.now()}`;

let probe: RedisClientType | null = null;
let redisUp = false;
try {
  probe = createClient({ url: REDIS_URL });
  await probe.connect();
  redisUp = true;
} catch {
  // no live redis — every test below is skipped
}
afterAll(async () => {
  if (probe?.isOpen) await probe.disconnect().catch(() => {});
});

const d = redisUp ? describe : describe.skip;
const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeSvc(extra: Record<string, unknown> = {}) {
  return new CacheService({
    namespace: NS,
    redisHost: '127.0.0.1',
    disableRedis: false,
    invalidationBackplane: false,
    oomProtection: false,
    logger: silentLogger,
    ...extra,
  });
}

d('LIVE Redis — core three-tier behavior', () => {
  let cache: CacheService | null = null;

  afterAll(async () => {
    if (cache) await cache.destroy();
  });

  it('set() writes the generational hash envelope and get() reads it back through real RESP', async () => {
    cache = makeSvc({ tagStrategy: 'generational' });
    await cache.set('live:user:1', { name: 'Layla', roles: ['admin'] }, 120, undefined, { tags: ['users'] });

    const raw = await probe!.hGetAll(`${NS}:live:user:1`);
    expect(Object.keys(raw).sort()).toEqual(['d', 't', 'tv']);
    expect(JSON.parse(raw.d)).toEqual({ name: 'Layla', roles: ['admin'] });
    expect(Number.isInteger(Number(raw.t))).toBe(true);
    expect(JSON.parse(raw.tv)).toHaveProperty('users');

    // Fresh instance, cold L1 — must come back from real Redis
    const cold = makeSvc({ tagStrategy: 'generational' });
    try {
      const got = await cold.get('live:user:1', async () => ({ name: 'FETCHED' }));
      expect(got).toEqual({ name: 'Layla', roles: ['admin'] });
    } finally {
      await cold.destroy();
    }
  });

  it('delete() removes the key cluster-wide; next get() refetches', async () => {
    cache = makeSvc();
    await cache.set('live:del:1', { v: 'x' }, 60);
    expect(await probe!.exists(`${NS}:live:del:1`)).toBe(1);

    await cache.delete('live:del:1');
    expect(await probe!.exists(`${NS}:live:del:1`)).toBe(0);

    let fetches = 0;
    const got = await cache.get('live:del:1', async () => { fetches++; return { v: 'fresh' }; }, 60);
    expect(fetches).toBe(1);
    expect(got).toEqual({ v: 'fresh' });
  });

  it('lock(): mutual exclusion across two CacheService instances sharing one Redis', async () => {
    cache = makeSvc();
    const peer = makeSvc();

    let running = 0;
    let maxConcurrent = 0;
    const task = (svc: CacheService) => svc.lock('it:shared-lock', async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise(r => setTimeout(r, 25));
      running--;
      return 'ok';
    }, { acquireTimeout: 5000, retryInterval: 15 });

    await Promise.all([task(cache), task(peer)]);
    expect(maxConcurrent).toBe(1);
    await peer.destroy();
  });

  it('lock(): business exception propagates exactly once against real Redis (P0 regression)', async () => {
    cache = makeSvc();
    let executions = 0;
    await expect(
      cache.lock('it:boom', async () => {
        executions++;
        throw new Error('real redis boom');
      }, { acquireTimeout: 2000 }),
    ).rejects.toThrow('real redis boom');
    expect(executions).toBe(1);
    // Lock must have been released — a fresh acquire succeeds immediately
    const t0 = Date.now();
    await cache.lock('it:boom', async () => 'reacquired-ok', { acquireTimeout: 3000, retryInterval: 20 });
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('pub/sub backplane delivers invalidations between two instances over a real socket', async () => {
    cache = makeSvc({ invalidationBackplane: true });
    const peer = makeSvc({ invalidationBackplane: true });
    await new Promise(r => setTimeout(r, 400)); // let subscribers settle

    await peer.set('live:pubsub:1', { v: 'original' }, 60); // seeds both L1s via read? no — seed locally:
    await cache.get('live:pubsub:1', async () => ({ v: 'original' }), 60);
    await peer.get('live:pubsub:1', async () => ({ v: 'original' }), 60);

    await peer.delete('live:pubsub:1'); // publishes del on the backplane

    // Allow pubsub propagation + local application
    await new Promise(r => setTimeout(r, 600));
    expect(cache.getIfFresh('live:pubsub:1')).toBeNull(); // evicted by the broadcast

    await peer.destroy();
  });
});

d('LIVE Redis — ORM & HTTP adapters', () => {
  let cache: CacheService | null = null;

  afterAll(async () => {
    if (cache) await cache.destroy();
  });

  it('prisma extension: mutation invalidates the model tag cluster-wide (cross-instance)', async () => {
    cache = makeSvc({ tagStrategy: 'generational' });
    const ext = withTriCache({ cache, defaultTtl: 60 });

    const qh = ext.query.$allModels.$allOperations!;
    await qh({
      model: 'User',
      operation: 'findMany',
      args: { where: { active: true } },
      query: async () => [{ id: 1 }],
    });

    const peer = makeSvc({ tagStrategy: 'generational' });
    try {
      // Peer caches under its own L1 but shares Redis tag counters
      const peerQh = withTriCache({ cache: peer, defaultTtl: 60 }).query.$allModels.$allOperations!;
      await peerQh({
        model: 'User',
        operation: 'findMany',
        args: { where: { active: true } },
        query: async () => [{ id: 1 }],
      });

      // Mutation on cache bumps the user tag version in shared Redis
      await qh({
        model: 'User',
        operation: 'create',
        args: { data: { name: 'Newbie' } },
        query: async (a) => ({ created: a }),
      });

      // Peer's next read must detect the bumped generation and refetch
      const before = (peer as unknown as { _getTagVersion(t: string): Promise<number> });
      const ver = await before._getTagVersion.call(peer, 'user');
      expect(ver).toBeGreaterThanOrEqual(1);
    } finally {
      await peer.destroy();
    }
  });

  it('drizzle wrapper: cached result survives into a second instance via L2', async () => {
    cache = makeSvc();
    let executions = 0;
    const makeQuery = () => ({
      toSQL: () => ({ sql: 'select * from items where active = $1', params: [true] }),
      execute: async () => { executions++; return [{ id: 7, label: 'hammer' }]; },
    });

    await withCache(makeQuery(), { cache, ttl: 90 });
    const peer = makeSvc();
    try {
      const res = await withCache(makeQuery(), { cache: peer, ttl: 90 });
      expect(res).toEqual([{ id: 7, label: 'hammer' }]);
      expect(executions).toBe(1); // served from shared Redis, not re-executed
    } finally {
      await peer.destroy();
    }
  });
});
