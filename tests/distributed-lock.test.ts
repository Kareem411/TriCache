import { describe, it, expect, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service.js';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

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

  it('REDIS PATH: runs fn exactly once when fn throws — never falls back to local re-execution', async () => {
    // Real-looking host so the Redis branch executes; getRedis() is stubbed so
    // no network happens. (disableRedis would skip the buggy path entirely.)
    cache = new CacheService({
      namespace: `lock-redis-${Date.now()}`,
      redisHost: '127.0.0.1',
      disableRedis: false,
      invalidationBackplane: false,
      logger: silentLogger,
    });

    const calls: string[] = [];
    const fakeClient = {
      set: async (..._a: unknown[]) => { calls.push('acquire'); return 'OK'; },
      eval: async () => { calls.push('release'); return 1; },
    };
    (cache as unknown as { getRedis: () => Promise<unknown> }).getRedis =
      async () => fakeClient;

    let executions = 0;

    await expect(
      cache.lock('resource:billing-cron', async () => {
        executions++;
        throw new Error('Database transaction aborted');
      }, { acquireTimeout: 1000, retryInterval: 10 }),
    ).rejects.toThrow('Database transaction aborted');

    // THE invariant: a business failure must execute the critical section
    // EXACTLY once and propagate its error. The old control flow fell through
    // to the in-process mutex fallback and ran fn() a second time AFTER the
    // distributed lock had already been released (probe: "fn executed 2 time(s)").
    expect(executions).toBe(1);
    // Acquire + release happened on the Redis client…
    expect(calls.filter(c => c === 'acquire')).toHaveLength(1);
    expect(calls.filter(c => c === 'release')).toHaveLength(1);
    // …and release is the LAST operation — no second acquire may follow it.
    expect(calls[calls.length - 1]).toBe('release');
  });
});
