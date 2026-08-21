import { describe, it, expect, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import { TriCacheStore } from '../src/nestjs/tricache.store.js';
import { TriCacheModule } from '../src/nestjs/tricache.module.js';
import { TRICACHE_SERVICE, CACHE_MANAGER } from '../src/nestjs/types.js';

describe('NestJS Adapter (tricache/nestjs)', () => {
  let cache: CacheService | null = null;

  afterEach(async () => {
    if (cache) {
      await cache.destroy();
      cache = null;
    }
  });

  describe('TriCacheStore', () => {
    it('implements get, set, del, reset conforming to CacheStore', async () => {
      cache = CacheService.create({
        namespace: `nest-test-${Date.now()}`,
        disableRedis: true,
      });
      const store = new TriCacheStore(cache);

      // get miss returns undefined
      const miss = await store.get('nonexistent');
      expect(miss).toBeUndefined();

      // set and get
      await store.set('user:1', { name: 'Alice', role: 'admin' }, 5000);
      const hit = await store.get<{ name: string; role: string }>('user:1');
      expect(hit).toEqual({ name: 'Alice', role: 'admin' });

      // del
      await store.del('user:1');
      const afterDel = await store.get('user:1');
      expect(afterDel).toBeUndefined();

      // reset
      await store.set('a', 1);
      await store.set('b', 2);
      await store.reset();
      expect(await store.get('a')).toBeUndefined();
      expect(await store.get('b')).toBeUndefined();
    });

    it('converts millisecond TTL to seconds accurately for TriCache engine', async () => {
      cache = CacheService.create({
        namespace: `nest-ttl-${Date.now()}`,
        disableRedis: true,
      });
      const store = new TriCacheStore(cache);

      // 60,000 ms -> 60 seconds
      await store.set('session:123', { token: 'xyz' }, 60_000);
      const remainingMs = await store.ttl('session:123');
      expect(remainingMs).toBeDefined();
      expect(remainingMs!).toBeGreaterThan(50_000);
      expect(remainingMs!).toBeLessThanOrEqual(60_000);
    });

    it('supports batch operations mget, mset, and mdel', async () => {
      cache = CacheService.create({
        namespace: `nest-batch-${Date.now()}`,
        disableRedis: true,
      });
      const store = new TriCacheStore(cache);

      await store.mset([
        { key: 'p:1', value: 'apple', ttl: 10_000 },
        { key: 'p:2', value: 'banana', ttl: 10_000 },
        { key: 'p:3', value: 'cherry' },
      ]);

      const results = await store.mget<string>('p:1', 'p:2', 'p:3', 'p:4');
      expect(results).toEqual(['apple', 'banana', 'cherry', undefined]);

      await store.mdel('p:1', 'p:3');
      const afterMdel = await store.mget<string>('p:1', 'p:2', 'p:3');
      expect(afterMdel).toEqual([undefined, 'banana', undefined]);
    });

    it('scans keys matching pattern filter', async () => {
      cache = CacheService.create({
        namespace: `nest-keys-${Date.now()}`,
        disableRedis: true,
      });
      const store = new TriCacheStore(cache);

      await store.set('user:profile:1', 'u1');
      await store.set('user:profile:2', 'u2');
      await store.set('order:item:1', 'o1');

      const allKeys = await store.keys();
      expect(allKeys).toContain('user:profile:1');
      expect(allKeys).toContain('user:profile:2');
      expect(allKeys).toContain('order:item:1');

      const userKeys = await store.keys('user:');
      expect(userKeys).toContain('user:profile:1');
      expect(userKeys).toContain('user:profile:2');
      expect(userKeys).not.toContain('order:item:1');
    });
  });

  describe('TriCacheModule', () => {
    it('creates dynamic module with synchronous register()', () => {
      const dynamicModule = TriCacheModule.register({
        namespace: 'sync-nest-app',
        disableRedis: true,
      });

      expect(dynamicModule.module).toBe(TriCacheModule);
      expect(dynamicModule.global).toBe(true);
      expect(dynamicModule.providers?.length).toBe(2);
      expect(dynamicModule.exports).toContain(TRICACHE_SERVICE);
      expect(dynamicModule.exports).toContain(CACHE_MANAGER);

      const serviceProvider = dynamicModule.providers!.find(
        (p: any) => p.provide === TRICACHE_SERVICE,
      ) as any;
      expect(serviceProvider.useValue).toBeInstanceOf(CacheService);

      const managerProvider = dynamicModule.providers!.find(
        (p: any) => p.provide === CACHE_MANAGER,
      ) as any;
      expect(managerProvider.useValue).toBeInstanceOf(TriCacheStore);
    });

    it('creates dynamic module with registerAsync() useFactory', async () => {
      const dynamicModule = TriCacheModule.registerAsync({
        useFactory: async () => ({
          namespace: 'async-nest-app',
          disableRedis: true,
        }),
      });

      expect(dynamicModule.module).toBe(TriCacheModule);
      expect(dynamicModule.global).toBe(true);
      expect(dynamicModule.exports).toContain(TRICACHE_SERVICE);
      expect(dynamicModule.exports).toContain(CACHE_MANAGER);

      const factoryProvider = dynamicModule.providers!.find(
        (p: any) => p.provide === TRICACHE_SERVICE,
      ) as any;
      expect(factoryProvider.useFactory).toBeDefined();

      const createdCache = await factoryProvider.useFactory();
      expect(createdCache).toBeInstanceOf(CacheService);

      const managerFactoryProvider = dynamicModule.providers!.find(
        (p: any) => p.provide === CACHE_MANAGER,
      ) as any;
      const store = managerFactoryProvider.useFactory(createdCache);
      expect(store).toBeInstanceOf(TriCacheStore);

      await createdCache.destroy();
    });
  });
});
