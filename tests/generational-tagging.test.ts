import { describe, it, expect, afterEach, vi } from 'vitest';
import { CacheService } from '../src/cache-service';
import { SmartMemoryCache } from '../src/smart-memory-cache';
import { consoleLogger } from '../src/types';

describe('Generational Tag Invalidation (tagStrategy: generational)', () => {
  let svc: CacheService | null = null;

  afterEach(async () => {
    if (svc) {
      await svc.destroy();
      svc = null;
    }
  });

  it('detects staleness in L1 when tag version is incremented', async () => {
    svc = new CacheService({
      tagStrategy: 'generational',
      disableRedis: true,
      disableDisk: true,
    });

    let fetchCount = 0;
    const fetchUser = async () => {
      fetchCount++;
      return { id: 1, name: 'Alice' };
    };

    // Initial fetch -> caches in L1 with active tag version for 'users'
    const res1 = await svc.get('user:1', fetchUser, 60, { tags: ['users'] });
    expect(res1).toEqual({ id: 1, name: 'Alice' });
    expect(fetchCount).toBe(1);

    // Immediate hit
    const res2 = await svc.get('user:1', fetchUser, 60, { tags: ['users'] });
    expect(res2).toEqual({ id: 1, name: 'Alice' });
    expect(fetchCount).toBe(1);

    // Invalidate tag 'users'
    await svc.invalidateTag('users');

    // Next get() should detect generational staleness, trigger miss, and refetch
    const res3 = await svc.get('user:1', fetchUser, 60, { tags: ['users'] });
    expect(res3).toEqual({ id: 1, name: 'Alice' });
    expect(fetchCount).toBe(2);
  });

  it('invalidates multiple keys tagged with the same tag in O(1)', async () => {
    svc = new CacheService({
      tagStrategy: 'generational',
      disableRedis: true,
      disableDisk: true,
    });

    await svc.set('item:1', { name: 'Item 1' }, 60, undefined, { tags: ['catalog'] });
    await svc.set('item:2', { name: 'Item 2' }, 60, undefined, { tags: ['catalog'] });
    await svc.set('item:3', { name: 'Item 3' }, 60, undefined, { tags: ['other'] });

    expect(await svc.get('item:1', async () => ({ name: 'Fresh 1' }))).toEqual({ name: 'Item 1' });
    expect(await svc.get('item:2', async () => ({ name: 'Fresh 2' }))).toEqual({ name: 'Item 2' });
    expect(await svc.get('item:3', async () => ({ name: 'Fresh 3' }))).toEqual({ name: 'Item 3' });

    // Invalidate 'catalog' tag
    await svc.invalidateTag('catalog');

    // item:1 and item:2 are stale -> refetch
    expect(await svc.get('item:1', async () => ({ name: 'Fresh 1' }))).toEqual({ name: 'Fresh 1' });
    expect(await svc.get('item:2', async () => ({ name: 'Fresh 2' }))).toEqual({ name: 'Fresh 2' });
    // item:3 was tagged with 'other' -> remains fresh
    expect(await svc.get('item:3', async () => ({ name: 'Fresh 3' }))).toEqual({ name: 'Item 3' });
  });

  it('supports invalidateTags() in batch', async () => {
    svc = new CacheService({
      tagStrategy: 'generational',
      disableRedis: true,
      disableDisk: true,
    });

    await svc.set('a', 'valA', 60, undefined, { tags: ['t1'] });
    await svc.set('b', 'valB', 60, undefined, { tags: ['t2'] });
    await svc.set('c', 'valC', 60, undefined, { tags: ['t3'] });

    await svc.invalidateTags(['t1', 't2']);

    expect(await svc.get('a', async () => 'refreshedA')).toBe('refreshedA');
    expect(await svc.get('b', async () => 'refreshedB')).toBe('refreshedB');
    expect(await svc.get('c', async () => 'refreshedC')).toBe('valC');
  });

  it('reconciles tag version against Redis on missed broadcast after tagVersionTtlMs', async () => {
    // Mock Redis client to simulate a missed broadcast (where Redis tag counter is incremented directly)
    let redisCounter = 0;
    const redisStore = new Map<string, any>();

    const mockRedis = {
      get: vi.fn(async (key: string) => {
        if (key.includes('tag_ver:')) return String(redisCounter);
        return redisStore.get(key) ?? null;
      }),
      set: vi.fn(async () => 'OK'),
      setex: vi.fn(async (k: string, ttl: number, val: string) => { redisStore.set(k, val); return 'OK'; }),
      hgetall: vi.fn(async (k: string) => redisStore.get(k) ?? {}),
      hset: vi.fn(async (k: string, data: any) => { redisStore.set(k, data); return 1; }),
      multi: () => ({
        hset(k: string, data: any) { redisStore.set(k, data); return this; },
        expire() { return this; },
        async exec() { return [[null, 1], [null, 1]]; },
      }),
      incr: vi.fn(async () => ++redisCounter),
      eval: vi.fn(async () => 1),
      publish: vi.fn(async () => 1),
      subscribe: vi.fn(async () => 'OK'),
      disconnect: vi.fn(async () => {}),
      on: vi.fn(),
      status: 'ready',
    };

    svc = new CacheService({
      tagStrategy: 'generational',
      tagVersionTtlMs: 50, // Short 50ms TTL for testing reconciliation
      disableRedis: false,
      disableDisk: true,
      invalidationBackplane: false, // Disable backplane to simulate dropped broadcast
    });

    // Inject mock Redis
    (svc as any).redis = mockRedis;
    (svc as any)._redisDisabled = false;

    let fetchCount = 0;
    const fetchFn = async () => {
      fetchCount++;
      return { count: fetchCount };
    };

    // 1. Initial write under version 0
    const res1 = await svc.get('doc:1', fetchFn, 60, { tags: ['docs'] });
    expect(res1).toEqual({ count: 1 });

    // 2. Immediate hit (local tag is fresh within 50ms)
    const res2 = await svc.get('doc:1', fetchFn, 60, { tags: ['docs'] });
    expect(res2).toEqual({ count: 1 });

    // 3. Simulate another cluster node incrementing tag_ver:docs in Redis (missed broadcast)
    redisCounter = 5;

    // 4. Wait for local tagVersionTtlMs (50ms) to elapse
    await new Promise(resolve => setTimeout(resolve, 60));

    // 5. Read from this instance: time-based reconciliation fetches tag_ver:docs (5),
    // detects stored entry has version 0 (< 5), invalidates stale entry, and calls fetchFn
    const res3 = await svc.get('doc:1', fetchFn, 60, { tags: ['docs'] });
    expect(res3).toEqual({ count: 2 });
  });

  it('deleteIfSetBefore only deletes entries older than cutoff timestamp', () => {
    const l1 = new SmartMemoryCache({
      maxBytes: 10 * 1024 * 1024,
      maxEntries: 100,
      categories: { default: { maxEntries: 100, maxSizeBytes: 10 * 1024 * 1024 } },
      logger: consoleLogger,
    });

    const t0 = Date.now();
    l1.set('key1', 'v1', 60_000);

    // Cutoff before t0 -> should NOT delete
    const deletedBefore = l1.deleteIfSetBefore('key1', t0 - 1000);
    expect(deletedBefore).toBe(false);
    expect(l1.get('key1')?.value).toBe('v1');

    // Cutoff after t0 -> SHOULD delete
    const deletedAfter = l1.deleteIfSetBefore('key1', t0 + 1000);
    expect(deletedAfter).toBe(true);
    expect(l1.get('key1')).toBeNull();
  });

  it('rejects stale generational entries resurrected from L1.5 disk spill', async () => {
    const cache = new CacheService({
      namespace: `disk-gen-test-${Date.now()}`,
      tagStrategy: 'generational',
      l1MaxEntries: 1, // Force immediate eviction to disk
      disableRedis: true,
      disableDisk: false,
    });

    // 1. Write Entry A with tag 'products'
    await cache.set('item:1', { name: 'Keyboard v1' }, 300, undefined, { tags: ['products'] });

    // 2. Write Entry B to evict Entry A from L1 RAM into L1.5 Disk Tier
    await cache.set('item:2', { name: 'Mouse' }, 300);

    // Allow setImmediate disk spill to complete
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 3. Invalidate tag 'products' while Entry A resides on disk
    await cache.invalidateTag('products');

    // 4. Fetching Entry A must detect stale tag version and trigger fetchFn
    let fetchFnCalled = false;
    const result = await cache.get(
      'item:1',
      async () => {
        fetchFnCalled = true;
        return { name: 'Keyboard v2' };
      },
      300,
    );

    expect(fetchFnCalled).toBe(true);
    expect(result).toEqual({ name: 'Keyboard v2' });

    await cache.destroy();
  });

  it('peek() and mget() detect generational tag invalidation across L1, disk, and L2 Redis hashes', async () => {
    let redisVer = 0;
    const redisStore = new Map<string, any>();

    const mockRedis = {
      get: vi.fn(async (key: string) => {
        if (key.includes('tag_ver:')) return String(redisVer);
        const val = redisStore.get(key);
        if (val && typeof val === 'object') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        return val ?? null;
      }),
      set: vi.fn(async () => 'OK'),
      setex: vi.fn(async (k: string, _ttl: number, val: string) => { redisStore.set(k, val); return 'OK'; }),
      hgetall: vi.fn(async (k: string) => {
        const val = redisStore.get(k);
        if (typeof val === 'string') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        return val ?? {};
      }),
      hset: vi.fn(async (k: string, data: any) => { redisStore.set(k, data); return 1; }),
      multi: () => {
        const ops: Array<() => [Error | null, any]> = [];
        return {
          get(k: string) {
            ops.push(() => {
              const v = redisStore.get(k);
              if (v && typeof v === 'object') return [new Error('WRONGTYPE Operation against a key holding the wrong kind of value'), null];
              return [null, v ?? null];
            });
            return this;
          },
          hgetall(k: string) {
            ops.push(() => {
              const v = redisStore.get(k);
              if (typeof v === 'string') return [new Error('WRONGTYPE Operation against a key holding the wrong kind of value'), null];
              return [null, v ?? {}];
            });
            return this;
          },
          hset(k: string, data: any) { ops.push(() => { redisStore.set(k, data); return [null, 1]; }); return this; },
          expire() { ops.push(() => [null, 1]); return this; },
          async exec() { return ops.map(fn => fn()); },
        };
      },
      incr: vi.fn(async () => ++redisVer),
      eval: vi.fn(async () => 1),
      publish: vi.fn(async () => 1),
      subscribe: vi.fn(async () => 'OK'),
      disconnect: vi.fn(async () => {}),
      on: vi.fn(),
      status: 'ready',
    };

    svc = new CacheService({
      tagStrategy: 'generational',
      tagVersionTtlMs: 20,
      disableRedis: false,
      disableDisk: true,
      invalidationBackplane: false,
      compression: 'none',
    });
    (svc as any).redis = mockRedis;
    (svc as any)._redisDisabled = false;

    await svc.set('tagged:1', 'v1', 60, undefined, { tags: ['grp'] });
    await svc.set('plain:1', 'plain-v1', 60);
    // Simulate a legacy untagged string in Redis
    redisStore.set('legacy:1', JSON.stringify('legacy-v1'));

    expect(await svc.peek('tagged:1')).toBe('v1');
    expect(await svc.mget(['tagged:1', 'plain:1'])).toEqual(['v1', 'plain-v1']);

    // Evict L1 so peek/mget hit L2 Redis
    (svc as any).l1.clear();
    expect(await svc.peek('tagged:1')).toBe('v1');
    expect(await svc.peek('legacy:1')).toBe('legacy-v1');

    (svc as any).l1.clear();
    expect(await svc.mget(['tagged:1', 'legacy:1'])).toEqual(['v1', 'legacy-v1']);

    // Invalidate tag -> peek() returns null and mget() invokes fetchFn
    await svc.invalidateTag('grp');
    expect(await svc.peek('tagged:1')).toBeNull();

    let fetchedKeys: string[] = [];
    const mgetAfterInv = await svc.mget(['tagged:1', 'plain:1'], async (missKeys) => {
      fetchedKeys = missKeys;
      return { 'tagged:1': 'v2' };
    });
    expect(fetchedKeys).toEqual(['tagged:1']);
    expect(mgetAfterInv).toEqual(['v2', 'plain-v1']);
  });

  it('passes matching setAt timestamp to LUA_COMPARE_AND_DELETE even when async serialization takes >= 5ms', async () => {
    let redisVer = 0;
    const redisStore = new Map<string, any>();
    const evalCalls: Array<{ key: string; tsArg: string; storedTs: string | undefined }> = [];

    const mockRedis = {
      get: vi.fn(async (key: string) => (key.includes('tag_ver:') ? String(redisVer) : (redisStore.get(key) ?? null))),
      setex: vi.fn(async (k: string, _ttl: number, val: string) => { redisStore.set(k, val); return 'OK'; }),
      hgetall: vi.fn(async (k: string) => redisStore.get(k) ?? {}),
      multi: () => {
        const ops: Array<() => [Error | null, any]> = [];
        return {
          hset(k: string, data: any) { ops.push(() => { redisStore.set(k, data); return [null, 1]; }); return this; },
          expire() { ops.push(() => [null, 1]); return this; },
          async exec() { return ops.map(fn => fn()); },
        };
      },
      incr: vi.fn(async () => ++redisVer),
      eval: vi.fn(async (_script: string, _numKeys: number, key: string, tsArg: string) => {
        const storedTs = redisStore.get(key)?.t;
        evalCalls.push({ key, tsArg, storedTs });
        if (storedTs === tsArg) {
          redisStore.delete(key);
          return 1;
        }
        return 0;
      }),
      publish: vi.fn(async () => 1),
      disconnect: vi.fn(async () => {}),
    };

    svc = new CacheService({
      tagStrategy: 'generational',
      disableRedis: false,
      disableDisk: true,
      invalidationBackplane: false,
      compression: 'none',
    });
    (svc as any).redis = mockRedis;
    (svc as any)._redisDisabled = false;

    const origSerialize = (svc as any)._serializeAndEncrypt.bind(svc);
    (svc as any)._serializeAndEncrypt = async (s: string) => {
      await new Promise(r => setTimeout(r, 10)); // force >= 10ms gap
      return origSerialize(s);
    };

    await svc.set('ts:key', 'old', 60, undefined, { tags: ['ts-tag'] });
    await svc.invalidateTag('ts-tag');
    await svc.get('ts:key', async () => 'new', 60, { tags: ['ts-tag'] });

    expect(evalCalls.length).toBe(1);
    expect(evalCalls[0].tsArg).toBe(evalCalls[0].storedTs);
  });

  it('does not resurrect deleted key into L1 when delete() races with an in-flight L2 Redis read', async () => {
    const redisStore = new Map<string, string>();
    let releaseRedisGet: (() => void) | null = null;
    const getStarted = new Promise<void>(resolve => {
      const mockRedis = {
        get: vi.fn(async (k: string) => {
          resolve();
          await new Promise<void>(r => { releaseRedisGet = r; });
          return redisStore.get(k) ?? null;
        }),
        del: vi.fn(async (k: string) => { redisStore.delete(k); return 1; }),
        setex: vi.fn(async (k: string, _ttl: number, v: string) => { redisStore.set(k, v); return 'OK'; }),
        disconnect: vi.fn(async () => {}),
      };

      svc = new CacheService({
        disableRedis: false,
        disableDisk: true,
        invalidationBackplane: false,
        compression: 'none',
      });
      (svc as any).redis = mockRedis;
      (svc as any)._redisDisabled = false;
    });

    redisStore.set('race:key', JSON.stringify('stale-value'));

    const readPromise = svc!.get('race:key', async () => 'fresh', 60);
    await getStarted;

    // Delete happens while L2 Redis GET is still in flight
    await svc!.delete('race:key');
    releaseRedisGet!();

    await readPromise;
    expect(svc!.has('race:key')).toBe(false);
  });
});

