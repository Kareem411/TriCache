import { describe, it, expect, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service.js';

describe('Distributed Mutex & Lock Primitive (cache.lock)', () => {
  let cache: CacheService | null = null;

  afterEach(async () => {
    if (cache) {
      await cache.destroy();
      cache = null;
    }
  });

  it('ensures single-flight mutual exclusion across concurrent callers', async () => {
    cache = new CacheService({
      namespace: `lock-test-${Date.now()}`,
      disableRedis: true,
    });

    let running = 0;
    let maxConcurrent = 0;
    let completed = 0;

    const task = async (workerId: number) => {
      return await cache!.lock('cron:daily-aggregation', async () => {
        running++;
        maxConcurrent = Math.max(maxConcurrent, running);
        // Simulate asynchronous task work
        await new Promise(r => setTimeout(r, 20));
        running--;
        completed++;
        return `worker-${workerId}-done`;
      }, {
        acquireTimeout: 5000,
        retryInterval: 10,
      });
    };

    // 20 workers attempt to run the locked critical section simultaneously
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => task(i)),
    );

    expect(results).toHaveLength(20);
    expect(maxConcurrent).toBe(1); // Never exceeded 1 active worker at any instant
    expect(completed).toBe(20);
  });

  it('automatically releases lock when task throws an exception', async () => {
    cache = new CacheService({
      namespace: `lock-err-${Date.now()}`,
      disableRedis: true,
    });

    // Worker 1 acquires lock and fails
    await expect(
      cache.lock('resource:flaky', async () => {
        throw new Error('Database transaction aborted');
      }),
    ).rejects.toThrow('Database transaction aborted');

    // Worker 2 should immediately be able to acquire the lock without timeout
    const res = await cache.lock('resource:flaky', async () => {
      return 'recovered-successfully';
    }, { acquireTimeout: 1000 });

    expect(res).toBe('recovered-successfully');
  });

  it('throws timeout error when lock cannot be acquired within acquireTimeout', async () => {
    cache = new CacheService({
      namespace: `lock-timeout-${Date.now()}`,
      disableRedis: true,
    });

    // Start long-running lock
    const longRunning = cache.lock('resource:slow', async () => {
      await new Promise(r => setTimeout(r, 400));
      return 'slow-done';
    });

    // Immediate second lock attempt with acquireTimeout (100ms)
    await expect(
      cache.lock('resource:slow', async () => {
        return 'unreachable';
      }, {
        acquireTimeout: 100,
        retryInterval: 10,
      }),
    ).rejects.toThrow(/Failed to acquire lock for resource "resource:slow" within 100ms/);

    await longRunning;
  });
});
