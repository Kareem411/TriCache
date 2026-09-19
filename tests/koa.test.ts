import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import { createKoaMiddleware, koaCache, type KoaCacheContext } from '../src/koa/index.js';
import { generateETag } from '../src/http/utils.js';

function createMockKoaContext(
  url = '/api/data',
  headers: Record<string, string> = {},
  method = 'GET',
): KoaCacheContext & { resHeaders: Record<string, string> } {
  const reqHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    reqHeaders[k.toLowerCase()] = v;
  }
  const resHeaders: Record<string, string> = {};

  let status = 404;
  let body: unknown;

  const ctx: any = {
    method,
    url,
    originalUrl: url,
    headers: reqHeaders,
    type: undefined,
    resHeaders,
    get(name: string) {
      return reqHeaders[name.toLowerCase()];
    },
    set(name: string, value: string | number) {
      resHeaders[name.toLowerCase()] = String(value);
    },
    request: {
      method,
      url,
      headers: reqHeaders,
      header: reqHeaders,
    },
    response: {
      get(name: string) {
        return resHeaders[name.toLowerCase()];
      },
      set(name: string, value: string | number) {
        resHeaders[name.toLowerCase()] = String(value);
      },
    },
  };

  Object.defineProperty(ctx, 'status', {
    get: () => status,
    set: (code: number) => { status = code; },
    enumerable: true,
  });

  Object.defineProperty(ctx, 'body', {
    get: () => body,
    set: (value: unknown) => {
      body = value;
      // Koa promotes 404 → 200 when a body is assigned
      if (status === 404 && value !== undefined) {
        status = 200;
      }
    },
    enumerable: true,
  });

  return ctx;
}

describe('Koa Caching Middleware (tricache/koa)', () => {
  let cache: CacheService;
  let namespace: string;

  beforeEach(() => {
    namespace = `test_koa_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    cache = CacheService.create({
      namespace,
      disableRedis: true,
      disableDisk: true,
      invalidationBackplane: false,
    });
  });

  afterEach(async () => {
    await cache.destroy();
  });

  it('exports koaCache as an alias of createKoaMiddleware', () => {
    expect(koaCache).toBe(createKoaMiddleware);
  });

  it('serves a cache miss then a hit without re-running the downstream handler', async () => {
    const middleware = koaCache({ cache, ttl: 60 });
    let handlerCalls = 0;
    const payload = { id: 101, name: 'TriCache Koa' };

    const handler = async (ctx: KoaCacheContext) => {
      handlerCalls++;
      ctx.set?.('Content-Type', 'application/json; charset=utf-8');
      ctx.body = payload;
    };

    const ctx1 = createMockKoaContext('/api/product/101');
    await middleware(ctx1, async () => handler(ctx1));

    expect(handlerCalls).toBe(1);
    expect(ctx1.status).toBe(200);
    expect(ctx1.body).toEqual(payload);
    expect(ctx1.resHeaders['etag']).toBeDefined();
    const firstEtag = ctx1.resHeaders['etag'];

    const ctx2 = createMockKoaContext('/api/product/101');
    await middleware(ctx2, async () => handler(ctx2));

    expect(handlerCalls).toBe(1);
    expect(ctx2.status).toBe(200);
    expect(ctx2.body).toEqual(payload);
    expect(ctx2.resHeaders['etag']).toBe(firstEtag);
  });

  it('returns 304 Not Modified when If-None-Match matches the cached ETag', async () => {
    const middleware = koaCache({ cache, ttl: 60 });
    const payload = { text: 'sample document' };

    const ctx1 = createMockKoaContext('/api/doc/42');
    await middleware(ctx1, async () => {
      ctx1.body = payload;
    });

    const etag = ctx1.resHeaders['etag'];
    expect(etag).toBeDefined();
    expect(etag).toBe(generateETag(payload));

    let handlerCalled = false;
    const ctx2 = createMockKoaContext('/api/doc/42', { 'if-none-match': etag });
    await middleware(ctx2, async () => {
      handlerCalled = true;
    });

    expect(handlerCalled).toBe(false);
    expect(ctx2.status).toBe(304);
    expect(ctx2.body).toBeNull();
    expect(ctx2.resHeaders['etag']).toBe(etag);
  });

  it('skips caching for non-GET/HEAD methods', async () => {
    const middleware = koaCache({ cache, ttl: 60 });
    let handlerCalls = 0;

    const runPost = async () => {
      const ctx = createMockKoaContext('/api/writes', {}, 'POST');
      await middleware(ctx, async () => {
        handlerCalls++;
        ctx.body = { count: handlerCalls };
      });
      return ctx;
    };

    const first = await runPost();
    const second = await runPost();

    expect(handlerCalls).toBe(2);
    expect(first.body).toEqual({ count: 1 });
    expect(second.body).toEqual({ count: 2 });
    expect(first.resHeaders['etag']).toBeUndefined();
  });

  it('bypasses cache when skipCache returns true', async () => {
    const middleware = koaCache({
      cache,
      ttl: 60,
      skipCache: (ctx) => Boolean(ctx.get?.('authorization')),
    });
    let handlerCalls = 0;

    const ctx1 = createMockKoaContext('/api/profile');
    await middleware(ctx1, async () => {
      handlerCalls++;
      ctx1.body = { n: handlerCalls };
    });
    expect(ctx1.body).toEqual({ n: 1 });

    const ctx2 = createMockKoaContext('/api/profile', { authorization: 'Bearer secret' });
    await middleware(ctx2, async () => {
      handlerCalls++;
      ctx2.body = { n: handlerCalls };
    });
    expect(handlerCalls).toBe(2);
    expect(ctx2.body).toEqual({ n: 2 });
  });

  it('bypasses cache when Cache-Control: no-cache is provided', async () => {
    const middleware = koaCache({ cache, ttl: 60 });
    let handlerCalls = 0;

    const ctx1 = createMockKoaContext('/api/counter');
    await middleware(ctx1, async () => {
      handlerCalls++;
      ctx1.body = { count: handlerCalls };
    });
    expect(ctx1.body).toEqual({ count: 1 });

    const ctx2 = createMockKoaContext('/api/counter', { 'cache-control': 'no-cache' });
    await middleware(ctx2, async () => {
      handlerCalls++;
      ctx2.body = { count: handlerCalls };
    });
    expect(handlerCalls).toBe(2);
    expect(ctx2.body).toEqual({ count: 2 });
  });

  it('does not cache 4xx or 5xx responses', async () => {
    const middleware = koaCache({ cache, ttl: 60 });
    let handlerCalls = 0;

    const run = async (status: number, body: unknown) => {
      const ctx = createMockKoaContext('/api/flaky');
      await middleware(ctx, async () => {
        handlerCalls++;
        ctx.status = status;
        ctx.body = body;
      });
      return ctx;
    };

    const first = await run(500, { error: 'upstream down' });
    const second = await run(200, { message: 'recovered' });

    expect(first.status).toBe(500);
    expect(handlerCalls).toBe(2);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ message: 'recovered' });
  });

  it('forwards ttl, swr, and tags into CacheService.get', async () => {
    const getSpy = vi.spyOn(cache, 'get');
    const middleware = koaCache({
      cache,
      ttl: 42,
      swr: 7,
      tags: ['products'],
    });

    const ctx = createMockKoaContext('/api/ttl');
    await middleware(ctx, async () => {
      ctx.body = { ok: true };
    });

    expect(getSpy).toHaveBeenCalled();
    const [, , ttl, opts] = getSpy.mock.calls[0];
    expect(ttl).toBe(42);
    expect(opts).toEqual(expect.objectContaining({ swr: 7, tags: ['products'] }));
    getSpy.mockRestore();
  });

  it('honors the Koa-native key option from the public API', async () => {
    const getSpy = vi.spyOn(cache, 'get');
    const middleware = koaCache({
      cache,
      ttl: 60,
      key: (ctx) => `koa:${ctx.url}`,
    });

    const ctx = createMockKoaContext('/custom/path?b=2&a=1');
    await middleware(ctx, async () => {
      ctx.body = { keyed: true };
    });

    expect(getSpy.mock.calls[0][0]).toBe('koa:/custom/path?b=2&a=1');
    getSpy.mockRestore();
  });

  it('still caches HEAD requests (safe method)', async () => {
    const middleware = koaCache({ cache, ttl: 60 });
    let handlerCalls = 0;

    const ctx1 = createMockKoaContext('/api/meta', {}, 'HEAD');
    await middleware(ctx1, async () => {
      handlerCalls++;
      ctx1.body = { meta: true };
    });

    const ctx2 = createMockKoaContext('/api/meta', {}, 'HEAD');
    await middleware(ctx2, async () => {
      handlerCalls++;
      ctx2.body = { meta: true };
    });

    expect(handlerCalls).toBe(1);
    expect(ctx2.body).toEqual({ meta: true });
  });
});
