import { describe, it, expect, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service';
import TriCacheHandler from '../src/next/cache-handler';
import { EdgeCacheService } from '../src/edge/cache';

function createSharedMockRedisCluster() {
  const kvStore = new Map<string, any>();
  const tagVersions = new Map<string, number>();
  const subscribers = new Set<(fields: string[]) => void>();

  const makeClient = () => {
    const client: any = {
      get: async (k: string) => {
        if (k.includes('tag_ver:')) {
          return tagVersions.has(k) ? String(tagVersions.get(k)) : null;
        }
        const v = kvStore.get(k);
        if (v && typeof v === 'object') {
          throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        }
        return v ?? null;
      },
      set: async (k: string, v: string) => {
        kvStore.set(k, v);
        return 'OK';
      },
      setex: async (k: string, _ttl: number, v: string) => {
        kvStore.set(k, v);
        return 'OK';
      },
      hgetall: async (k: string) => {
        const v = kvStore.get(k);
        if (typeof v === 'string') {
          throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        }
        return v ?? {};
      },
      hset: async (k: string, data: any) => {
        kvStore.set(k, data);
        return 1;
      },
      incr: async (k: string) => {
        const next = (tagVersions.get(k) ?? 0) + 1;
        tagVersions.set(k, next);
        return next;
      },
      del: async (...keys: string[]) => {
        let count = 0;
        for (const k of keys) {
          if (kvStore.delete(k)) count++;
        }
        return count;
      },
      scan: async (_cursor: string, _matchKw: string, pattern: string) => {
        const re = new RegExp(
          '^' +
            pattern
              .replace(/[.+^${}()|[\]\\]/g, '\\$&')
              .replace(/\*/g, '.*')
              .replace(/\?/g, '.') +
            '$',
        );
        const matched: string[] = [];
        for (const k of tagVersions.keys()) {
          if (re.test(k)) matched.push(k);
        }
        for (const k of kvStore.keys()) {
          if (re.test(k)) matched.push(k);
        }
        return ['0', matched];
      },
      eval: async (_script: string, _numKeys: number, key: string, tsArg: string) => {
        const stored = kvStore.get(key);
        if (stored && typeof stored === 'object' && stored.t === tsArg) {
          kvStore.delete(key);
          return 1;
        }
        return 0;
      },
      xadd: async (_streamKey: string, ...args: string[]) => {
        const fields = args.slice(args.indexOf('*') + 1);
        for (const fn of subscribers) fn(fields);
        return `${Date.now()}-0`;
      },
      multi: () => {
        const ops: Array<() => [Error | null, any]> = [];
        return {
          get(k: string) {
            ops.push(() => {
              const v = kvStore.get(k);
              if (v && typeof v === 'object') {
                return [new Error('WRONGTYPE Operation against a key holding the wrong kind of value'), null];
              }
              return [null, v ?? null];
            });
            return this;
          },
          hgetall(k: string) {
            ops.push(() => {
              const v = kvStore.get(k);
              if (typeof v === 'string') {
                return [new Error('WRONGTYPE Operation against a key holding the wrong kind of value'), null];
              }
              return [null, v ?? {}];
            });
            return this;
          },
          hset(k: string, data: any) {
            ops.push(() => {
              kvStore.set(k, data);
              return [null, 1];
            });
            return this;
          },
          incr(k: string) {
            ops.push(() => {
              const next = (tagVersions.get(k) ?? 0) + 1;
              tagVersions.set(k, next);
              return [null, next];
            });
            return this;
          },
          expire() {
            ops.push(() => [null, 1]);
            return this;
          },
          async exec() {
            return ops.map(fn => fn());
          },
        };
      },
      pipeline() {
        return this.multi();
      },
      disconnect: async () => {},
      on: () => {},
      status: 'ready',
    };
    return client;
  };

  return {
    kvStore,
    tagVersions,
    makeClient,
    subscribeStream(fn: (fields: string[]) => void) {
      subscribers.add(fn);
    },
  };
}

describe('End-to-End Tag Invalidation, Stream Backplane & Churn Verification', () => {
  const cachesToDestroy: CacheService[] = [];

  afterEach(async () => {
    while (cachesToDestroy.length > 0) {
      await cachesToDestroy.pop()!.destroy();
    }
  });

  it('survives concurrent Next.js profile tag invalidation with hierarchicalTags, generational strategy, and stream backplane without stalling', async () => {
    const bus = createSharedMockRedisCluster();
    const ns = `rel-next-${Date.now()}`;

    const handlerA = new TriCacheHandler({
      namespace: ns,
      hierarchicalTags: true,
      tagStrategy: 'generational',
      backplaneMode: 'stream',
      awaitInvalidationBackplane: true,
      disableRedis: true,
      disableDisk: true,
      oomProtection: false,
      compression: 'none',
    });
    const handlerB = new TriCacheHandler({
      namespace: ns,
      hierarchicalTags: true,
      tagStrategy: 'generational',
      backplaneMode: 'stream',
      awaitInvalidationBackplane: true,
      disableRedis: true,
      disableDisk: true,
      oomProtection: false,
      compression: 'none',
    });

    const cacheA = (handlerA as unknown as { cache: CacheService }).cache;
    const cacheB = (handlerB as unknown as { cache: CacheService }).cache;
    cachesToDestroy.push(cacheA, cacheB);

    (cacheA as any).redis = bus.makeClient();
    (cacheA as any)._redisDisabled = false;
    (cacheB as any).redis = bus.makeClient();
    (cacheB as any)._redisDisabled = false;

    bus.subscribeStream((fields) => {
      (cacheB as unknown as { _processStreamEntry: (f: string[]) => void })._processStreamEntry(fields);
    });

    // Miss probes must not pollute L1 or Redis
    expect(await handlerB.get('missing:manifest')).toBeUndefined();
    expect(cacheB.has('missing:manifest')).toBe(false);
    expect(bus.kvStore.size).toBe(0);

    // Pod B populates entries with discrete, leaf, and hierarchical tags
    await handlerB.set('profile:42', Promise.resolve({ value: { name: 'Ada' }, tags: ['user:42', 'user-profile-42', 'user-profiles', 'user-data'] }));
    await handlerB.set('org:view', Promise.resolve({ value: { org: 'acme' }, tags: ['org:acme:user:42'] }));

    expect((await handlerB.get('profile:42'))?.value).toEqual({ name: 'Ada' });
    expect((await handlerB.get('org:view'))?.value).toEqual({ org: 'acme' });

    // Watchdog timer must still fire promptly (no microtask recursion starvation)
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
    }, 50);

    // Simulate PUT /api/user/profile invalidating all 4 tags concurrently on Pod A
    await Promise.all(
      ['user:42', 'user-profile-42', 'user-profiles', 'user-data'].map(tag => handlerA.updateTags([tag])),
    );
    // Also cascade-invalidate parent org tag from Pod A -> stream backplane tag_pattern_incr -> Pod B
    await cacheA.invalidateTag('org:acme');

    await new Promise(resolve => setTimeout(resolve, 70));
    clearTimeout(watchdog);

    expect(watchdogFired).toBe(true);
    expect(await handlerB.get('profile:42')).toBeUndefined();
    expect(await handlerB.get('org:view')).toBeUndefined();
    expect(await cacheB.peek('profile:42')).toBeNull();
    expect(await cacheB.mget(['profile:42', 'org:view'])).toEqual([undefined, undefined]);
  });

  it('maintains bounded indices under high-cardinality hierarchical churn and edge isolation', async () => {
    const cache = new CacheService({
      namespace: `rel-churn-${Date.now()}`,
      disableDisk: true,
      disableRedis: true,
      oomProtection: false,
      hierarchicalTags: true,
      tagStrategy: 'set',
      l1MaxEntries: 100,
    });
    cachesToDestroy.push(cache);

    const internals = cache as unknown as {
      tagIndex: Map<string, Set<string>>;
      keyTags: Map<string, { tags: string[]; expiresAt: number }>;
      dependencyIndex: Map<string, Set<string>>;
      keyDependencies: Map<string, string[]>;
    };

    for (let i = 0; i < 1_500; i++) {
      await cache.set(
        `churn:${i}`,
        { idx: i },
        60,
        undefined,
        {
          tags: [`tenant:${i % 200}:item:${i}`, `leaf-${i}`],
          dependsOn: [`parent:${i % 50}`],
        },
      );
      if (i % 7 === 0) {
        await cache.invalidateTag(`leaf-${i}`);
      }
      if (i % 15 === 0) {
        await cache.delete(`churn:${i - 1}`);
      }
    }

    await cache.delete('churn:14*');

    expect(cache.stats().l1.entries).toBeLessThanOrEqual(100);
    expect(internals.keyTags.size).toBeLessThanOrEqual(100);
    expect(internals.keyDependencies.size).toBeLessThanOrEqual(100);

    await cache.clear();
    expect(internals.tagIndex.size).toBe(0);
    expect(internals.keyTags.size).toBe(0);
    expect(internals.dependencyIndex.size).toBe(0);
    expect(internals.keyDependencies.size).toBe(0);

    // EdgeCacheService stays non-recursive and bounded under cascading + wildcard tags
    const edge = new EdgeCacheService({ namespace: 'rel-edge' });
    await edge.set('e:1', 'v1', 60, ['org:1:users', 'foo*']);
    await edge.invalidateTag('org:1', { cascade: true });
    await edge.invalidateTag('foo*');
    expect(await edge.get('e:1')).toBeNull();
  });
});

