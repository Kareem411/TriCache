import { describe, it, expect, afterEach, vi } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import { withTriCache } from '../src/prisma/index.js';
import { withCache } from '../src/drizzle/index.js';

describe('First-Class ORM Adapters (Prisma & Drizzle)', () => {
  let cache: CacheService | null = null;

  afterEach(async () => {
    if (cache) {
      await cache.destroy();
      cache = null;
    }
  });

  describe('Prisma Client Extension (withTriCache)', () => {
    it('intercepts reads, caches queries, and automatically invalidates model tags on writes', async () => {
      cache = new CacheService({
        namespace: `prisma-test-${Date.now()}`,
        disableRedis: true,
      });

      const extension = withTriCache({
        cache,
        defaultTtl: 300,
        autoInvalidate: true,
      });

      const queryHandler = extension.query.$allModels.$allOperations;

      let dbFindManyCalls = 0;
      const mockFindMany = vi.fn(async () => {
        dbFindManyCalls++;
        return [
          { id: 1, name: 'Alpha' },
          { id: 2, name: 'Beta' },
        ];
      });

      // 1. First read query with caching enabled
      const res1 = await queryHandler({
        model: 'User',
        operation: 'findMany',
        args: { where: { active: true }, cache: { ttl: 60 } },
        query: mockFindMany,
      });

      expect(res1).toHaveLength(2);
      expect(dbFindManyCalls).toBe(1);

      // 2. Second identical read query hits L1 RAM cache (no DB call)
      const res2 = await queryHandler({
        model: 'User',
        operation: 'findMany',
        args: { where: { active: true }, cache: { ttl: 60 } },
        query: mockFindMany,
      });

      expect(res2).toEqual(res1);
      expect(dbFindManyCalls).toBe(1); // Still 1 hit

      // 3. Perform a mutation (create) — triggers automatic model tag invalidation ('user')
      const mockCreate = vi.fn(async (args: any) => ({ id: 3, ...args.data }));
      await queryHandler({
        model: 'User',
        operation: 'create',
        args: { data: { name: 'Gamma' } },
        query: mockCreate,
      });

      // 4. Third read query misses cache because 'user' tag was invalidated by create
      const res3 = await queryHandler({
        model: 'User',
        operation: 'findMany',
        args: { where: { active: true }, cache: { ttl: 60 } },
        query: mockFindMany,
      });

      expect(res3).toHaveLength(2);
      expect(dbFindManyCalls).toBe(2); // Re-fetched fresh data from DB
    });
  });

  describe('Drizzle ORM Wrapper (withCache)', () => {
    it('automatically generates deterministic cache key from SQL + params and caches results', async () => {
      cache = new CacheService({
        namespace: `drizzle-test-${Date.now()}`,
        disableRedis: true,
      });

      let dbExecutions = 0;
      const mockDrizzleQuery = {
        toSQL: () => ({
          sql: 'SELECT * FROM users WHERE active = $1',
          params: [true],
        }),
        execute: vi.fn(async () => {
          dbExecutions++;
          return [{ id: 1, email: 'user@example.com' }];
        }),
      };

      // 1. First execution
      const res1 = await withCache(mockDrizzleQuery, {
        cache,
        ttl: 60,
        tags: ['users'],
      });

      expect(res1).toEqual([{ id: 1, email: 'user@example.com' }]);
      expect(dbExecutions).toBe(1);

      // 2. Second execution hits cache
      const res2 = await withCache(mockDrizzleQuery, {
        cache,
        ttl: 60,
        tags: ['users'],
      });

      expect(res2).toEqual(res1);
      expect(dbExecutions).toBe(1);

      // 3. Invalidate tag
      await cache.invalidateTag('users');

      // 4. Third execution misses cache
      const res3 = await withCache(mockDrizzleQuery, {
        cache,
        ttl: 60,
        tags: ['users'],
      });

      expect(res3).toEqual(res1);
      expect(dbExecutions).toBe(2);
    });
  });
});
