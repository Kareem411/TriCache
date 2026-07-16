/**
 * Regression tests for two P2/P3 items:
 *
 *  1. ensureCapacity() must evict until the cache is back UNDER its limit, not
 *     just remove a fixed EVICT_COUNT=4 entries per set(). The discriminating
 *     case: fill the global byte budget with small entries, then insert ONE
 *     large entry that pushes totalSize far past maxBytes in a single set().
 *     Old code evicted only 4 small entries (400 bytes) and returned with the
 *     cache still over budget; the loop now keeps evicting until under.
 *
 *  2. CacheEncryption.toWorkerInit() exposes the worker-pool key material via a
 *     proper accessor instead of cache-service.ts casting private fields
 *     (`as unknown as { _key, _mode, … }`). Verified by checking the accessor
 *     returns the same base64 key/mode the worker pool would consume.
 */
import { describe, it, expect } from 'vitest';
import { SmartMemoryCache } from '../src/smart-memory-cache';
import { CacheEncryption, type EncryptionMode } from '../src/encryption';

const NOOP = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as const;

describe('ensureCapacity evicts until under the limit (not just EVICT_COUNT per set)', () => {
  // White-box: drive ensureCapacity() directly so the evict-before-insert + half-
  // entry-cap guards in set() don't mask the bug. The real invariant under test is
  // "after ensureCapacity returns, the cache is back under its byte ceiling" — which
  // a single EVICT_COUNT=4 pass does NOT guarantee when the overflow is large.
  function makeOverfullCache(): SmartMemoryCache {
    // Fill with a generous byte ceiling so nothing evicts during setup…
    const cache = new SmartMemoryCache({
      maxBytes: 1_000_000,
      maxEntries: 10_000,
      categories: { default: { maxEntries: 10_000, maxSizeBytes: 1_000_000 } },
      logger: NOOP as any,
    });
    // ~200 B payloads × 50 ≈ 10 KB — comfortably over the 2 KB ceiling we drop to.
    for (let i = 0; i < 50; i++) cache.set(`k:${i}`, { data: 'x'.repeat(200) }, 60_000, 2);
    // …then drop the ceiling far below the current usage to force a real overflow.
    (cache as any).opts.maxBytes = 2000;
    (cache as any).opts.categories.default.maxSizeBytes = 2000;
    return cache;
  }

  it('loops until totalSize is back under maxBytes after a large overflow', () => {
    const cache = makeOverfullCache();
    expect((cache as any).totalSize).toBeGreaterThan(2000); // precondition: over budget
    (cache as any).ensureCapacity('default', 0);
    expect((cache as any).totalSize).toBeLessThanOrEqual(2000);
  });

  it('category byte limit is also driven back under by repeated eviction', () => {
    const cache = new SmartMemoryCache({
      maxBytes: 1_000_000,
      maxEntries: 10_000,
      categories: { bulk: { maxEntries: 10_000, maxSizeBytes: 1_000_000 } },
      logger: NOOP as any,
    });
    for (let i = 0; i < 50; i++) cache.set(`bulk:${i}`, { data: 'x'.repeat(200) }, 60_000, 2);
    (cache as any).opts.categories.bulk.maxSizeBytes = 1000;
    expect((cache as any).categorySize.get('bulk')).toBeGreaterThan(1000); // precondition
    (cache as any).ensureCapacity('bulk', 0);
    expect((cache as any).categorySize.get('bulk')).toBeLessThanOrEqual(1000);
  });
});

describe('CacheEncryption.toWorkerInit() exposes worker key material without private casts', () => {
  for (const mode of ['aes-256-gcm', 'aes-128-gcm', 'aes-128-ctr', 'xor'] as EncryptionMode[]) {
    it(`returns keyBase64 + mode for ${mode}`, () => {
      const len = mode === 'aes-256-gcm' ? 32 : 16;
      const keyB64 = Buffer.alloc(len, 9).toString('base64');
      const enc = new CacheEncryption(keyB64, NOOP as any, mode);
      const init = enc.toWorkerInit();
      expect(init.keyBase64).toBe(keyB64);
      expect(init.mode).toBe(mode);
      expect(init.prevKeyBase64).toBeUndefined();
    });
  }

  it('carries previous-key material for key-rotation fallback', () => {
    const enc = new CacheEncryption(
      Buffer.alloc(32, 1).toString('base64'),
      NOOP as any,
      'aes-256-gcm',
      Buffer.alloc(32, 2).toString('base64'),
      'aes-256-gcm',
    );
    const init = enc.toWorkerInit();
    expect(init.prevKeyBase64).toBe(Buffer.alloc(32, 2).toString('base64'));
    expect(init.prevMode).toBe('aes-256-gcm');
  });
});
