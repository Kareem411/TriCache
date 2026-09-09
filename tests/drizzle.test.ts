import { describe, it, expect, vi } from 'vitest';
import { generateDrizzleCacheKey, withCache } from '../src/drizzle/index';
import type { DrizzleExecutableQuery } from '../src/drizzle/index';

describe('drizzle integration', () => {
  describe('generateDrizzleCacheKey', () => {
    it('generates deterministic sha-256 keys for identical query sql and params', () => {
      const q1 = { sql: 'SELECT * FROM users WHERE id = $1', params: [42] };
      const q2 = { sql: 'SELECT * FROM users WHERE id = $1', params: [42] };

      const k1 = generateDrizzleCacheKey(q1);
      const k2 = generateDrizzleCacheKey(q2);

      expect(k1).toBe(k2);
      expect(k1).toMatch(/^drizzle:[a-f0-9]{32}$/);
    });

    it('generates different keys when params or sql differ', () => {
      const q1 = { sql: 'SELECT * FROM users WHERE id = $1', params: [42] };
      const q2 = { sql: 'SELECT * FROM users WHERE id = $1', params: [43] };
      const q3 = { sql: 'SELECT * FROM users WHERE active = $1', params: [42] };

      const k1 = generateDrizzleCacheKey(q1);
      const k2 = generateDrizzleCacheKey(q2);
      const k3 = generateDrizzleCacheKey(q3);

      expect(k1).not.toBe(k2);
      expect(k1).not.toBe(k3);
      expect(k2).not.toBe(k3);
    });
  });

  describe('withCache', () => {
    it('caches query execution via .execute() and passes options', async () => {
      const executeMock = vi.fn().mockResolvedValue([{ id: 1, name: 'Alice' }]);
      const mockQuery: DrizzleExecutableQuery<any> = {
        toSQL: () => ({ sql: 'SELECT id, name FROM users', params: [] }),
        execute: executeMock,
      };

      const mockCacheService: any = {
        wrap: vi.fn().mockImplementation(async (key, fn, _opts) => {
          return await fn();
        }),
      };

      const res = await withCache(mockQuery, {
        cache: mockCacheService,
        ttl: 60,
        swr: 30,
        tags: ['users'],
      });

      expect(res).toEqual([{ id: 1, name: 'Alice' }]);
      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(mockCacheService.wrap).toHaveBeenCalledTimes(1);

      const [calledKey, , calledOpts] = mockCacheService.wrap.mock.calls[0];
      expect(calledKey).toBe(generateDrizzleCacheKey(mockQuery.toSQL()));
      expect(calledOpts).toMatchObject({
        ttl: 60,
        swr: 30,
        tags: ['users'],
      });
    });

    it('supports thenable query objects without .execute()', async () => {
      const thenableQuery: any = {
        toSQL: () => ({ sql: 'SELECT count(*) FROM orders', params: [] }),
        // oxlint-disable-next-line unicorn/no-thenable
        then: (onfulfilled: any) => Promise.resolve({ count: 5 }).then(onfulfilled),
      };

      const mockCacheService: any = {
        wrap: vi.fn().mockImplementation(async (_key, fn) => await fn()),
      };

      const res = await withCache(thenableQuery, { cache: mockCacheService });
      expect(res).toEqual({ count: 5 });
    });

    it('uses explicit key if provided instead of computing from toSQL', async () => {
      const mockQuery: DrizzleExecutableQuery<any> = {
        toSQL: () => ({ sql: 'SELECT * FROM users', params: [] }),
        execute: vi.fn().mockResolvedValue([]),
      };

      const mockCacheService: any = {
        wrap: vi.fn().mockImplementation(async (_key, fn) => await fn()),
      };

      await withCache(mockQuery, {
        cache: mockCacheService,
        key: 'custom:drizzle:key',
      });

      expect(mockCacheService.wrap).toHaveBeenCalledWith(
        'custom:drizzle:key',
        expect.any(Function),
        expect.any(Object),
      );
    });

    it('throws when toSQL is missing and no explicit key is provided', async () => {
      const invalidQuery: any = {
        execute: vi.fn().mockResolvedValue([]),
      };

      await expect(withCache(invalidQuery)).rejects.toThrow(
        'tricache/drizzle: query must provide a .toSQL() method or an explicit key option.',
      );
    });

    it('throws when query has neither .execute nor .then', async () => {
      const unexecutableQuery: any = {
        toSQL: () => ({ sql: 'SELECT 1', params: [] }),
      };

      const mockCacheService: any = {
        wrap: vi.fn().mockImplementation(async (_key, fn) => await fn()),
      };

      await expect(
        withCache(unexecutableQuery, { cache: mockCacheService }),
      ).rejects.toThrow('tricache/drizzle: query is neither executable via .execute() nor thenable.');
    });
  });
});
