import { describe, it, expect } from 'vitest';
import { EdgeCacheService } from '../src/edge/cache';
import type { IEdgeRemoteStorage } from '../src/edge/types';
import type { ICacheTracer, ICacheSpan } from '../src/types';
import crypto from 'node:crypto';

describe('Universal Edge Portability: EdgeCacheService', () => {
  it('enforces dual-bounded LRU eviction based on maxKeys without background intervals', async () => {
    const cache = new EdgeCacheService({
      maxKeys: 3,
      defaultTtlSeconds: 60,
    });

    await cache.set('k1', 'val1');
    await cache.set('k2', 'val2');
    await cache.set('k3', 'val3');

    // Access k1 to make it recently used: order in LRU is now k2, k3, k1
    await cache.get('k1');

    // Inserting k4 exceeds maxKeys (3), should evict oldest (k2)
    await cache.set('k4', 'val4');

    expect(await cache.get('k2')).toBeNull(); // evicted
    expect(await cache.get('k1')).toBe('val1');
    expect(await cache.get('k3')).toBe('val3');
    expect(await cache.get('k4')).toBe('val4');
  });

  it('enforces byte ceiling eviction based on maxBytes', async () => {
    // 900 bytes budget
    const cache = new EdgeCacheService({
      maxBytes: 900,
      defaultTtlSeconds: 60,
    });

    await cache.set('small1', 'data1');
    await cache.set('small2', 'data2');

    // Insert a large string (approx 874 bytes) that forces eviction of previous keys
    const largeStr = 'x'.repeat(400);
    await cache.set('big', largeStr);

    const stats = cache.stats();
    expect(stats.bytes).toBeLessThanOrEqual(900);
    expect(await cache.get('small1')).toBeNull(); // evicted
    expect(await cache.get('small2')).toBeNull(); // evicted
    expect(await cache.get('big')).toBe(largeStr);
  });

  it('coalesces 50 concurrent callers into a single fetchFn call (stampede protection)', async () => {
    const cache = new EdgeCacheService();
    let fetchCount = 0;

    const slowFetcher = async () => {
      fetchCount++;
      await new Promise(r => setTimeout(r, 20));
      return { id: 42, title: 'Edge Coalesced Post' };
    };

    const results = await Promise.all(
      Array.from({ length: 50 }, () => cache.get('post:42', slowFetcher, 60)),
    );

    expect(fetchCount).toBe(1);
    for (const r of results) {
      expect(r).toEqual({ id: 42, title: 'Edge Coalesced Post' });
    }
  });

  it('handles Stale-While-Revalidate and protects background tasks via ctx.waitUntil', async () => {
    const cache = new EdgeCacheService();
    let fetchedCounter = 0;

    const fetcher = async () => {
      fetchedCounter++;
      return `version-${fetchedCounter}`;
    };

    // Initial populate: TTL = 1s, SWR window = 5s
    await cache.set('swr-item', 'version-0', 1, { swr: 5 });

    // Fast-forward time simulation by altering entry expiration
    const s = cache.stats();
    expect(s.keys).toBe(1);

    // Wait 1.1 seconds so entry is past TTL (stale) but within SWR window
    await new Promise(r => setTimeout(r, 1100));

    let waitUntilCalled = false;
    let registeredPromise: Promise<unknown> | null = null;

    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        waitUntilCalled = true;
        registeredPromise = p;
      },
    };

    // Stale read: returns stale 'version-0' immediately, triggers revalidate in background
    const value = await cache.get('swr-item', fetcher, 60, { ctx, swr: 5 });
    expect(value).toBe('version-0');
    expect(waitUntilCalled).toBe(true);

    // Wait for the background task passed to ctx.waitUntil to complete
    if (registeredPromise) {
      await registeredPromise;
    }

    // Now cache has fresh 'version-1'
    const freshValue = await cache.get('swr-item');
    expect(freshValue).toBe('version-1');
  });

  it('integrates with remote L2 storage and Web Crypto at-rest encryption', async () => {
    const mockStorageMap = new Map<string, string>();
    const mockStorage: IEdgeRemoteStorage = {
      async get(k: string) { return mockStorageMap.get(k) ?? null; },
      async set(k: string, v: string) { mockStorageMap.set(k, v); },
      async delete(k: string) { mockStorageMap.delete(k); },
    };

    const key256 = crypto.randomBytes(32).toString('base64');

    const cache1 = new EdgeCacheService({
      remoteStorage: mockStorage,
      encryption: { keyBase64: key256 },
      defaultTtlSeconds: 120,
    });

    // Write through cache1
    await cache1.set('secret-token', { token: 'xyz-secret-999' });

    // Verify remote storage received encrypted payload
    const rawInStorage = mockStorageMap.get('secret-token');
    expect(rawInStorage).toBeDefined();
    expect(rawInStorage!.startsWith('enc:v1:')).toBe(true);
    expect(rawInStorage).not.toContain('xyz-secret-999');

    // Create fresh edge cache instance sharing the remote storage
    const cache2 = new EdgeCacheService({
      remoteStorage: mockStorage,
      encryption: { keyBase64: key256 },
    });

    // Cache2 cold read hits remote storage and decrypts transparently
    const decrypted = await cache2.get<{ token: string }>('secret-token');
    expect(decrypted).toEqual({ token: 'xyz-secret-999' });
  });

  it('supports tag invalidation across memory and remote tiers', async () => {
    const remoteMap = new Map<string, string>();
    const mockStorage: IEdgeRemoteStorage = {
      async get(k: string) { return remoteMap.get(k) ?? null; },
      async set(k: string, v: string) { remoteMap.set(k, v); },
      async delete(k: string) { remoteMap.delete(k); },
    };

    const cache = new EdgeCacheService({ remoteStorage: mockStorage });

    await cache.set('prod:1', { name: 'Phone' }, 60, { tags: ['products'] });
    await cache.set('prod:2', { name: 'Laptop' }, 60, { tags: ['products'] });
    await cache.set('user:1', { name: 'Bob' }, 60, { tags: ['users'] });

    expect(await cache.get('prod:1')).toEqual({ name: 'Phone' });

    // Invalidate products tag
    await cache.invalidateTag('products');

    expect(await cache.get('prod:1')).toBeNull();
    expect(await cache.get('prod:2')).toBeNull();
    expect(await cache.get('user:1')).toEqual({ name: 'Bob' });
  });

  it('instruments OpenTelemetry spans matching OTEL semantic conventions', async () => {
    const spans: Array<{ name: string; attrs: Record<string, unknown> }> = [];
    const mockTracer: ICacheTracer = {
      startSpan(name: string) {
        const attrs: Record<string, unknown> = {};
        const s: ICacheSpan = {
          setAttribute(k, v) { attrs[k] = v; return s; },
          setStatus() { return s; },
          recordException() { return s; },
          end() {},
        };
        spans.push({ name, attrs });
        return s;
      },
    };

    const cache = new EdgeCacheService({
      tracer: mockTracer,
      namespace: 'edge-tenant',
    });

    // Cold miss
    await cache.get('cold-item', async () => 'hello', 60);
    const getSpan = spans.find(s => s.name === 'tricache.get');
    expect(getSpan).toBeDefined();
    expect(getSpan!.attrs['cache.namespace']).toBe('edge-tenant');
    expect(getSpan!.attrs['cache.key']).toBe('cold-item');

    // Warm hit
    spans.length = 0;
    await cache.get('cold-item');
    expect(spans[0].attrs['cache.hit']).toBe(true);
    expect(spans[0].attrs['cache.item.tier']).toBe('memory');
  });
});
