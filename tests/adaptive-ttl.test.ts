/**
 * Tests for the adaptive TTL feature (CacheOptions.adaptiveTtl).
 *
 * Key patterns:
 *  - CacheService.reset(opts) creates a fresh singleton WITH the given options.
 *  - Between sample iterations, cache.delete(key) evicts from L1 so the next
 *    get() is a miss and fetchFn fires again, recording a new latency sample.
 *  - CacheService.reset() (no args) at the end of each test clears the singleton.
 */
import { describe, it, expect } from 'vitest';
import { CacheService } from '../src/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a fetchFn that resolves after ~`delayMs` ms. */
function delayedFetch<T>(value: T, delayMs: number): () => Promise<T> {
  return () => new Promise<T>(resolve => setTimeout(() => resolve(value), delayMs));
}

/**
 * Feed `n` fetch samples for `key` into `cache`.
 * Evicts from L1 before each fetch so fetchFn is always called.
 */
async function collectSamples(
  cache: CacheService,
  key: string,
  delayMs: number,
  n: number,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    if (i > 0) await cache.delete(key); // force L1 miss → fetchFn fires again
    await cache.get(key, delayedFetch(`v${i}`, delayMs), 300);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('adaptiveTtl', () => {
  it('is disabled by default — adaptiveTtl absent from metrics', async () => {
    const cache = CacheService.reset(); // default options
    await cache.get('key:1', delayedFetch('a', 5), 300);
    expect(cache.metrics().adaptiveTtl).toBeUndefined();
    CacheService.reset();
  });

  it('is absent from metrics when explicitly disabled', () => {
    const cache = CacheService.reset({ adaptiveTtl: false });
    expect(cache.metrics().adaptiveTtl).toBeUndefined();
    CacheService.reset();
  });

  it('enabled: true and trackedKeys = 1 after first fetch', async () => {
    const cache = CacheService.reset({ adaptiveTtl: true });
    await cache.get('user:1', delayedFetch({ id: 1 }, 5), 300);
    const m = cache.metrics();
    expect(m.adaptiveTtl?.enabled).toBe(true);
    expect(m.adaptiveTtl?.trackedKeys).toBe(1);
    CacheService.reset();
  });

  it('slowestKeys is empty until ≥ 5 samples are collected', async () => {
    const cache = CacheService.reset({ adaptiveTtl: true });
    await collectSamples(cache, 'user:slow', 5, 4); // only 4 samples
    const m = cache.metrics();
    expect(m.adaptiveTtl?.trackedKeys).toBe(1);
    expect(m.adaptiveTtl?.slowestKeys).toHaveLength(0);
    CacheService.reset();
  });

  it('slowestKeys appears once ≥ 5 samples are collected', async () => {
    const cache = CacheService.reset({
      adaptiveTtl: true,
      adaptiveTtlMultiplier: 10,
      adaptiveTtlMin: 1,
      adaptiveTtlMax: 86400,
    });
    await collectSamples(cache, 'user:slow', 5, 6);
    const m = cache.metrics();
    expect(m.adaptiveTtl?.slowestKeys).toHaveLength(1);
    const entry = m.adaptiveTtl!.slowestKeys[0];
    expect(entry.key).toBe('user:slow');
    expect(entry.p95Ms).toBeGreaterThan(0);
    expect(entry.adaptedTtlSec).toBeGreaterThanOrEqual(1);
    CacheService.reset();
  });

  it('adaptiveTtlMin clamps derived TTL upward', async () => {
    // p95 ≈ 5ms × multiplier 1 = 5ms → 0.005 s → clamped up to min 60 s
    const cache = CacheService.reset({
      adaptiveTtl: true,
      adaptiveTtlMultiplier: 1,
      adaptiveTtlMin: 60,
      adaptiveTtlMax: 86400,
    });
    await collectSamples(cache, 'cfg:global', 5, 6);
    const entry = cache.metrics().adaptiveTtl?.slowestKeys[0];
    expect(entry?.adaptedTtlSec).toBe(60);
    CacheService.reset();
  });

  it('adaptiveTtlMax clamps derived TTL downward', async () => {
    // p95 ≈ 50ms × multiplier 1000 = 50 000 ms → 50 s → clamped to max 30 s
    const cache = CacheService.reset({
      adaptiveTtl: true,
      adaptiveTtlMultiplier: 1000,
      adaptiveTtlMin: 1,
      adaptiveTtlMax: 30,
    });
    await collectSamples(cache, 'cfg:global', 50, 6);
    const entry = cache.metrics().adaptiveTtl?.slowestKeys[0];
    expect(entry?.adaptedTtlSec).toBeLessThanOrEqual(30);
    CacheService.reset();
  });

  it('null/undefined fetch results are not tracked (negative caching)', async () => {
    const cache = CacheService.reset({
      adaptiveTtl: true,
      notFoundTtl: 30,
    });
    for (let i = 0; i < 6; i++) {
      await cache.get(`missing:${i}`, async () => null, 300);
    }
    expect(cache.metrics().adaptiveTtl?.trackedKeys).toBe(0);
    CacheService.reset();
  });

  it('respects adaptiveTtlMaxKeys — oldest key evicted when cap reached', async () => {
    const cache = CacheService.reset({
      adaptiveTtl: true,
      adaptiveTtlMaxKeys: 2,
    });
    await cache.get('a:1', delayedFetch(1, 5), 300);
    await cache.get('b:2', delayedFetch(2, 5), 300);
    await cache.get('c:3', delayedFetch(3, 5), 300); // should evict a:1
    expect(cache.metrics().adaptiveTtl?.trackedKeys).toBeLessThanOrEqual(2);
    CacheService.reset();
  });

  it('slowestKeys sorted descending by p95Ms', async () => {
    const cache = CacheService.reset({
      adaptiveTtl: true,
      adaptiveTtlMultiplier: 1,
      adaptiveTtlMin: 1,
      adaptiveTtlMax: 999_999,
    });
    // fast key: ~5 ms; slow key: ~60 ms
    await collectSamples(cache, 'fast:key', 5, 6);
    await collectSamples(cache, 'slow:key', 60, 6);
    const keys = cache.metrics().adaptiveTtl?.slowestKeys ?? [];
    expect(keys.length).toBe(2);
    expect(keys[0].p95Ms).toBeGreaterThanOrEqual(keys[1].p95Ms);
    expect(keys[0].key).toBe('slow:key');
    CacheService.reset();
  });

  it('namespace prefix is stripped from slowestKeys entries', async () => {
    const cache = CacheService.reset({
      adaptiveTtl: true,
      adaptiveTtlMultiplier: 1,
      adaptiveTtlMin: 1,
      adaptiveTtlMax: 999_999,
      namespace: 'ns',
    });
    await collectSamples(cache, 'user:1', 5, 6);
    const keys = cache.metrics().adaptiveTtl?.slowestKeys ?? [];
    for (const k of keys) {
      expect(k.key).not.toMatch(/^ns:/);
    }
    CacheService.reset();
  });
});