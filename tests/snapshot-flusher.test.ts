import { describe, it, expect, afterEach } from 'vitest';
import { CacheService, ProcessTerminationBus } from '../src/cache-service.js';
import { createMemorySnapshotAdapter } from '../src/remote-snapshot.js';

describe('Pre-Baked Snapshot Flushers & Graceful Shutdown', () => {
  let instances: CacheService[] = [];
  const track = (c: CacheService) => {
    instances.push(c);
    return c;
  };

  afterEach(async () => {
    for (const inst of instances) {
      await inst.destroy();
    }
    instances = [];
  });

  it('flushSnapshotOnShutdown flushes remote snapshot cleanly during shutdown', async () => {
    const memoryAdapter = createMemorySnapshotAdapter();

    const cache = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      remoteSnapshot: {
        adapter: memoryAdapter,
      },
    }));

    await cache.set('app:state:123', { user: 'alice', permissions: ['read', 'write'] }, 3600);
    expect(memoryAdapter.getBuffer()).toBeNull();

    const ok = await cache.flushSnapshotOnShutdown();
    expect(ok).toBe(true);
    expect(memoryAdapter.getBuffer()).not.toBeNull();
    expect(memoryAdapter.getBuffer()!.length).toBeGreaterThan(0);
  });

  it('flushSnapshotOnShutdown aborts cleanly within timeout if remote adapter hangs', async () => {
    // Hanging adapter simulating network blackhole or EBS hang
    const hangingAdapter = {
      async get() { return null; },
      async put() {
        return new Promise<void>(() => {
          // never resolves
        });
      },
    };

    const cache = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      remoteSnapshot: {
        adapter: hangingAdapter,
      },
    }));

    await cache.set('key', 'value', 3600);

    const start = performance.now();
    const ok = await cache.flushSnapshotOnShutdown(100); // 100ms timeout
    const elapsed = performance.now() - start;

    expect(ok).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(1000);
  });

  it('flushSnapshotOnShutdown handles remote adapter throw gracefully', async () => {
    const throwingAdapter = {
      async get() { return null; },
      async put() {
        throw new Error('EHOSTUNREACH: Connection failed');
      },
    };

    const cache = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      remoteSnapshot: {
        adapter: throwingAdapter,
      },
    }));

    await cache.set('key', 'value', 3600);

    const ok = await cache.flushSnapshotOnShutdown();
    expect(ok).toBe(false);
  });

  it('ProcessTerminationBus.flushAll invokes flusher on all registered instances concurrently', async () => {
    const mem1 = createMemorySnapshotAdapter();
    const mem2 = createMemorySnapshotAdapter();

    const cache1 = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      remoteSnapshot: { adapter: mem1 },
    }));

    const cache2 = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      remoteSnapshot: { adapter: mem2 },
    }));

    await cache1.set('cache1:key', 'val1', 3600);
    await cache2.set('cache2:key', 'val2', 3600);

    expect(ProcessTerminationBus.size).toBe(2);

    await ProcessTerminationBus.flushAll(5000);

    expect(mem1.getBuffer()).not.toBeNull();
    expect(mem2.getBuffer()).not.toBeNull();
  });

  it('ProcessTerminationBus.flushAll is safe to call when no instances are registered', async () => {
    expect(ProcessTerminationBus.size).toBe(0);
    await expect(ProcessTerminationBus.flushAll()).resolves.toBeUndefined();
  });
});
