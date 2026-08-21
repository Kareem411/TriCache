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
});

