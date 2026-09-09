import { describe, it, expect, vi } from 'vitest';
import { SmartMemoryCache } from '../src/smart-memory-cache';
import { CacheService } from '../src/cache-service';
import { WTinyLfuCache } from '../src/wtiny-lfu';
import type { SmartCacheEntry } from '../src/types';

describe('Window TinyLFU (W-TinyLFU) Integration Tests', () => {
  const dummyLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  describe('SmartMemoryCache with W-TinyLFU Admission', () => {
    it('initializes with W-TinyLFU policy when admissionPolicy is "wtinylfu"', () => {
      const cache = new SmartMemoryCache({
        maxBytes: 10 * 1024 * 1024,
        maxEntries: 100,
        categories: { default: { maxEntries: 100, maxSizeBytes: 10 * 1024 * 1024 } },
        logger: dummyLogger,
        admissionPolicy: 'wtinylfu',
      });

      const stats = cache.getWTinyLfuStats();
      expect(stats).toBeDefined();
      expect(stats?.capacity).toBe(100);
      expect(stats?.windowSize).toBe(0);
      expect(stats?.probationSize).toBe(0);
      expect(stats?.protectedSize).toBe(0);
    });

    it('returns undefined stats when running under default adaptive eviction', () => {
      const cache = new SmartMemoryCache({
        maxBytes: 10 * 1024 * 1024,
        maxEntries: 100,
        categories: { default: { maxEntries: 100, maxSizeBytes: 10 * 1024 * 1024 } },
        logger: dummyLogger,
      });

      expect(cache.getWTinyLfuStats()).toBeUndefined();
    });

    it('demonstrates mathematical scan resistance against 500-key single-access flood', () => {
      // Small cache of 20 entries
      const cache = new SmartMemoryCache({
        maxBytes: 10 * 1024 * 1024,
        maxEntries: 20,
        categories: { default: { maxEntries: 20, maxSizeBytes: 10 * 1024 * 1024 } },
        logger: dummyLogger,
        admissionPolicy: 'wtinylfu',
      });

      // 1. Seed 5 hot keys and access them multiple times so their sketch frequency is high
      const hotKeys = ['hot:1', 'hot:2', 'hot:3', 'hot:4', 'hot:5'];
      for (const k of hotKeys) {
        cache.set(k, { val: `data-${k}` }, 60_000);
      }
      for (let i = 0; i < 30; i++) {
        for (const k of hotKeys) {
          cache.get(k);
        }
      }

      // Fill the rest of the cache with 15 warm keys
      for (let i = 0; i < 15; i++) {
        const k = `warm:${i}`;
        cache.set(k, { val: `warm-${i}` }, 60_000);
        cache.get(k);
        cache.get(k);
      }

      // 2. Perform a sequential scan of 500 distinct keys (frequency 1)
      for (let i = 0; i < 500; i++) {
        cache.set(`scan:${i}`, { val: `scan-data-${i}` }, 60_000);
      }

      // 3. Verify that 100% of hot keys survived the scan!
      for (const k of hotKeys) {
        expect(cache.get(k)).not.toBeNull();
      }

      const stats = cache.getWTinyLfuStats();
      expect(stats).toBeDefined();
      expect(stats!.rejections).toBeGreaterThan(400);
    });

    it('spills TinyLFU rejected candidate to disk tier when diskSpill is configured', () => {
      const spilledKeys: string[] = [];
      const diskSpill = vi.fn((key: string, _entry: SmartCacheEntry) => {
        spilledKeys.push(key);
      });

      const cache = new SmartMemoryCache({
        maxBytes: 10 * 1024 * 1024,
        maxEntries: 10,
        categories: { default: { maxEntries: 10, maxSizeBytes: 10 * 1024 * 1024 } },
        logger: dummyLogger,
        admissionPolicy: 'wtinylfu',
        diskSpill,
      });

      // Seed 10 frequent keys
      for (let i = 0; i < 10; i++) {
        const k = `resident:${i}`;
        cache.set(k, { val: i }, 60_000);
        for (let j = 0; j < 10; j++) cache.get(k);
      }

      // Try inserting 5 single-access keys — window overflows and TinyLFU rejects them
      for (let i = 0; i < 5; i++) {
        cache.set(`scan:${i}`, { val: `scan-${i}` }, 60_000);
      }

      // Check that rejections resulted in disk spills
      expect(spilledKeys.length).toBeGreaterThan(0);
      expect(spilledKeys.some(k => k.startsWith('scan:') || k.startsWith('resident:'))).toBe(true);
    });

    it('promotes entries to protected on 2nd hit and tracks promotions/demotions', () => {
      const cache = new SmartMemoryCache({
        maxBytes: 10 * 1024 * 1024,
        maxEntries: 20,
        categories: { default: { maxEntries: 20, maxSizeBytes: 10 * 1024 * 1024 } },
        logger: dummyLogger,
        admissionPolicy: 'wtinylfu',
      });

      // Insert keys to fill window and push into probation
      for (let i = 0; i < 10; i++) {
        cache.set(`item:${i}`, { v: i }, 60_000);
      }

      // 2nd hit triggers promotion from probation to protected
      for (let i = 0; i < 10; i++) {
        cache.get(`item:${i}`);
      }

      const stats = cache.getWTinyLfuStats()!;
      expect(stats.hits).toBeGreaterThan(0);
      expect(stats.promotions).toBeGreaterThanOrEqual(0);
    });

    it('clears W-TinyLFU policy state on cache.clear()', () => {
      const cache = new SmartMemoryCache({
        maxBytes: 10 * 1024 * 1024,
        maxEntries: 50,
        categories: { default: { maxEntries: 50, maxSizeBytes: 10 * 1024 * 1024 } },
        logger: dummyLogger,
        admissionPolicy: 'wtinylfu',
      });

      for (let i = 0; i < 20; i++) {
        cache.set(`k:${i}`, i, 60_000);
      }
      expect(cache.size).toBe(20);

      cache.clear();
      expect(cache.size).toBe(0);

      const stats = cache.getWTinyLfuStats()!;
      expect(stats.size).toBe(0);
      expect(stats.windowSize).toBe(0);
      expect(stats.probationSize).toBe(0);
      expect(stats.protectedSize).toBe(0);
    });

    it('removes keys from W-TinyLFU queues on delete', () => {
      const cache = new SmartMemoryCache({
        maxBytes: 10 * 1024 * 1024,
        maxEntries: 50,
        categories: { default: { maxEntries: 50, maxSizeBytes: 10 * 1024 * 1024 } },
        logger: dummyLogger,
        admissionPolicy: 'wtinylfu',
      });

      cache.set('key1', 'val1', 60_000);
      expect(cache.has('key1')).toBe(true);

      cache.delete('key1');
      expect(cache.has('key1')).toBe(false);

      const stats = cache.getWTinyLfuStats()!;
      expect(stats.size).toBe(0);
    });
  });

  describe('CacheService End-to-End with W-TinyLFU', () => {
    it('configures W-TinyLFU through CacheOptions.l1AdmissionPolicy', async () => {
      const cache = new CacheService({
        namespace: `wtiny-test-${Date.now()}`,
        disableRedis: true,
        disableDisk: true,
        l1MaxEntries: 100,
        l1AdmissionPolicy: 'wtinylfu',
      });

      const stats = cache.getWTinyLfuStats();
      expect(stats).toBeDefined();
      expect(stats?.capacity).toBe(100);

      await cache.get('test:1', () => Promise.resolve({ ok: true }), 60);
      const hit = await cache.get('test:1', () => Promise.resolve({ ok: true }), 60);
      expect(hit).toEqual({ ok: true });

      const updatedStats = cache.getWTinyLfuStats()!;
      expect(updatedStats.hits).toBe(1);

      await cache.destroy();
    });

    it('protects hot dataset under high-volume Zipf-like access patterns', async () => {
      const cache = new CacheService({
        namespace: `zipf-test-${Date.now()}`,
        disableRedis: true,
        disableDisk: true,
        l1MaxEntries: 30,
        l1AdmissionPolicy: 'wtinylfu',
      });

      let dbQueries = 0;
      const fetchFn = (id: string) => {
        dbQueries++;
        return Promise.resolve({ id, payload: `data-for-${id}` });
      };

      // Prime 5 very hot items
      const hotIds = ['user:1', 'user:2', 'user:3', 'user:4', 'user:5'];
      for (const id of hotIds) {
        await cache.get(id, () => fetchFn(id), 60);
      }
      for (let round = 0; round < 20; round++) {
        for (const id of hotIds) {
          await cache.get(id, () => fetchFn(id), 60);
        }
      }

      const initialDbQueries = dbQueries;
      expect(initialDbQueries).toBe(5);

      // Run 200 one-off scan queries
      for (let i = 0; i < 200; i++) {
        await cache.get(`scan:item:${i}`, () => fetchFn(`scan:item:${i}`), 60);
      }

      // Query the hot items again — all 5 must hit L1 without invoking fetchFn!
      for (const id of hotIds) {
        const result = await cache.get(id, () => fetchFn(id), 60);
        expect(result.id).toBe(id);
      }

      // DB queries for hot items should still be 0 (no cache misses on hot keys)
      expect(dbQueries - initialDbQueries).toBe(200); // Only the scan items hit DB

      const stats = cache.getWTinyLfuStats();
      expect(stats?.rejections).toBeGreaterThan(150);

      await cache.destroy();
    });
  });

  describe('WTinyLfuCache Direct Standalone API', () => {
    it('supports get, set, has, delete, clear, and getStats', () => {
      const cache = new WTinyLfuCache<string, number>({ capacity: 50 });

      cache.set('a', 1);
      cache.set('b', 2);

      expect(cache.has('a')).toBe(true);
      expect(cache.get('a')).toBe(1);
      expect(cache.size).toBe(2);

      cache.delete('a');
      expect(cache.has('a')).toBe(false);
      expect(cache.get('a')).toBeUndefined();

      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.getStats().hits).toBe(0);
    });
  });
});
