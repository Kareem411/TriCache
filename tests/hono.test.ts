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

  it('does not overwrite stale valid cache with 500 response during SWR revalidation', async () => {
    cache = new CacheService({
      namespace: `hono-swr-err-${Date.now()}`,
      disableRedis: true,
      ttlJitterFactor: 0,
    });
    const middleware = cacheMiddleware({ cache, ttl: 1, swr: 60 });
    let controllerCalls = 0;
    let returnStatus = 200;

    const makeCtx = () => ({
      req: {
        method: 'GET',
        url: 'https://example.com/api/swr-test',
        header: () => undefined,
      },
      res: {
        status: returnStatus,
        clone: () => ({
          text: async () => JSON.stringify(
            returnStatus === 200 ? { data: 'healthy' } : { error: 'upstream failure' }
          ),
        }),
        headers: new Map([['content-type', 'application/json']]),
      },
      body: vi.fn(),
    });

    // Request 1: populate cache with 200 OK
    const c1 = makeCtx();
    await middleware(c1, async () => {
      controllerCalls++;
      c1.res.status = 200;
    });
    expect(controllerCalls).toBe(1);

    // Wait 1.1s for TTL to expire, entering SWR window
    await new Promise((r) => setTimeout(r, 1100));

    // Request 2: upstream fails with 500
    returnStatus = 500;
    const c2 = makeCtx();
    await middleware(c2, async () => {
      controllerCalls++;
      c2.res.status = 500;
    });

    // Request 2 should have served the stale healthy data
    expect(c2.body).toHaveBeenCalledWith(
      JSON.stringify({ data: 'healthy' }),
      200,
      expect.anything(),
    );

    // Request 3: verify the cache was NOT poisoned with 500
    returnStatus = 200;
    const c3 = makeCtx();
    await middleware(c3, async () => {
      controllerCalls++;
      c3.res.status = 200;
    });

    // Cache serves healthy data, NOT the 500 error!
    expect(c3.body).toHaveBeenCalledWith(
      JSON.stringify({ data: 'healthy' }),
      200,
      expect.anything(),
    );
  });

  it('does not cache responses with response-level Cache-Control: no-store or private', async () => {
    cache = new CacheService({
      namespace: `hono-nostore-${Date.now()}`,
      disableRedis: true,
    });
    const middleware = cacheMiddleware({ cache, ttl: 60 });
    let controllerCalls = 0;

    const makeCtx = (headers: Map<string, string>) => ({
      req: {
        method: 'GET',
        url: 'https://example.com/api/private-data',
        header: () => undefined,
      },
      res: {
        status: 200,
        clone: () => ({
          text: async () => JSON.stringify({ token: `secret-${controllerCalls}` }),
        }),
        headers,
      },
      body: vi.fn(),
    });

    const c1 = makeCtx(new Map([
      ['content-type', 'application/json'],
      ['cache-control', 'no-store, private'],
    ]));
    await middleware(c1, async () => { controllerCalls++; });
    expect(controllerCalls).toBe(1);

    const c2 = makeCtx(new Map([
      ['content-type', 'application/json'],
      ['cache-control', 'no-store, private'],
    ]));
    await middleware(c2, async () => { controllerCalls++; });
    // Because c1 set no-store, c2 must trigger a fresh controller call!
    expect(controllerCalls).toBe(2);
  });

  it('never buffers or caches SSE streaming responses (text/event-stream)', async () => {
    cache = new CacheService({
      namespace: `hono-sse-${Date.now()}`,
      disableRedis: true,
    });
    const middleware = cacheMiddleware({ cache, ttl: 60 });
    let controllerCalls = 0;
    let cloneTextCalled = false;

    const makeSseCtx = () => ({
      req: {
        method: 'GET',
        url: 'https://example.com/api/sse-events',
        header: () => undefined,
      },
      res: {
        status: 200,
        clone: () => ({
          text: async () => {
            cloneTextCalled = true;
            return 'data: hello\n\n';
          },
        }),
        headers: new Map([['content-type', 'text/event-stream']]),
      },
      body: vi.fn(),
    });

    const c1 = makeSseCtx();
    await middleware(c1, async () => { controllerCalls++; });

    expect(controllerCalls).toBe(1);
    // clone().text() must NEVER be called on open event streams
    expect(cloneTextCalled).toBe(false);

    const c2 = makeSseCtx();
    await middleware(c2, async () => { controllerCalls++; });
    expect(controllerCalls).toBe(2);
  });

  it('does not cache 206 Partial Content responses', async () => {
    cache = new CacheService({
      namespace: `hono-206-${Date.now()}`,
      disableRedis: true,
    });
    const middleware = cacheMiddleware({ cache, ttl: 60 });
    let controllerCalls = 0;

    const makePartialCtx = () => ({
      req: {
        method: 'GET',
        url: 'https://example.com/video.mp4',
        header: () => undefined,
      },
      res: {
        status: 206,
        clone: () => ({ text: async () => 'bytes 0-100' }),
        headers: new Map([['content-type', 'video/mp4']]),
      },
      body: vi.fn(),
    });

    const c1 = makePartialCtx();
    await middleware(c1, async () => { controllerCalls++; });
    expect(controllerCalls).toBe(1);

    const c2 = makePartialCtx();
    await middleware(c2, async () => { controllerCalls++; });
    expect(controllerCalls).toBe(2);
  });

  it('preserves downstream custom headers on cache hit', async () => {
    cache = new CacheService({
      namespace: `hono-hdrs-${Date.now()}`,
      disableRedis: true,
    });
    const middleware = cacheMiddleware({ cache, ttl: 60 });
    let controllerCalls = 0;

    const makeCtx = () => ({
      req: {
        method: 'GET',
        url: 'https://example.com/api/custom-headers',
        header: () => undefined,
      },
      res: {
        status: 200,
        clone: () => ({ text: async () => JSON.stringify({ ok: true }) }),
        headers: new Map([
          ['content-type', 'application/json'],
          ['x-custom-header', 'tricache-value'],
          ['access-control-allow-origin', '*'],
        ]),
      },
      body: vi.fn(),
    });

    const c1 = makeCtx();
    await middleware(c1, async () => { controllerCalls++; });
    expect(controllerCalls).toBe(1);

    const c2 = makeCtx();
    await middleware(c2, async () => { controllerCalls++; });
    expect(controllerCalls).toBe(1);
    expect(c2.body).toHaveBeenCalledWith(
      JSON.stringify({ ok: true }),
      200,
      expect.objectContaining({
        'x-custom-header': 'tricache-value',
        'access-control-allow-origin': '*',
        'Content-Type': 'application/json',
      }),
    );
  });

  it('allows coalesced concurrent requests to fall back to next() if in-flight request fails', async () => {
    cache = new CacheService({
      namespace: `hono-coalesce-${Date.now()}`,
      disableRedis: true,
    });
    const middleware = cacheMiddleware({ cache, ttl: 60 });
    let req1Resolve: () => void;
    const req1Gate = new Promise<void>((r) => { req1Resolve = r; });

    const c1 = {
      req: { method: 'GET', url: 'https://example.com/api/shared', header: () => undefined },
      res: {
        status: 500,
        clone: () => ({ text: async () => JSON.stringify({ error: 'req1 failed' }) }),
        headers: new Map([['content-type', 'application/json']]),
      },
      body: vi.fn(),
    };

    const c2 = {
      req: { method: 'GET', url: 'https://example.com/api/shared', header: () => undefined },
      res: {
        status: 200,
        clone: () => ({ text: async () => JSON.stringify({ success: 'req2 ok' }) }),
        headers: new Map([['content-type', 'application/json']]),
      },
      body: vi.fn(),
    };

    let c2CalledNext = false;

    // Start request 1 (will pause inside next)
    const p1 = middleware(c1, async () => {
      await req1Gate;
      c1.res.status = 500;
    });

    // Start request 2 concurrently while req 1 is in-flight (coalescing)
    const p2 = middleware(c2, async () => {
      c2CalledNext = true;
      c2.res.status = 200;
    });

    // Let req1 complete with 500
    req1Resolve!();
    await Promise.all([p1, p2]);

    // Request 2 was coalesced onto req1, but because req1 failed with 500,
    // req2 must have safely fallen back to running its own next()!
    expect(c2CalledNext).toBe(true);
    expect(c2.res.status).toBe(200);
  });
});
