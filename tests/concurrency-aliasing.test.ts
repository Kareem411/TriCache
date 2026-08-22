/**
 * Concurrency-aliasing regression tests (P0).
 *
 * Guards against the shared module-level `_hit` object in SmartMemoryCache.get():
 * two live CacheHit results must never alias the same object, and CacheService.get()
 * must never return another key's payload when tag-version lookups suspend the
 * event loop between the L1 hit and the return (tagStrategy: 'generational').
 *
 * RED state (pre-fix): SmartMemoryCache.get() returns the SAME object for two
 * distinct keys, and concurrent generational gets cross-contaminate payloads.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { SmartMemoryCache } from '../src/smart-memory-cache.js';
import { CacheService } from '../src/cache-service.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe('SmartMemoryCache.get(): result objects must not alias', () => {
  it('returns independent CacheHit objects for distinct keys', () => {
    const l1 = new SmartMemoryCache({
      maxBytes: 64 * 1024 * 1024,
      maxEntries: 10_000,
      categories: { default: { maxEntries: 10_000, maxSizeBytes: 64 * 1024 * 1024 } },
      logger: silentLogger,
    });

    l1.set('a', { v: 'A' }, 60_000);
    const h1 = l1.get('a');
    expect(h1).not.toBeNull();

    l1.set('b', { v: 'B' }, 60_000);
    const h2 = l1.get('b');
    expect(h2).not.toBeNull();

    // The two results must be distinct objects…
    expect(h1).not.toBe(h2);
    // …and reading h1 after a later get() must still observe key a's data.
    expect((h1!.value as { v: string }).v).toBe('A');
    expect((h2!.value as { v: string }).v).toBe('B');
  });
});

describe('CacheService.get(): generational tag reads under concurrency', () => {
  let cache: CacheService | null = null;
  let ns = '';
  let tagVersionFor: (tag: string) => number = () => 1;

  afterEach(async () => {
    if (cache) {
      await cache.destroy();
      // destroy() closes the disk tier's SQLite handle; now the namespaced disk
      // dir can be removed. Retry loop: Windows releases handles asynchronously.
      if (ns) {
        const dir = join(tmpdir(), `tricache-disk-${ns}`);
        for (let i = 0; i < 5; i++) {
          try { rmSync(dir, { recursive: true, force: true }); break; } catch { /* retry */ }
        }
      }
      cache = null;
    }
  });

  function makeGenerationalSvc() {
    ns = `alias-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cache = new CacheService({
      namespace: ns,
      disableRedis: true,
      invalidationBackplane: false,
      oomProtection: false,
      tagStrategy: 'generational',
      logger: silentLogger,
    });
    // Suspend every tag-version lookup on a macrotask so the interleaving window
    // between the L1 hit and the return is deterministic under the test's
    // Promise.all concurrency (every await yields the microtask queue).
    // tagVersionFor() lets individual tests control per-tag versions.
    (cache as unknown as { _getTagVersion: (tag: string) => Promise<number> })._getTagVersion =
      async (tag: string) => {
        await new Promise(r => setTimeout(r, 10));
        return tagVersionFor(tag);
      };
    return cache!;
  }

  /** Seed an L1 entry under the instance-namespaced key with captured tag versions. */
  function seedTagged(l1: SmartMemoryCache, bareKey: string, value: unknown, tags: Record<string, number>) {
    l1.set(`${ns}:x:${bareKey}`, value, 60_000, 2, undefined, undefined, tags);
  }

  it('concurrent gets of two distinct tagged keys never cross payloads', async () => {
    const svc = makeGenerationalSvc();
    const l1 = (svc as unknown as { l1: SmartMemoryCache }).l1;
    seedTagged(l1, 'k1', { who: 'K1' }, { t: 1 });
    seedTagged(l1, 'k2', { who: 'K2' }, { t: 1 });
    tagVersionFor = () => 1;

    const [r1, r2] = await Promise.all([
      svc.get('x:k1', async () => ({ who: 'FETCHED-1' }), 60),
      svc.get('x:k2', async () => ({ who: 'FETCHED-2' }), 60),
    ]);

    expect((r1 as { who: string }).who).toBe('K1');
    expect((r2 as { who: string }).who).toBe('K2');
  });

  it('high-concurrency interleaved reads stay key-faithful (20 keys × tagged)', async () => {
    const svc = makeGenerationalSvc();
    const l1 = (svc as unknown as { l1: SmartMemoryCache }).l1;
    for (let i = 0; i < 20; i++) {
      seedTagged(l1, `key${i}`, { i }, { t: 1 });
    }
    tagVersionFor = () => 1;

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => svc.get(`x:key${i}`, async () => ({ i: -1 }), 60)),
    );
    for (let i = 0; i < 20; i++) {
      expect((results[i] as { i: number }).i).toBe(i);
    }
  });

  it('generational-stale deletion uses the entry own setAt, not a clobbered one', async () => {
    const svc = makeGenerationalSvc();
    const l1 = (svc as unknown as { l1: SmartMemoryCache }).l1;
    // Seed FRESH first (earlier setAt), then the STALE entry ≥2ms later (strictly
    // later setAt). Tag t bumps stale only the "old" entry.
    // Race: while get("x:old") awaits its tag-version check, get("x:fresh")
    // repopulates any SHARED hit object — if get("x:old") then reads setAt from
    // the shared object it receives fresh's EARLIER setAt as the compare-and-delete
    // cutoff, old.setAt > cutoff → deletion silently skipped → stale entry survives.
    // A per-call hit object cuts off at old's OWN setAt → entry evicted.
    seedTagged(l1, 'fresh', { who: 'FRESH' }, { u: 1 });
    await new Promise(r => setTimeout(r, 2));
    seedTagged(l1, 'old', { who: 'OLD' }, { t: 1 });
    tagVersionFor = (tag: string) => (tag === 't' ? 2 : 1);

    // The refetch overwrites the L1 entry either way, so the clobbered cutoff is
    // observable only at the compare-and-delete boundary itself: spy on it and
    // require the STALE entry's OWN setAt as the cutoff (a shared hit object would
    // deliver fresh's earlier setAt instead).
    const oldSetAt = l1.getEntry(`${ns}:x:old`)!.setAt!;
    const l1Any = l1 as unknown as {
      deleteIfSetBefore: (k: string, cutoff: number) => boolean;
    };
    const origDelete = l1Any.deleteIfSetBefore.bind(l1);
    const cutoffCalls: Array<{ k: string; cutoff: number }> = [];
    l1Any.deleteIfSetBefore = (k, cutoff) => {
      cutoffCalls.push({ k, cutoff });
      return origDelete(k, cutoff);
    };

    const [rOld, rFresh] = await Promise.all([
      svc.get('x:old', async () => ({ who: 'REVALIDATED-OLD' }), 60),
      svc.get('x:fresh', async () => ({ who: 'FETCHED-FRESH' }), 60),
    ]);

    // Responses must be key-faithful…
    expect((rOld as { who: string }).who).toBe('REVALIDATED-OLD');
    expect((rFresh as { who: string }).who).toBe('FRESH');
    // …and the stale-key compare-and-delete must have cut off at the stale
    // entry's own write time — never at another key's earlier setAt.
    const oldCall = cutoffCalls.find(c => c.k === `${ns}:x:old`);
    expect(oldCall).toBeDefined();
    expect(oldCall!.cutoff).toBeGreaterThanOrEqual(oldSetAt);
    expect(l1.getEntry(`${ns}:x:fresh`)).toBeDefined();
  });
});
