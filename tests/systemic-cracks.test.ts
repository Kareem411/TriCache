import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import { SmartCacheEntry } from '../src/types.js';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

function tempDir(): string {
  const d = path.join(os.tmpdir(), `tricache-crack-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function makeTestEntry(val: unknown, ttlMs = 60_000): SmartCacheEntry {
  const data = Buffer.from(JSON.stringify(val));
  return {
    value: val,
    data,
    isCompressed: false,
    expiresAt: Date.now() + ttlMs,
    size: data.byteLength,
    hits: 1,
    lastAccess: Date.now(),
    priority: 1,
  };
}

describe('Systemic Invariant & Crack Hardening Audit Tests', () => {
  let diskDir: string;

  beforeEach(() => {
    diskDir = tempDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(diskDir, { recursive: true, force: true });
    } catch { /* ok */ }
  });

  describe('Failure Path 1: SWR & SingleFlight Invalidation Resurrection Zombie', () => {
    it('aborts commit if key is deleted while fetchFn is in-flight (SingleFlight)', async () => {
      const cache = CacheService.reset({
        namespace: 'crack_sf_del',
        disableRedis: true,
        diskCacheDir: diskDir,
      });

      let resolveFetch!: (val: string) => void;
      const fetchPromise = new Promise<string>((resolve) => {
        resolveFetch = resolve;
      });

      // Start in-flight get
      const getPromise = cache.get('user:101', () => fetchPromise, 60);

      // Concurrent delete arrives while fetch is pending
      await cache.delete('user:101');

      // Now fetch finishes with stale data
      resolveFetch('old-user-data');
      const result = await getPromise;

      expect(result).toBe('old-user-data');
      // But the cache must NOT have committed it!
      expect(cache.has('user:101')).toBe(false);
      expect(cache.getIfFresh('user:101')).toBeNull();

      await cache.destroy();
    });

    it('aborts commit if key is updated via set() while fetchFn is in-flight (avoids mutation overwrite)', async () => {
      const cache = CacheService.reset({
        namespace: 'crack_sf_mutate',
        disableRedis: true,
        diskCacheDir: diskDir,
      });

      let resolveFetch!: (val: string) => void;
      const fetchPromise = new Promise<string>((resolve) => {
        resolveFetch = resolve;
      });

      const getPromise = cache.get('user:102', () => fetchPromise, 60);

      // Concurrent mutation arrives with newer value
      await cache.set('user:102', 'new-updated-data', 60);

      // Old fetch completes
      resolveFetch('stale-data-from-slow-query');
      await getPromise;

      // The cache must retain the newer mutated data, NOT the stale fetch result!
      expect(cache.getIfFresh('user:102')).toBe('new-updated-data');

      await cache.destroy();
    });

    it('aborts SWR revalidation commit if key is deleted while revalidation is in-flight', async () => {
      const cache = CacheService.reset({
        namespace: 'crack_swr_del',
        disableRedis: true,
        diskCacheDir: diskDir,
      });

      // Populate initial entry
      await cache.set('profile:1', 'initial-profile', 1);

      // Artificially age the entry into SWR grace period
      const nk = (cache as any).nk('profile:1');
      const entry = (cache as any).l1.getEntry(nk);
      if (entry) {
        entry.staleAt = Date.now() - 10;
        entry.expiresAt = Date.now() + 10_000;
      }

      let resolveRevalidate!: (val: string) => void;
      const revalidatePromise = new Promise<string>((resolve) => {
        resolveRevalidate = resolve;
      });

      // Trigger SWR background revalidation by calling get()
      const staleResult = await cache.get(
        'profile:1',
        () => revalidatePromise,
        60,
        { swr: 30 },
      );
      expect(staleResult).toBe('initial-profile');

      // Key is explicitly deleted during background revalidation
      await cache.delete('profile:1');
      expect(cache.has('profile:1')).toBe(false);

      // SWR fetch finishes
      resolveRevalidate('resurrected-profile');
      await new Promise(r => setTimeout(r, 50)); // allow background microtasks to finish

      // Key must NOT be resurrected by SWR!
      expect(cache.has('profile:1')).toBe(false);
      expect(cache.getIfFresh('profile:1')).toBeNull();

      await cache.destroy();
    });

    it('aborts SWR revalidation commit if generational tag version was bumped during revalidation', async () => {
      const cache = CacheService.reset({
        namespace: 'crack_swr_tag',
        disableRedis: true,
        diskCacheDir: diskDir,
        tagStrategy: 'generational',
      });

      await cache.set('product:99', 'initial-product', 1, undefined, { tags: ['catalog'] });

      // Age entry into SWR grace period
      const nk = (cache as any).nk('product:99');
      const entry = (cache as any).l1.getEntry(nk);
      if (entry) {
        entry.staleAt = Date.now() - 10;
        entry.expiresAt = Date.now() + 10_000;
      }

      let resolveRevalidate!: (val: string) => void;
      const revalidatePromise = new Promise<string>((resolve) => {
        resolveRevalidate = resolve;
      });

      await cache.get(
        'product:99',
        () => revalidatePromise,
        60,
        { swr: 30, tags: ['catalog'] },
      );

      // Tag is invalidated while revalidation fetch is in-flight!
      await cache.invalidateTag('catalog');

      // Now revalidation fetch finishes with old product state
      resolveRevalidate('stale-product-after-catalog-update');
      await new Promise(r => setTimeout(r, 50));

      // Key must not have been committed under the new tag version with stale data!
      // When get() is called, it must detect tag version mismatch and fetch fresh data:
      let freshFetched = false;
      const val = await cache.get('product:99', async () => {
        freshFetched = true;
        return 'fresh-product';
      }, 60);

      expect(freshFetched).toBe(true);
      expect(val).toBe('fresh-product');

      await cache.destroy();
    });
  });

  describe('Failure Path 2: Deferred Disk Unlink Inversion', () => {
    it('same-tick read immediately after delete does not load pending disk file into L1', async () => {
      const cache = CacheService.reset({
        namespace: 'crack_disk_defer',
        disableRedis: true,
        diskCacheDir: diskDir,
      });

      // Write directly to disk tier
      const k = (cache as any).nk('doc:file1');
      const testEntry = makeTestEntry({ title: 'important secret document' });
      (cache as any).disk.save(k, testEntry);

      // Also ensure it is in L1
      (cache as any).l1.set(k, testEntry.value, 60_000, 1);
      expect(cache.has('doc:file1')).toBe(true);

      // Delete the key — this unlinks from L1 and schedules setImmediate for disk unlink
      await cache.delete('doc:file1');

      // Immediately peek in the SAME event-loop tick before setImmediate fires:
      // Without pendingDiskDeletes guard, peek() would check disk, find the file, and resurrect it!
      const peeked = await cache.peek('doc:file1');
      expect(peeked).toBeNull();
      expect(cache.has('doc:file1')).toBe(false);

      // Same check with get() in the same tick:
      let fetchRan = false;
      const fetched = await cache.get('doc:file1', async () => {
        fetchRan = true;
        return { title: 'new freshly fetched doc' };
      });

      expect(fetchRan).toBe(true);
      expect(fetched).toEqual({ title: 'new freshly fetched doc' });

      await cache.destroy();
    });

    it('remote backplane del invalidation also marks pending disk delete', async () => {
      const cache = CacheService.reset({
        namespace: 'crack_remote_disk',
        disableRedis: true,
        diskCacheDir: diskDir,
      });

      const k = (cache as any).nk('remote:key1');
      const testEntry = makeTestEntry('remote-value');
      (cache as any).disk.save(k, testEntry);

      // Simulate remote backplane invalidation arrival
      cache._handleBackplaneMessage(JSON.stringify({
        op: 'del',
        key: k,
        src: 'other-node-42',
      }));

      // Immediately peek before setImmediate disk unlink runs
      const peeked = await cache.peek('remote:key1');
      expect(peeked).toBeNull();

      await cache.destroy();
    });
  });

  describe('Failure Path 3: LRU-Eviction Tag Stripping Trap during SWR', () => {
    it('retains generational tag versions when L1 entry is evicted during in-flight SWR fetch', async () => {
      const cache = CacheService.reset({
        namespace: 'crack_lru_tags',
        disableRedis: true,
        diskCacheDir: diskDir,
        tagStrategy: 'generational',
      });

      await cache.set('item:42', { name: 'Widget' }, 1, undefined, { tags: ['inventory'] });

      // Age into SWR grace period
      const nk = (cache as any).nk('item:42');
      const entry = (cache as any).l1.getEntry(nk);
      if (entry) {
        entry.staleAt = Date.now() - 10;
        entry.expiresAt = Date.now() + 10_000;
      }

      let resolveFetch!: (val: { name: string }) => void;
      const fetchPromise = new Promise<{ name: string }>((resolve) => {
        resolveFetch = resolve;
      });

      // Start SWR get
      await cache.get(
        'item:42',
        () => fetchPromise,
        60,
        { swr: 30, tags: ['inventory'] },
      );

      // Simulating extreme L1 memory churn while fetch is pending:
      // The L1 entry is evicted by LRU/OOM!
      (cache as any).l1.delete(nk);
      expect((cache as any).l1.get(nk)).toBeNull();

      // Now SWR fetch resolves
      resolveFetch({ name: 'Updated Widget' });
      await new Promise(r => setTimeout(r, 50));

      // The new entry must be in L1 AND MUST RETAIN the inventory tag versions!
      const revalidated = (cache as any).l1.get(nk);
      expect(revalidated).not.toBeNull();
      expect(revalidated.value).toEqual({ name: 'Updated Widget' });
      expect(revalidated.tagVersions).toBeDefined();
      expect(revalidated.tagVersions['inventory']).toBeDefined();

      // When the tag is invalidated, calling get() must detect generational staleness,
      // evict the entry, and trigger a fresh fetch:
      await cache.invalidateTag('inventory');

      let reFetchRan = false;
      const val = await cache.get('item:42', async () => {
        reFetchRan = true;
        return { name: 'Fresh Post-Invalidation Widget' };
      }, 60);

      expect(reFetchRan).toBe(true);
      expect(val).toEqual({ name: 'Fresh Post-Invalidation Widget' });

      await cache.destroy();
    });
  });

  describe('Failure Path 4: Destroyed Instance Zombie', () => {
    it('throws TriCacheError immediately on public methods after destroy()', async () => {
      const cache = CacheService.reset({
        namespace: 'crack_destroyed_guard',
        disableRedis: true,
        diskCacheDir: diskDir,
      });

      await cache.destroy();

      await expect(cache.get('k', async () => 'v')).rejects.toThrow(/destroyed CacheService instance/);
      await expect(cache.set('k', 'v')).rejects.toThrow(/destroyed CacheService instance/);
      await expect(cache.delete('k')).rejects.toThrow(/destroyed CacheService instance/);
      await expect(cache.increment('k')).rejects.toThrow(/destroyed CacheService instance/);
      await expect(cache.clear()).rejects.toThrow(/destroyed CacheService instance/);
      await expect(cache.peek('k')).rejects.toThrow(/destroyed CacheService instance/);
      await expect(cache.mget(['k'], async () => ({}))).rejects.toThrow(/destroyed CacheService instance/);
      await expect(cache.mset({ k: { value: 'v' } })).rejects.toThrow(/destroyed CacheService instance/);
      await expect(cache.mdel(['k'])).rejects.toThrow(/destroyed CacheService instance/);
      await expect(cache.invalidateTag('t')).rejects.toThrow(/destroyed CacheService instance/);
      await expect(cache.invalidateTags(['t'])).rejects.toThrow(/destroyed CacheService instance/);
      await expect(cache.setIfAbsent('k', 'v')).rejects.toThrow(/destroyed CacheService instance/);
      await expect(cache.lock('res', async () => 'ok')).rejects.toThrow(/destroyed CacheService instance/);
      await expect(cache.touch('k', 60)).rejects.toThrow(/destroyed CacheService instance/);
      await expect(cache.drainToL2()).rejects.toThrow(/destroyed CacheService instance/);
      await expect(cache.ping()).rejects.toThrow(/destroyed CacheService instance/);
      expect(() => cache.has('k')).toThrow(/destroyed CacheService instance/);
      expect(() => cache.ttl('k')).toThrow(/destroyed CacheService instance/);
      expect(() => cache.getIfFresh('k')).toThrow(/destroyed CacheService instance/);
      expect(() => cache.rebalance()).toThrow(/destroyed CacheService instance/);
      expect(() => [...cache.keys()]).toThrow(/destroyed CacheService instance/);
      expect(() => [...cache.values()]).toThrow(/destroyed CacheService instance/);
      expect(() => [...cache.entries()]).toThrow(/destroyed CacheService instance/);
      expect(() => cache.scan(() => {})).toThrow(/destroyed CacheService instance/);
    });
  });

  describe('Failure Path 5: Silent Backplane Invalidation Message Loss & Guaranteed Delivery Option', () => {
    it('propagates backplane publish errors when awaitInvalidationBackplane is true', async () => {
      const mockRedisClient = {
        publish: vi.fn().mockRejectedValue(new Error('Redis cluster connection severed')),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };

      const cache = CacheService.reset({
        namespace: 'crack_backplane_throw',
        disableRedis: false,
        invalidationBackplane: true,
        awaitInvalidationBackplane: true,
        redisClient: mockRedisClient as any,
        diskCacheDir: diskDir,
      });

      // set() should throw because backplane publish failed
      await expect(cache.set('key:sync', 'value')).rejects.toThrow('Redis cluster connection severed');

      // delete() should throw because backplane publish failed
      await expect(cache.delete('key:sync')).rejects.toThrow('Redis cluster connection severed');

      // clear() should throw because backplane publish failed
      await expect(cache.clear()).rejects.toThrow('Redis cluster connection severed');

      await cache.destroy();
    });

    it('swallows backplane publish errors and logs warning when awaitInvalidationBackplane is false (default)', async () => {
      const warnSpy = vi.fn();
      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: warnSpy,
        error: vi.fn(),
      };

      const mockRedisClient = {
        publish: vi.fn().mockRejectedValue(new Error('Redis connection timeout')),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };

      const cache = CacheService.reset({
        namespace: 'crack_backplane_default',
        disableRedis: false,
        invalidationBackplane: true,
        awaitInvalidationBackplane: false, // default fire-and-forget
        logger: mockLogger,
        redisClient: mockRedisClient as any,
        diskCacheDir: diskDir,
      });

      // set() must NOT throw
      await expect(cache.set('key:async', 'value')).resolves.not.toThrow();

      // delete() must NOT throw
      await expect(cache.delete('key:async')).resolves.not.toThrow();

      // Warning should have been logged
      expect(warnSpy).toHaveBeenCalledWith(
        'Backplane invalidation publish failed',
        expect.objectContaining({ error: 'Redis connection timeout' }),
      );

      await cache.destroy();
    });
  });
});
