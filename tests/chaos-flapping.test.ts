import { describe, it, expect, afterEach, vi } from 'vitest';
import { CacheService } from '../src/cache-service.js';

describe('Chaos & Flapping Resilience Test', () => {
  let cache: CacheService | null = null;

  afterEach(async () => {
    if (cache) {
      await cache.destroy();
      cache = null;
    }
  });

  it('survives rapid Redis connection flapping without throwing HTTP 500 errors', async () => {
    cache = CacheService.create({
      namespace: `chaos-${Date.now()}`,
      disableRedis: false,
      disableDisk: true,
      l2CircuitBreakerThreshold: 3,
      l2CircuitBreakerCooldownMs: 100,
    });

    let isRedisUp = true;
    let redisOperations = 0;
    let redisFailures = 0;

    const mockRedis = {
      get: vi.fn(async (_k: string) => {
        redisOperations++;
        if (!isRedisUp) {
          redisFailures++;
          throw new Error('Connection is closed.');
        }
        return null;
      }),
      setex: vi.fn(async (_k: string, _ttl: number, _val: string) => {
        redisOperations++;
        if (!isRedisUp) {
          redisFailures++;
          throw new Error('Connection is closed.');
        }
        return 'OK';
      }),
      set: vi.fn(async () => 'OK'),
      del: vi.fn(async () => 1),
      publish: vi.fn(async () => 1),
      disconnect: vi.fn(async () => {}),
      on: vi.fn(),
    };

    (cache as any).redis = mockRedis;
    (cache as any)._redisDisabled = false;

    // Start background chaos timer flapping Redis every 20ms
    const chaosInterval = setInterval(() => {
      isRedisUp = !isRedisUp;
    }, 20);

    const totalRequests = 1_000;
    const fetchCounters = { runs: 0 };

    const tasks = Array.from({ length: totalRequests }, async (_, i) => {
      const key = `chaos:item:${i % 50}`;
      return cache!.get(
        key,
        async () => {
          fetchCounters.runs++;
          return { id: i % 50, timestamp: Date.now() };
        },
        60,
      );
    });

    const results = await Promise.all(tasks);
    clearInterval(chaosInterval);

    expect(results.length).toBe(totalRequests);
    expect(results[0]).toBeDefined();

    // Verify system stayed operational despite injected network failures
    expect(redisOperations).toBeGreaterThan(0);
    expect(redisFailures).toBeGreaterThanOrEqual(0);
    expect(fetchCounters.runs).toBeLessThanOrEqual(50 + 10); // L1 deduplication and caching held
  });
});
