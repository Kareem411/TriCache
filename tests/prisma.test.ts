import { describe, it, expect, vi } from 'vitest';
import { generatePrismaCacheKey, withTriCache } from '../src/prisma/index';

describe('prisma integration', () => {
  describe('generatePrismaCacheKey', () => {
    it('generates deterministic sha-256 keys for queries regardless of object key order', () => {
      const args1 = { where: { email: 'test@example.com', active: true } };
      const args2 = { where: { active: true, email: 'test@example.com' } };

      const k1 = generatePrismaCacheKey('User', 'findUnique', args1);
      const k2 = generatePrismaCacheKey('User', 'findUnique', args2);

      expect(k1).toBe(k2);
      expect(k1).toMatch(/^prisma:user:findUnique:[a-f0-9]{32}$/);
    });

    it('generates distinct keys for different models, operations, or arguments', () => {
      const k1 = generatePrismaCacheKey('User', 'findMany', { take: 10 });
      const k2 = generatePrismaCacheKey('User', 'findMany', { take: 20 });
      const k3 = generatePrismaCacheKey('Post', 'findMany', { take: 10 });
      const k4 = generatePrismaCacheKey('User', 'count', { take: 10 });

      expect(k1).not.toBe(k2);
      expect(k1).not.toBe(k3);
      expect(k1).not.toBe(k4);
    });

    it('handles nested structures, arrays, and primitives correctly', () => {
      const args = {
        include: { posts: true },
        where: {
          id: { in: [1, 2, 3] },
          meta: null,
          verified: false,
        },
      };

      const key = generatePrismaCacheKey('User', 'findMany', args);
      expect(key).toContain('prisma:user:findMany:');
    });
  });

  describe('withTriCache', () => {
    it('creates extension and wraps read operations with cache.wrap', async () => {
      const mockCache: any = {
        wrap: vi.fn().mockImplementation(async (key, fn, _opts) => await fn()),
        invalidateTag: vi.fn().mockResolvedValue(undefined),
      };

      const extension = withTriCache({
        cache: mockCache,
        defaultTtl: 120,
      });

      const opHandler = extension.query.$allModels.$allOperations;
      const queryFn = vi.fn().mockResolvedValue([{ id: 1, name: 'Alice' }]);

      const result = await opHandler({
        model: 'User',
        operation: 'findMany',
        args: {
          where: { active: true },
          cache: { ttl: 60, swr: 30, tags: ['custom-tag'] },
        },
        query: queryFn,
      });

      expect(result).toEqual([{ id: 1, name: 'Alice' }]);
      expect(mockCache.wrap).toHaveBeenCalledTimes(1);

      // Verify that query was called with cleanArgs (without `cache` property)
      expect(queryFn).toHaveBeenCalledWith({ where: { active: true } });

      const [key, , opts] = mockCache.wrap.mock.calls[0];
      expect(key).toContain('prisma:user:findMany:');
      expect(opts.ttl).toBe(60);
      expect(opts.swr).toBe(30);
      expect(opts.tags).toEqual(expect.arrayContaining(['user', 'custom-tag']));
    });

    it('auto-invalidates model tag on mutation operations and strips cache option', async () => {
      const mockCache: any = {
        wrap: vi.fn(),
        invalidateTag: vi.fn().mockResolvedValue(undefined),
      };

      const extension = withTriCache({
        cache: mockCache,
        autoInvalidate: true,
      });

      const opHandler = extension.query.$allModels.$allOperations;
      const queryFn = vi.fn().mockResolvedValue({ id: 10, title: 'New Post' });

      const result = await opHandler({
        model: 'Post',
        operation: 'create',
        args: {
          data: { title: 'New Post' },
          cache: false as any,
        },
        query: queryFn,
      });

      expect(result).toEqual({ id: 10, title: 'New Post' });
      // Stripped cache property
      expect(queryFn).toHaveBeenCalledWith({ data: { title: 'New Post' } });
      // Invalidated model tag
      expect(mockCache.invalidateTag).toHaveBeenCalledWith('post');
      expect(mockCache.wrap).not.toHaveBeenCalled();
    });

    it('passes through queries without caching when autoCache is false and cache option is omitted', async () => {
      const mockCache: any = {
        wrap: vi.fn(),
        invalidateTag: vi.fn(),
      };

      const extension = withTriCache({
        cache: mockCache,
        autoCache: false,
      });

      const opHandler = extension.query.$allModels.$allOperations;
      const queryFn = vi.fn().mockResolvedValue([]);

      await opHandler({
        model: 'User',
        operation: 'findMany',
        args: { where: { active: true } },
        query: queryFn,
      });

      expect(queryFn).toHaveBeenCalledWith({ where: { active: true } });
      expect(mockCache.wrap).not.toHaveBeenCalled();
    });

    it('automatically caches read queries when autoCache is true', async () => {
      const mockCache: any = {
        wrap: vi.fn().mockImplementation(async (_key, fn) => await fn()),
      };

      const extension = withTriCache({
        cache: mockCache,
        defaultTtl: 300,
        autoCache: true,
      });

      const opHandler = extension.query.$allModels.$allOperations;
      const queryFn = vi.fn().mockResolvedValue([{ id: 1 }]);

      await opHandler({
        model: 'User',
        operation: 'findMany',
        args: { take: 5 },
        query: queryFn,
      });

      expect(mockCache.wrap).toHaveBeenCalledTimes(1);
      const [, , opts] = mockCache.wrap.mock.calls[0];
      expect(opts.ttl).toBe(300);
    });
  });
});
