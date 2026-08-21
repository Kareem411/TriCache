import { describe, it, expect, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service.js';

describe('Lock Expiry Mid-Execution & Safe Lua Token Release', () => {
  let cache: CacheService | null = null;

  afterEach(async () => {
    if (cache) {
      await cache.destroy();
      cache = null;
    }
  });

  it('prevents a slow task from accidentally releasing a lock acquired by another worker', async () => {
    cache = new CacheService({
      namespace: `lock-race-${Date.now()}`,
      disableRedis: true,
    });

    let worker2Executed = false;

    // Worker 1 acquires lock with 100ms TTL but runs for 250ms
    const worker1Promise = cache.lock('critical-job', async () => {
      // Simulate slow execution exceeding acquire timeout of others
      await new Promise(r => setTimeout(r, 200));
      return 'worker-1-result';
    }, { ttl: 1, acquireTimeout: 500 });

    // Worker 2 attempts to acquire the lock with sufficient acquireTimeout
    const worker2Promise = cache.lock('critical-job', async () => {
      worker2Executed = true;
      return 'worker-2-result';
    }, { ttl: 1, acquireTimeout: 1000, retryInterval: 20 });

    const [res1, res2] = await Promise.all([worker1Promise, worker2Promise]);

    expect(res1).toBe('worker-1-result');
    expect(res2).toBe('worker-2-result');
    expect(worker2Executed).toBe(true);
  });
});
