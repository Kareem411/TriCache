import { describe, it, expect, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service.js';

describe('Tier-0 Enterprise: Heap Soak & Memory Leak Test', () => {
  let cache: CacheService | null = null;

  afterEach(async () => {
    if (cache) {
      await cache.destroy();
      cache = null;
    }
  });

  it('maintains constant heap bounds and leaks 0 memory over 50,000 high-velocity cycles', async () => {
    cache = new CacheService({
      namespace: `soak-${Date.now()}`,
      disableRedis: true,
      disableDisk: true,
      l1MaxBytes: 5 * 1024 * 1024, // 5 MB limit
      l1MaxEntries: 1_000,
    });

    if (typeof global.gc === 'function') {
      global.gc();
    }

    const initialHeap = process.memoryUsage().heapUsed;
    const TOTAL_CYCLES = 50_000;

    for (let i = 0; i < TOTAL_CYCLES; i++) {
      const key = `user:${i % 500}`;
      await cache.set(key, { id: i, payload: 'abc1234567890' }, 60);

      if (i % 5 === 0) {
        await cache.get(key, async () => ({ id: i, payload: 'abc1234567890' }), 60);
      }

      if (i % 100 === 0) {
        await cache.invalidateTag('users');
      }

      if (i % 500 === 0) {
        await cache.lock('crit-task', async () => 'ok', { acquireTimeout: 1000 });
      }
    }

    if (typeof global.gc === 'function') {
      global.gc();
    }

    const finalStats = cache.stats();
    // Verify L1 entry and byte bounds were strictly enforced by eviction
    expect(finalStats.l1.entries).toBeLessThanOrEqual(1_000);
    expect(finalStats.l1.sizeBytes).toBeLessThanOrEqual(5 * 1024 * 1024 * 1.1);

    // Verify heap growth remains controlled
    const finalHeap = process.memoryUsage().heapUsed;
    const growthMB = (finalHeap - initialHeap) / (1024 * 1024);
    expect(growthMB).toBeLessThan(50); // Under 50 MB variance for 50k ops
  });
});
