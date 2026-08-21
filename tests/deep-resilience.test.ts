import { describe, it, expect, afterEach, vi } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, unlinkSync } from 'fs';

describe('Deep Resilience & Pathological Failure Modes', () => {
  const activeCaches: CacheService[] = [];

  afterEach(async () => {
    while (activeCaches.length > 0) {
      const c = activeCaches.pop();
      if (c) await c.destroy();
    }
  });

  function makeCache(opts: Parameters<typeof CacheService.create>[0] = {}): CacheService {
    const c = new CacheService({
      namespace: `deep-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      disableRedis: true,
      disableDisk: true,
      ...opts,
    });
    activeCaches.push(c);
    return c;
  }

  // ── 1. SWR Concurrency Stampede during Upstream Outage (staleIfError) ─────────

  it('protects 1,000 concurrent SWR callers and extends TTL when upstream throws an error', async () => {
    const cache = makeCache({
      staleIfError: 300,
    });

    // 1. Prime the cache with an entry that has 50ms TTL and 60s SWR window
    await cache.get('api:data', async () => ({ status: 'healthy_v1' }), 0.05, { swr: 60 });
    await new Promise(r => setTimeout(r, 70)); // Ensure it transitions into SWR grace

    let fetchAttempts = 0;
    const failingFetchFn = vi.fn(async () => {
      fetchAttempts++;
      // Simulate 10ms network delay before upstream fails with 503
      await new Promise(r => setTimeout(r, 10));
      throw new Error('503 Service Unavailable: Database down');
    });

    // 2. 1,000 concurrent callers arrive simultaneously in SWR window
    const results = await Promise.all(
      Array.from({ length: 1000 }, () =>
        cache.get('api:data', failingFetchFn, 1, { swr: 60 }),
      ),
    );

    // 3. Verify: 0 thrown errors, upstream called once, stale data served to all 1000
    expect(fetchAttempts).toBe(1);
    for (const res of results) {
      expect(res).toEqual({ status: 'healthy_v1' });
    }

    // Allow background revalidation error handler to finish extending the TTL
    await new Promise(r => setTimeout(r, 30));

    // 4. Verify TTL was extended by staleIfError (300s)
    const remaining = cache.ttl('api:data');
    expect(remaining).toBeGreaterThan(250);
  });

  // ── 2. Corrupted / Truncated Snapshot on Cold Start ───────────────────────────

  it('gracefully recovers from truncated and corrupted cold-start snapshots without crashing bootstrap', async () => {
    const snapFile = join(tmpdir(), `corrupt-snap-${Date.now()}-${Math.random().toString(36).slice(2)}.msgpack`);

    // Write invalid truncated binary header
    writeFileSync(snapFile, Buffer.from([0x93, 0xa4, 0x74, 0x65, 0x73])); // Malformed msgpack

    const cache = makeCache({
      snapshotPath: snapFile,
      disableDisk: false,
    });

    // Must not throw during loadSnapshot
    expect(() => cache.loadSnapshot()).not.toThrow();

    // Cache is clean and operational
    expect(cache.stats().l1.entries).toBe(0);
    await cache.set('fresh:key', 'value', 300);
    expect(cache.getIfFresh('fresh:key')).toBe('value');

    try { unlinkSync(snapFile); } catch { /* ok */ }
  });

  // ── 3. Circular & Deep Graph Dependency Cascades (dependsOn) ──────────────────

  it('handles circular dependency loops and deep cascades without stack overflow', async () => {
    const cache = makeCache();

    // Create circular dependency: A -> B -> C -> A
    await cache.set('node:A', 'valA', 300, undefined, { dependsOn: ['node:C'] });
    await cache.set('node:B', 'valB', 300, undefined, { dependsOn: ['node:A'] });
    await cache.set('node:C', 'valC', 300, undefined, { dependsOn: ['node:B'] });

    // Delete node:A
    await cache.delete('node:A');

    // All 3 nodes in the cycle must be cleanly evicted without infinite loop
    expect(cache.getIfFresh('node:A')).toBeNull();
    expect(cache.getIfFresh('node:B')).toBeNull();
    expect(cache.getIfFresh('node:C')).toBeNull();

    // Create a 30-node deep cascade chain: D0 -> D1 -> D2 -> ... -> D29
    for (let i = 1; i < 30; i++) {
      await cache.set(`chain:${i}`, `val-${i}`, 300, undefined, {
        dependsOn: [`chain:${i - 1}`],
      });
    }
    await cache.set('chain:0', 'root-val', 300);

    // Deleting root chain:0 cascades through all 30 dependent nodes
    await cache.delete('chain:0');
    for (let i = 0; i < 30; i++) {
      expect(cache.getIfFresh(`chain:${i}`)).toBeNull();
    }
  });

  // ── 4. Out-of-Order Generational Tag Events (Network Packet Reordering) ────────

  it('enforces monotonic tag version progression across out-of-order backplane broadcasts', async () => {
    const cache = makeCache({
      tagStrategy: 'generational',
    });

    // Simulate Version 5 arriving first
    (cache as any)._handleBackplaneMessage(JSON.stringify({
      op: 'tag_incr',
      key: 'catalog',
      tagVersion: 5,
      src: 'peer-node-1',
    }));
    expect(await cache.getTagVersion('catalog')).toBe(5);

    // Simulate lagging Version 2 arriving later (packet re-ordering)
    (cache as any)._handleBackplaneMessage(JSON.stringify({
      op: 'tag_incr',
      key: 'catalog',
      tagVersion: 2,
      src: 'peer-node-1',
    }));

    // Version must remain 5 (no backwards regression to stale version)
    expect(await cache.getTagVersion('catalog')).toBe(5);

    // Simulate newer Version 7 arriving
    (cache as any)._handleBackplaneMessage(JSON.stringify({
      op: 'tag_incr',
      key: 'catalog',
      tagVersion: 7,
      src: 'peer-node-1',
    }));
    expect(await cache.getTagVersion('catalog')).toBe(7);
  });

  // ── 5. Multi-Tenant Namespace Isolation under Mass Parallel Mutations ─────────

  it('guarantees complete isolation between independent namespaces under simultaneous flushes', async () => {
    const nsA = `tenant-alpha-${Date.now()}`;
    const nsB = `tenant-beta-${Date.now()}`;
    const tenantA = makeCache({ namespace: nsA });
    const tenantB = makeCache({ namespace: nsB });

    // Both write to the same logical key
    await tenantA.set('profile:1', { org: 'Alpha', secret: 'a_key' }, 300, undefined, { tags: ['profile'] });
    await tenantB.set('profile:1', { org: 'Beta', secret: 'b_key' }, 300, undefined, { tags: ['profile'] });

    // Tenant B executes mass mutations, clear(), and tag invalidations
    await tenantB.invalidateTag('profile');
    await tenantB.clear();

    // Tenant A must be completely unaffected and retain its cached state
    expect(tenantA.getIfFresh('profile:1')).toEqual({ org: 'Alpha', secret: 'a_key' });
    expect(tenantB.getIfFresh('profile:1')).toBeNull();
  });
});
