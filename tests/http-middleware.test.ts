import { describe, it, expect, afterEach, vi } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import { expressCache, honoCache, fastifyCache, generateETag } from '../src/http/index.js';

describe('HTTP Caching Middleware & ETag 304 (tricache/http)', () => {
  let cache: CacheService | null = null;

  afterEach(async () => {
    if (cache) {
      await cache.destroy();
      cache = null;
    }
  });

  describe('generateETag', () => {
    it('produces consistent weak ETags', () => {
      const tag1 = generateETag({ foo: 'bar' });
      const tag2 = generateETag({ foo: 'bar' });
      expect(tag1).toMatch(/^W\/"/);
      expect(tag1).toBe(tag2);
    });
  });

  describe('expressCache', () => {
    it('serves 200 on initial fetch and returns 304 on If-None-Match match', async () => {
      cache = new CacheService({
        namespace: `http-test-${Date.now()}`,
        disableRedis: true,
      });

      const middleware = expressCache({ cache, ttl: 60 });

      let handlerCalls = 0;
      const fakeHandler = (_req: any, res: any) => {
        handlerCalls++;
        res.json({ message: 'hello-world' });
      };

      // 1. Initial request (miss)
      const headers1: Record<string, string> = {};
      let statusCode1 = 200;
      let body1: any = null;

      const req1 = { method: 'GET', url: '/api/v1/users', headers: {} };
      const res1: any = {
        setHeader: (k: string, v: string) => { headers1[k.toLowerCase()] = v; },
        getHeader: (k: string) => headers1[k.toLowerCase()],
        status: (code: number) => { statusCode1 = code; return res1; },
        json: (data: any) => { body1 = data; },
        send: (data: any) => { body1 = data; },
        end: () => {},
        headersSent: false,
      };

      await middleware(req1, res1, () => fakeHandler(req1, res1));

      expect(handlerCalls).toBe(1);
      expect(statusCode1).toBe(200);
      expect(body1).toEqual({ message: 'hello-world' });
      const etag = headers1['etag'];
      expect(etag).toBeDefined();

      // 2. Second request with If-None-Match header matching ETag
      const headers2: Record<string, string> = {};
      let statusCode2 = 200;
      const req2 = { method: 'GET', url: '/api/v1/users', headers: { 'if-none-match': etag } };
      const res2: any = {
        setHeader: (k: string, v: string) => { headers2[k.toLowerCase()] = v; },
        getHeader: (k: string) => headers2[k.toLowerCase()],
        status: (code: number) => { statusCode2 = code; return res2; },
        json: vi.fn(),
        send: vi.fn(),
        end: vi.fn(),
        headersSent: false,
      };

      await middleware(req2, res2, () => fakeHandler(req2, res2));

      // Should return 304 Not Modified without executing fakeHandler again
      expect(handlerCalls).toBe(1);
      expect(statusCode2).toBe(304);
    });
  });

  describe('honoCache', () => {
    it('intercepts Hono Context, generates ETag, and returns 304 Not Modified', async () => {
      cache = new CacheService({
        namespace: `hono-test-${Date.now()}`,
        disableRedis: true,
      });

      const middleware = honoCache({ cache, ttl: 60 });

      let controllerCalls = 0;
      const mockHonoContext = (headers: Record<string, string> = {}) => {
        return {
          req: {
            method: 'GET',
            url: 'https://example.com/api/items',
            header: (name: string) => headers[name.toLowerCase()],
          },
          res: {
            clone: () => ({
              text: async () => JSON.stringify({ item: 1 }),
            }),
            headers: new Map([['content-type', 'application/json']]),
          },
          body: vi.fn((data, status, hdrs) => ({ data, status, headers: hdrs })),
        };
      };

      // 1. First call (miss)
      const c1 = mockHonoContext();
      await middleware(c1, async () => { controllerCalls++; });
      expect(controllerCalls).toBe(1);
      expect(c1.body).toHaveBeenCalledWith(JSON.stringify({ item: 1 }), 200, expect.objectContaining({ ETag: expect.any(String) }));

      const etag = (c1.body.mock.calls[0][2] as any).ETag;

      // 2. Second call with If-None-Match
      const c2 = mockHonoContext({ 'if-none-match': etag });
      await middleware(c2, async () => { controllerCalls++; });
      expect(controllerCalls).toBe(1); // Controller not called again
      expect(c2.body).toHaveBeenCalledWith(null, 304, { ETag: etag });
    });
  });

  describe('fastifyCache', () => {
    it('intercepts Fastify preHandler, calculates ETag, and short-circuits 304', async () => {
      cache = new CacheService({
        namespace: `fastify-test-${Date.now()}`,
        disableRedis: true,
      });

      const middleware = fastifyCache({ cache, ttl: 60 });

      let handlerCalls = 0;
      const headers1: Record<string, string> = {};
      let statusCode1 = 200;
      let body1: any = null;

      const req1 = { method: 'GET', url: '/api/v1/products', headers: {} };
      const reply1: any = {
        sent: false,
        header: (k: string, v: string) => { headers1[k.toLowerCase()] = v; },
        getHeader: (k: string) => headers1[k.toLowerCase()],
        code: (c: number) => { statusCode1 = c; return reply1; },
        send: (b: any) => { body1 = b; reply1.sent = true; return reply1; },
      };

      await middleware(req1, reply1);
      // Simulate route handler calling reply.send
      if (!reply1.sent) {
        handlerCalls++;
        reply1.send({ product: 'macbook-pro', stock: 12 });
      }

      expect(handlerCalls).toBe(1);
      expect(statusCode1).toBe(200);
      expect(body1).toEqual({ product: 'macbook-pro', stock: 12 });
      const etag = headers1['etag'];
      expect(etag).toBeDefined();

      // 2. Second call with If-None-Match
      const headers2: Record<string, string> = {};
      let statusCode2 = 200;
      const req2 = { method: 'GET', url: '/api/v1/products', headers: { 'if-none-match': etag } };
      const reply2: any = {
        sent: false,
        header: (k: string, v: string) => { headers2[k.toLowerCase()] = v; },
        getHeader: (k: string) => headers2[k.toLowerCase()],
        code: (c: number) => { statusCode2 = c; return reply2; },
        send: vi.fn(() => { reply2.sent = true; return reply2; }),
      };

      await middleware(req2, reply2);

      expect(statusCode2).toBe(304);
      expect(reply2.send).toHaveBeenCalled();
    });
  });

  describe('error responses must never be cached (status gate)', () => {
    it('expressCache: a 500 response bypasses the cache and is refetched', async () => {
      cache = new CacheService({
        namespace: `http-err-${Date.now()}`,
        disableRedis: true,
      });
      const middleware = expressCache({ cache, ttl: 60 });

      let handlerCalls = 0;
      const runRequest = async () => {
        const req = { method: 'GET', url: '/api/flaky', headers: {} };
        let body: unknown = null;
        const res: any = {
          // Real Express tracks the response code on the res object itself.
          statusCode: 200,
          setHeader: () => {},
          getHeader: () => undefined,
          status: function (code: number) { this.statusCode = code; return this; },
          json: (data: unknown) => { body = data; },
          send: (data: unknown) => { body = data; },
          end: () => {},
          headersSent: false,
        };
        await middleware(req, res, () => {
          handlerCalls++;
          if (handlerCalls === 1) {
            res.status(500);
            res.json({ error: 'upstream down' });
          } else {
            res.json({ message: 'recovered' });
          }
        });
        return { statusCode: res.statusCode as number, body };
      };

      const r1 = await runRequest();
      expect(r1.statusCode).toBe(500);

      const r2 = await runRequest();
      // THE invariant: the 500 must NOT have been cached — the handler re-runs
      // and its recovered 200 payload is served. (Bug: r2 replayed the error.)
      expect(handlerCalls).toBe(2);
      expect(r2.body).toEqual({ message: 'recovered' });
    });

    it('honoCache: a 500 response bypasses the cache and is refetched', async () => {
      cache = new CacheService({
        namespace: `hono-err-${Date.now()}`,
        disableRedis: true,
      });
      const middleware = honoCache({ cache, ttl: 60 });

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

      // Bug: request 2 was served the cached error payload without running the
      // controller. Fix: the 500 bypassed the cache entirely, the controller
      // re-ran, and its fresh 200 payload is what reaches the response.
      expect(controllerCalls).toBe(2);
      expect(c2.body).not.toHaveBeenCalledWith(
        expect.stringContaining('error'),
        200,
        expect.anything(),
      );
    });

    it('fastifyCache: a 500 response bypasses the cache and is refetched', async () => {
      cache = new CacheService({
        namespace: `ff-err-${Date.now()}`,
        disableRedis: true,
      });
      const middleware = fastifyCache({ cache, ttl: 60 });
      let routeCalls = 0;

      // Request 1: route replies 500
      const req1 = { method: 'GET', url: '/api/flaky', headers: {} };
      const reply1: any = {
        sent: false,
        statusCode: 200,
        header: () => {},
        getHeader: () => undefined,
        code: function (c: number) { this.statusCode = c; return this; },
        send: function () { this.sent = true; return this; },
      };
      await middleware(req1, reply1);
      if (!reply1.sent) {
        routeCalls++;
        reply1.code(500);
        reply1.send({ error: 'upstream down' });
      }

      // Request 2: route would now succeed
      const req2 = { method: 'GET', url: '/api/flaky', headers: {} };
      let body2: unknown = null;
      const reply2: any = {
        sent: false,
        statusCode: 200,
        header: () => {},
        getHeader: () => undefined,
        code: function (c: number) { this.statusCode = c; return this; },
        send: function (b: unknown) { body2 = b; this.sent = true; return this; },
      };
      await middleware(req2, reply2);
      if (!reply2.sent) {
        routeCalls++;
        reply2.code(200);
        reply2.send({ product: 'fresh' });
      }

      expect(routeCalls).toBe(2);
      expect(body2).toEqual({ product: 'fresh' });
    });

    it('expressCache: resolves when the handler answers via res.end() (no hang)', async () => {
      cache = new CacheService({
        namespace: `http-end-${Date.now()}`,
        disableRedis: true,
      });
      const middleware = expressCache({ cache, ttl: 60 });

      const req = { method: 'GET', url: '/api/empty', headers: {} };
      const res: any = {
        setHeader: () => {},
        getHeader: () => undefined,
        status: undefined,
        json: undefined,
        send: undefined,
        end: () => {},
        headersSent: false,
      };

      // Bug: fetchFn's promise never settles because only res.json/res.send
      // were intercepted — awaiting the middleware hangs forever.
      await Promise.race([
        middleware(req, res, () => { res.end('done'); }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('middleware hung on res.end()')), 1000)),
      ]);
    });
  });
});
