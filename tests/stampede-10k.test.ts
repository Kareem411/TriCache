import { describe, it, expect, afterEach, vi } from 'vitest';
import { CacheService } from '../src/cache-service.js';

describe('Thundering Herd 10k Stampede Stress Test', () => {
  let cache: CacheService | null = null;

  afterEach(async () => {
    if (cache) {
      await cache.destroy();
      cache = null;
    }
  });

  it('coalesces 10,000 concurrent callers onto exactly 1 fetch invocation', async () => {
    cache = CacheService.create({
      namespace: `stampede-10k-${Date.now()}`,
      disableRedis: true,
      disableDisk: true,
    });

    let fetchCount = 0;
    const fetchMock = vi.fn(async () => {
      fetchCount++;
      // Simulate 15ms database query latency
      await new Promise(r => setTimeout(r, 15));
      return { id: 'prod_999', name: 'Ultra High Demand Item', stock: 42 };
    });

    const start = Date.now();
    const concurrency = 10_000;

    // Launch 10,000 concurrent get() calls simultaneously
    const promises = Array.from({ length: concurrency }, () =>
      cache!.get('product:popular:999', fetchMock, 300),
    );

    const results = await Promise.all(promises);
    const duration = Date.now() - start;

    // Mathematically verify fetchFn executed exactly once
    expect(fetchCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Verify all 10,000 callers received the identical payload
    expect(results.length).toBe(concurrency);
    for (let i = 0; i < concurrency; i++) {
      expect(results[i]).toEqual({ id: 'prod_999', name: 'Ultra High Demand Item', stock: 42 });
    }

    // Verify metrics accurately recorded the 9,999 coalesced stampedes
    const metrics = cache.metrics();
    expect(metrics.gets.fetches).toBe(1);
    expect(metrics.gets.stampedePrevented).toBe(concurrency - 1);
    expect(duration).toBeLessThan(1000); // 10k promises resolve well under 1s
  });

  it('supports cache.wrap() for ergonomic 10k stampede coalescing', async () => {
    cache = CacheService.create({
      namespace: `wrap-stampede-${Date.now()}`,
      disableRedis: true,
      disableDisk: true,
    });

    let fetchCount = 0;
    const fetchMock = vi.fn(async () => {
      fetchCount++;
      await new Promise(r => setTimeout(r, 10));
      return { user: 'Alice', token: 'jwt_abc' };
    });

    const promises = Array.from({ length: 5_000 }, () =>
      cache!.wrap('auth:session:alice', fetchMock, { ttl: 60, swr: 30 }),
    );

    const results = await Promise.all(promises);
    expect(fetchCount).toBe(1);
    expect(results.length).toBe(5_000);
    expect(results[0]).toEqual({ user: 'Alice', token: 'jwt_abc' });
    expect(cache.metrics().gets.stampedePrevented).toBe(4_999);
  });
});
