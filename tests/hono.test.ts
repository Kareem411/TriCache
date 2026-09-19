import { describe, it, expect, afterEach, vi } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import { cacheMiddleware, createHonoMiddleware } from '../src/hono/index.js';
import { generateETag } from '../src/http/utils.js';

describe('Hono Node middleware (tricache/hono)', () => {
  let cache: CacheService | null = null;

  afterEach(async () => {
    if (cache) {
      await cache.destroy();
      cache = null;
    }
  });

  const mockHonoContext = (headers: Record<string, string> = {}, url = 'https://example.com/api/items') => {
    return {
      req: {
        method: 'GET',
        url,
        header: (name: string) => headers[name.toLowerCase()],
      },
      res: {
        status: 200 as number,
        clone: () => ({
          text: async () => JSON.stringify({ item: 1 }),
        }),
        headers: new Map([['content-type', 'application/json']]),
      },
      body: vi.fn((data, status, hdrs) => ({ data, status, headers: hdrs })),
    };
  };

  it('exports createHonoMiddleware as an alias of cacheMiddleware', () => {
    expect(createHonoMiddleware).toBe(cacheMiddleware);
  });

  it('serves a cache miss then a HIT with ETag headers without re-running the handler', async () => {
    cache = new CacheService({
      namespace: `hono-hit-${Date.now()}`,
      disableRedis: true,
    });

    const middleware = cacheMiddleware({ cache, ttl: 60 });
    let controllerCalls = 0;

    const c1 = mockHonoContext();
    await middleware(c1, async () => { controllerCalls++; });

    expect(controllerCalls).toBe(1);
    expect(c1.body).toHaveBeenCalledWith(
      JSON.stringify({ item: 1 }),
      200,
      expect.objectContaining({ ETag: expect.any(String), 'Content-Type': 'application/json' }),
    );

    const etag = (c1.body.mock.calls[0][2] as { ETag: string }).ETag;
    expect(etag).toBe(generateETag(JSON.stringify({ item: 1 })));

    const c2 = mockHonoContext();
    await middleware(c2, async () => { controllerCalls++; });

    expect(controllerCalls).toBe(1);
    expect(c2.body).toHaveBeenCalledWith(
      JSON.stringify({ item: 1 }),
      200,
      expect.objectContaining({ ETag: etag, 'Content-Type': 'application/json' }),
    );
  });

  it('intercepts Hono Context, generates ETag, and returns 304 Not Modified', async () => {
    cache = new CacheService({
      namespace: `hono-test-${Date.now()}`,
      disableRedis: true,
    });

    const middleware = cacheMiddleware({ cache, ttl: 60 });

    let controllerCalls = 0;

    const c1 = mockHonoContext();
    await middleware(c1, async () => { controllerCalls++; });
    expect(controllerCalls).toBe(1);
    expect(c1.body).toHaveBeenCalledWith(
      JSON.stringify({ item: 1 }),
      200,
      expect.objectContaining({ ETag: expect.any(String) }),
    );

    const etag = (c1.body.mock.calls[0][2] as { ETag: string }).ETag;

    const c2 = mockHonoContext({ 'if-none-match': etag });
    await middleware(c2, async () => { controllerCalls++; });
    expect(controllerCalls).toBe(1);
    expect(c2.body).toHaveBeenCalledWith(null, 304, { ETag: etag });
  });

  it('does not cache a 500 response and refetches on the next request', async () => {
    cache = new CacheService({
      namespace: `hono-err-${Date.now()}`,
      disableRedis: true,
    });
    const middleware = cacheMiddleware({ cache, ttl: 60 });

    let controllerCalls = 0;
    const makeCtx = () => ({
      req: {
        method: 'GET',
        url: 'https://example.com/api/flaky',
        header: (_name: string) => undefined,
      },
      res: {
        status: 200 as number,
        clone: () => ({
          text: async () => JSON.stringify(
            controllerCalls === 1 ? { error: 'upstream down' } : { item: 'ok' },
          ),
        }),
        headers: new Map([['content-type', 'application/json']]),
      },
      body: vi.fn(),
    });

    const c1 = makeCtx();
    await middleware(c1, async () => { controllerCalls++; c1.res.status = 500; });

    const c2 = makeCtx();
    await middleware(c2, async () => { controllerCalls++; c2.res.status = 200; });

    expect(controllerCalls).toBe(2);
    expect(c2.body).not.toHaveBeenCalledWith(
      expect.stringContaining('error'),
      200,
      expect.anything(),
    );
    expect(c2.body).toHaveBeenCalledWith(
      JSON.stringify({ item: 'ok' }),
      200,
      expect.objectContaining({ ETag: expect.any(String) }),
    );
  });

  it('uses CacheService.get with ttl, swr, and tags (Node path, not EdgeCacheService)', async () => {
    cache = new CacheService({
      namespace: `hono-opts-${Date.now()}`,
      disableRedis: true,
    });
    const getSpy = vi.spyOn(cache, 'get');
    const middleware = cacheMiddleware({
      cache,
      ttl: 42,
      swr: 7,
      tags: ['posts'],
    });

    const c = mockHonoContext();
    await middleware(c, async () => {});

    expect(getSpy).toHaveBeenCalled();
    const [, , ttl, opts] = getSpy.mock.calls[0];
    expect(ttl).toBe(42);
    expect(opts).toEqual(expect.objectContaining({ swr: 7, tags: ['posts'] }));
    getSpy.mockRestore();
  });

  it('skips caching for non-GET/HEAD methods', async () => {
    cache = new CacheService({
      namespace: `hono-post-${Date.now()}`,
      disableRedis: true,
    });
    const middleware = cacheMiddleware({ cache, ttl: 60 });
    let controllerCalls = 0;

    const postCtx = () => ({
      req: {
        method: 'POST',
        url: 'https://example.com/api/items',
        header: () => undefined,
      },
      res: {
        status: 200,
        clone: () => ({ text: async () => JSON.stringify({ n: controllerCalls }) }),
        headers: new Map([['content-type', 'application/json']]),
      },
      body: vi.fn(),
    });

    const c1 = postCtx();
    await middleware(c1, async () => { controllerCalls++; });
    const c2 = postCtx();
    await middleware(c2, async () => { controllerCalls++; });

    expect(controllerCalls).toBe(2);
    expect(c1.body).not.toHaveBeenCalled();
    expect(c2.body).not.toHaveBeenCalled();
  });
});
