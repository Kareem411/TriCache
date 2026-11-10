import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Cluster as RedisCluster, Redis as RedisClient } from 'ioredis';
import { CacheService } from '../src/cache-service';
import { EdgeCacheService } from '../src/edge/cache';

function tempDir() {
  return join(tmpdir(), `tricache-hardening-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('Memory Leak, OOM, and Connection Hardening', () => {
  const caches: CacheService[] = [];
  const dirs: string[] = [];

  const track = (c: CacheService) => {
    caches.push(c);
    return c;
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    while (caches.length > 0) {
      await caches.pop()!.destroy();
    }
    while (dirs.length > 0) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('cleans up tagIndex and dependencyIndex on delete, wildcard delete, prefix clear, and L1 eviction', async () => {
    const cache = track(new CacheService({
      disableDisk: true,
      disableRedis: true,
      oomProtection: false,
      tagStrategy: 'set',
      l1MaxEntries: 3,
    }));

    const internals = cache as unknown as {
      tagIndex: Map<string, Set<string>>;
      keyTags: Map<string, { tags: string[]; expiresAt: number }>;
      dependencyIndex: Map<string, Set<string>>;
      keyDependencies: Map<string, string[]>;
      l1: { cleanup: () => number };
      _sweepExpiredMetadata: () => void;
    };

    await cache.set('a:1', 'v1', 60, undefined, { tags: ['tag-a'], dependsOn: ['src:*'] });
    await cache.set('a:2', 'v2', 60, undefined, { tags: ['tag-a', 'tag-b'], dependsOn: ['src:*'] });
    expect(internals.tagIndex.size).toBe(2);
    expect(internals.dependencyIndex.size).toBe(1);

    // Exact delete removes key from both tagIndex and dependencyIndex (and prunes empty sets)
    await cache.delete('a:1');
    expect(internals.tagIndex.get('_tag_:tag-a')?.has('a:1')).toBe(false);
    expect(internals.dependencyIndex.get('src:*')?.has('a:1')).toBe(false);

    // Wildcard delete removes matching keys and prunes empty tag sets
    await cache.delete('a:*');
    expect(internals.tagIndex.size).toBe(0);
    expect(internals.keyTags.size).toBe(0);
    expect(internals.dependencyIndex.size).toBe(0);
    expect(internals.keyDependencies.size).toBe(0);

    // Capacity eviction when disk is disabled immediately cleans tagIndex
    for (let i = 0; i < 6; i++) {
      await cache.set(`evict:${i}`, i, 60, undefined, { tags: [`evtag:${i}`], dependsOn: [`dep:${i}`] });
    }
    expect(internals.keyTags.size).toBeLessThanOrEqual(3);
    expect(internals.tagIndex.size).toBeLessThanOrEqual(3);
    expect(internals.dependencyIndex.size).toBeLessThanOrEqual(3);

    // Prefix clear removes matching tags, dependencies, and counters
    await cache.clear('evict:');
    expect(internals.tagIndex.size).toBe(0);
    expect(internals.dependencyIndex.size).toBe(0);
  });

  it('retains tagIndex for disk-spilled entries until invalidated or expired on disk', async () => {
    const dir = tempDir();
    dirs.push(dir);

    const cache = track(new CacheService({
      disableDisk: false,
      diskCacheDir: dir,
      disableRedis: true,
      oomProtection: false,
      tagStrategy: 'set',
      l1MaxEntries: 1,
    }));

    const internals = cache as unknown as {
      tagIndex: Map<string, Set<string>>;
      keyTags: Map<string, { tags: string[]; expiresAt: number }>;
      _sweepExpiredMetadata: () => void;
    };

    // Short TTL entry spilled to disk
    await cache.set('disk:short', 'v1', 0.02, undefined, { tags: ['short-tag'] });
    await cache.set('disk:keep', 'v2', 60, undefined, { tags: ['keep-tag'] });
    await new Promise(r => setTimeout(r, 30));

    // Before TTL sweep, short-tag stays indexed for disk-spill invalidation
    expect(internals.tagIndex.has('_tag_:keep-tag')).toBe(true);

    // After TTL elapses, metadata sweep cleans expired spilled tags
    await new Promise(r => setTimeout(r, 25));
    internals._sweepExpiredMetadata();
    expect(internals.keyTags.has('disk:short')).toBe(false);
    expect(internals.tagIndex.has('_tag_:short-tag')).toBe(false);
  });

  it('sweeps expired _l1Counters and resets matching prefixes on clear(prefix)', async () => {
    const cache = track(new CacheService({
      disableDisk: true,
      disableRedis: true,
      oomProtection: false,
    }));
    const internals = cache as unknown as {
      _l1Counters: Map<string, { value: number; expiresAt: number }>;
      _sweepExpiredMetadata: () => void;
    };

    await cache.increment('rl:exp', 0.02);
    await cache.increment('rl:keep', 60);
    await cache.increment('other:keep', 60);
    expect(internals._l1Counters.size).toBe(3);

    await new Promise(r => setTimeout(r, 35));
    internals._sweepExpiredMetadata();
    expect(internals._l1Counters.has('rl:exp')).toBe(false);
    expect(internals._l1Counters.size).toBe(2);

    await cache.clear('rl:');
    expect(internals._l1Counters.has('rl:keep')).toBe(false);
    expect(internals._l1Counters.has('other:keep')).toBe(true);
  });

  it('bounds EdgeCacheService.tagVersionCache to 10,000 entries', async () => {
    const edge = new EdgeCacheService();
    const internals = edge as unknown as {
      tagVersionCache: Map<string, { version: number; expiresAt: number }>;
      _setTagVersionCache: (tag: string, version: number, expiresAt: number) => void;
    };

    const future = Date.now() + 60_000;
    for (let i = 0; i < 10_250; i++) {
      internals._setTagVersionCache(`tag:${i}`, 1, future);
    }

    expect(internals.tagVersionCache.size).toBeLessThanOrEqual(10_000);
    expect(internals.tagVersionCache.has('tag:10249')).toBe(true);
  });

  it('triggers oomProtection eviction when container cgroup RSS ratio exceeds threshold', async () => {
    const cache = track(new CacheService({
      disableDisk: true,
      disableRedis: true,
      oomProtection: false,
      oomHeapThreshold: 0.85,
      oomEvictPercent: 0.5,
      l1MaxEntries: 100,
    }));

    for (let i = 0; i < 10; i++) {
      await cache.set(`item:${i}`, { payload: 'x'.repeat(64) }, 60);
    }

    // Simulate a 768 MB container cgroup limit while RSS is 700 MB (~91% > 85%)
    (cache as unknown as { _cgroupMemoryLimit: number })._cgroupMemoryLimit = 768 * 1024 * 1024;
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 700 * 1024 * 1024,
      heapTotal: 256 * 1024 * 1024,
      heapUsed: 128 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    });

    (cache as unknown as { _runOomCheck: () => void })._runOomCheck();

    const m = cache.metrics();
    expect(m.oom.evictions).toBe(1);
    expect(m.l1.entries).toBeLessThan(10);
  });

  it('chunks large Redis DEL operations and uses per-key pipeline DEL on RedisCluster', async () => {
    const cache = track(new CacheService({
      disableDisk: true,
      disableRedis: true,
      oomProtection: false,
    }));
    const deleteRedisKeys = (
      cache as unknown as { _deleteRedisKeys: (c: unknown, keys: string[]) => Promise<void> }
    )._deleteRedisKeys.bind(cache);

    // 1. Single-node chunking (> 1000 keys)
    const singleDelSizes: number[] = [];
    const singleClient = {
      del: vi.fn(async (...keys: string[]) => {
        singleDelSizes.push(keys.length);
        return keys.length;
      }),
    };
    const keys2500 = Array.from({ length: 2_500 }, (_, i) => `k:${i}`);
    await deleteRedisKeys(singleClient, keys2500);
    expect(singleDelSizes).toEqual([1_000, 1_000, 500]);

    // 2. RedisCluster per-key pipeline DEL (avoids CROSSSLOT)
    const pipeDeleted: string[] = [];
    let execCalls = 0;
    const clusterClient = Object.create(RedisCluster.prototype);
    clusterClient.pipeline = () => ({
      del(k: string) { pipeDeleted.push(k); return this; },
      async exec() { execCalls++; return []; },
    });
    clusterClient.del = vi.fn(() => { throw new Error('CROSSSLOT'); });

    await deleteRedisKeys(clusterClient, ['slotA:1', 'slotB:2', 'slotC:3']);
    expect(execCalls).toBe(1);
    expect(pipeDeleted).toEqual(['slotA:1', 'slotB:2', 'slotC:3']);
  });

  it('disconnects abandoned Redis client and clears timeout when initial connection fails', async () => {
    // Bind and immediately close an ephemeral TCP port so connection fails fast with ECONNREFUSED
    const srv = net.createServer();
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
    const port = (srv.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => srv.close(() => resolve()));

    const disconnectSpy = vi.spyOn(RedisClient.prototype, 'disconnect');

    const cache = track(new CacheService({
      disableDisk: true,
      disableRedis: false,
      redisHost: '127.0.0.1',
      redisPort: port,
      redisTls: false,
      invalidationBackplane: false,
      oomProtection: false,
    }));

    await expect((cache as unknown as { getRedis: () => Promise<unknown> }).getRedis()).rejects.toThrow();
    expect(disconnectSpy).toHaveBeenCalled();
    expect((cache as unknown as { redisConnecting: unknown }).redisConnecting).toBeNull();
  });
});

