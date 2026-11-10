import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CacheService } from '../src/cache-service';
import {
  createExpressMiddleware,
  createFastifyPlugin,
  generateETag,
  buildDeterministicKey,
  shouldSkipCache,
} from '../src/http/index';

describe('HTTP Middlewares (Express & Fastify) - Phase 2', () => {
  let cache: CacheService;
  let namespace: string;

  beforeEach(() => {
    namespace = `test_http_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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

  describe('Utility Functions', () => {
    it('generates deterministic keys with sorted query parameters', () => {
      const req1 = { method: 'GET', originalUrl: '/api/v1/search?sort=desc&category=shoes&page=2' };
      const req2 = { method: 'GET', originalUrl: '/api/v1/search?page=2&sort=desc&category=shoes' };

      const key1 = buildDeterministicKey(req1);
      const key2 = buildDeterministicKey(req2);

      expect(key1).toBe('http:GET:/api/v1/search?category=shoes&page=2&sort=desc');
      expect(key1).toBe(key2);
    });

    it('incorporates whitelisted headers in deterministic key', () => {
      const reqA = {
        method: 'GET',
        url: '/api/feed',
        headers: { 'accept-language': 'fr', 'x-custom': 'ignored' },
      };
      const reqB = {
        method: 'GET',
        url: '/api/feed',
        headers: { 'accept-language': 'es', 'x-custom': 'ignored' },
      };

      const keyA = buildDeterministicKey(reqA, { headerWhitelist: ['accept-language'] });
      const keyB = buildDeterministicKey(reqB, { headerWhitelist: ['accept-language'] });

      expect(keyA).toBe('http:GET:/api/feed|h:accept-language=fr');
      expect(keyB).toBe('http:GET:/api/feed|h:accept-language=es');
      expect(keyA).not.toBe(keyB);
    });

    it('detects Cache-Control bypass directives', () => {
      expect(shouldSkipCache({ headers: { 'cache-control': 'no-cache' } })).toBe(true);
      expect(shouldSkipCache({ headers: { 'cache-control': 'no-store, max-age=0' } })).toBe(true);
      expect(shouldSkipCache({ headers: { 'cache-control': 'public, max-age=3600' } })).toBe(false);
      expect(shouldSkipCache({ headers: {} })).toBe(false);
      expect(shouldSkipCache({ headers: {} }, () => true)).toBe(true);
    });

    it('generates compliant weak ETags', () => {
      const etag1 = generateETag({ hello: 'world' });
      const etag2 = generateETag({ hello: 'world' });
      const etag3 = generateETag('different text');

      expect(etag1.startsWith('W/"')).toBe(true);
      expect(etag1).toBe(etag2);
      expect(etag1).not.toBe(etag3);
    });
  });

  describe('Express Middleware', () => {
    function createMockExpressContext(url = '/api/data', headers: Record<string, string> = {}) {
      const req: any = {
        method: 'GET',
        originalUrl: url,
        headers: { ...headers },
      };

      const resHeaders: Record<string, string> = {};
      let statusCode = 200;
      let sentBody: any = null;
      let ended = false;

      const res: any = {
        statusCode,
        setHeader(name: string, value: string) {
          resHeaders[name.toLowerCase()] = value;
        },
        getHeader(name: string) {
          return resHeaders[name.toLowerCase()];
        },
        status(code: number) {
          this.statusCode = code;
          statusCode = code;
          return this;
        },
        json(data: any) {
          sentBody = data;
          ended = true;
          return this;
        },
        send(data: any) {
          sentBody = data;
          ended = true;
          return this;
        },
        end(data?: any) {
          if (data !== undefined) sentBody = data;
          ended = true;
          return this;
        },
      };

      return { req, res, resHeaders, getBody: () => sentBody, isEnded: () => ended };
    }

    it('handles 200 cache miss then serves from cache on subsequent hit', async () => {
      const middleware = createExpressMiddleware({ cache, ttl: 60 });
      let handlerExecutionCount = 0;

      const handler = (req: any, res: any) => {
        handlerExecutionCount++;
        res.setHeader('Content-Type', 'application/json');
        res.json({ id: 101, name: 'TriCache Enterprise' });
      };

      // Request 1: Cold cache (miss)
      const ctx1 = createMockExpressContext('/api/product/101');
      await middleware(ctx1.req, ctx1.res, () => handler(ctx1.req, ctx1.res));

      expect(handlerExecutionCount).toBe(1);
      expect(ctx1.getBody()).toEqual({ id: 101, name: 'TriCache Enterprise' });
      expect(ctx1.resHeaders['etag']).toBeDefined();
      const firstEtag = ctx1.resHeaders['etag'];

      // Request 2: Warm cache (hit)
      const ctx2 = createMockExpressContext('/api/product/101');
      await middleware(ctx2.req, ctx2.res, () => handler(ctx2.req, ctx2.res));

      // Handler must NOT have been executed again
      expect(handlerExecutionCount).toBe(1);
      expect(ctx2.getBody()).toEqual({ id: 101, name: 'TriCache Enterprise' });
      expect(ctx2.resHeaders['etag']).toBe(firstEtag);
    });

    it('returns immediate 304 Not Modified when If-None-Match matches', async () => {
      const middleware = createExpressMiddleware({ cache, ttl: 60 });

      // Populate cache
      const ctx1 = createMockExpressContext('/api/doc/42');
      await middleware(ctx1.req, ctx1.res, () => {
        ctx1.res.json({ text: 'sample document' });
      });

      const etag = ctx1.resHeaders['etag'];
      expect(etag).toBeDefined();

      // Conditional GET with matching If-None-Match
      const ctx2 = createMockExpressContext('/api/doc/42', { 'if-none-match': etag });
      let handlerCalled = false;
      await middleware(ctx2.req, ctx2.res, () => {
        handlerCalled = true;
      });

      expect(handlerCalled).toBe(false);
      expect(ctx2.res.statusCode).toBe(304);
      expect(ctx2.getBody()).toBeNull(); // Empty body
      expect(ctx2.resHeaders['etag']).toBe(etag);
    });

    it('bypasses cache when Cache-Control: no-cache is provided', async () => {
      const middleware = createExpressMiddleware({ cache, ttl: 60 });
      let handlerCount = 0;

      const handler = (req: any, res: any) => {
        handlerCount++;
        res.json({ count: handlerCount });
      };

      const ctx1 = createMockExpressContext('/api/counter');
      await middleware(ctx1.req, ctx1.res, () => handler(ctx1.req, ctx1.res));
      expect(ctx1.getBody()).toEqual({ count: 1 });

      // Request with no-cache bypass
      const ctx2 = createMockExpressContext('/api/counter', { 'cache-control': 'no-cache' });
      await middleware(ctx2.req, ctx2.res, () => handler(ctx2.req, ctx2.res));
      expect(handlerCount).toBe(2);
      expect(ctx2.getBody()).toEqual({ count: 2 });
    });

    it('does not cache 4xx or 5xx error responses', async () => {
      const middleware = createExpressMiddleware({ cache, ttl: 60 });
      let callCount = 0;

      const errorHandler = (req: any, res: any) => {
        callCount++;
        res.status(404).json({ error: 'Not Found' });
      };

      const ctx1 = createMockExpressContext('/api/missing');
      await middleware(ctx1.req, ctx1.res, () => errorHandler(ctx1.req, ctx1.res));
      expect(callCount).toBe(1);

      // Subsequent call must hit handler again (not replay cached 404)
      const ctx2 = createMockExpressContext('/api/missing');
      await middleware(ctx2.req, ctx2.res, () => errorHandler(ctx2.req, ctx2.res));
      expect(callCount).toBe(2);
    });

    it('resolves coalesced concurrent callers on non-2xx responses without hanging', async () => {
      const middleware = createExpressMiddleware({ cache, ttl: 60 });
      const ctx1 = createMockExpressContext('/api/slow-404');
      const ctx2 = createMockExpressContext('/api/slow-404');

      let handlerCalls = 0;
      const slow404 = (_req: any, res: any) => {
        handlerCalls++;
        setTimeout(() => {
          res.status(404).json({ error: 'missing' });
        }, 20);
      };

      await Promise.all([
        middleware(ctx1.req, ctx1.res, () => slow404(ctx1.req, ctx1.res)),
        middleware(ctx2.req, ctx2.res, () => slow404(ctx2.req, ctx2.res)),
      ]);

      expect(handlerCalls).toBe(1);
      expect(ctx1.res.statusCode).toBe(404);
      expect(ctx1.getBody()).toEqual({ error: 'missing' });
      expect(ctx2.res.statusCode).toBe(404);
      expect(ctx2.getBody()).toEqual({ error: 'missing' });
      expect(ctx2.isEnded()).toBe(true);
    });

    it('cleans up inflight and forwards error when response closes before finishing', async () => {
      const middleware = createExpressMiddleware({ cache, ttl: 60 });
      const ctx = createMockExpressContext('/api/aborted');
      const listeners: Record<string, Array<() => void>> = {};
      ctx.res.once = (ev: string, fn: () => void) => {
        (listeners[ev] ??= []).push(fn);
      };
      ctx.res.removeListener = (ev: string, fn: () => void) => {
        listeners[ev] = (listeners[ev] ?? []).filter(f => f !== fn);
      };

      const nextSpy = vi.fn((err?: unknown) => {
        if (!err) {
          for (const fn of listeners['close'] ?? []) fn();
        }
      });

      await middleware(ctx.req, ctx.res, nextSpy);

      expect(nextSpy).toHaveBeenCalledTimes(2);
      expect((cache as any).inflight.size).toBe(0);
    });
  });

  describe('Fastify Plugin', () => {
    function createMockFastifyApp() {
      const hooks: Record<string, Array<Function>> = {
        onRequest: [],
        onSend: [],
      };

      return {
        addHook(name: string, fn: Function) {
          hooks[name].push(fn);
        },
        async runRequest(req: any, reply: any) {
          for (const hook of hooks.onRequest) {
            await hook(req, reply);
            if (reply.sent) return;
          }
        },
        async runSend(req: any, reply: any, payload: any) {
          let current = payload;
          for (const hook of hooks.onSend) {
            current = await hook(req, reply, current);
          }
          return current;
        },
      };
    }

    function createMockFastifyReply() {
      const headers: Record<string, string> = {};
      let statusCode = 200;
      let sentPayload: any = null;
      let isSent = false;

      return {
        headers,
        statusCode,
        get sent() { return isSent; },
        header(name: string, value: string) {
          headers[name.toLowerCase()] = value;
          return this;
        },
        getHeader(name: string) {
          return headers[name.toLowerCase()];
        },
        code(code: number) {
          statusCode = code;
          this.statusCode = code;
          return this;
        },
        send(payload?: any) {
          sentPayload = payload;
          isSent = true;
          return this;
        },
        getPayload: () => sentPayload,
      };
    }

    it('intercepts with onRequest and onSend to cache and serve responses', async () => {
      const app = createMockFastifyApp();
      const plugin = createFastifyPlugin({ cache, ttl: 60 });
      await plugin(app);

      // Request 1: Miss
      const req1 = { method: 'GET', url: '/fastify/items', headers: {} };
      const reply1 = createMockFastifyReply();

      await app.runRequest(req1, reply1);
      expect(reply1.sent).toBe(false); // Proceed to handler

      // Handler sends payload
      const initialPayload = JSON.stringify([{ id: 1, item: 'Keyboard' }]);
      reply1.header('content-type', 'application/json');
      const delivered = await app.runSend(req1, reply1, initialPayload);
      expect(delivered).toBe(initialPayload);
      expect(reply1.headers['etag']).toBeDefined();

      // Allow microtask/async set to settle
      await new Promise(r => setTimeout(r, 10));

      // Request 2: Hit - onRequest should short-circuit immediately
      const req2 = { method: 'GET', url: '/fastify/items', headers: {} };
      const reply2 = createMockFastifyReply();

      await app.runRequest(req2, reply2);
      expect(reply2.sent).toBe(true);
      expect(reply2.getPayload()).toBe(initialPayload);
    });

    it('evaluates If-None-Match in Fastify to return 304', async () => {
      const app = createMockFastifyApp();
      const plugin = createFastifyPlugin({ cache, ttl: 60 });
      await plugin(app);

      // Populate
      const req1 = { method: 'GET', url: '/fastify/data', headers: {} };
      const reply1 = createMockFastifyReply();
      await app.runRequest(req1, reply1);
      await app.runSend(req1, reply1, 'fastify_cached_value');

      await new Promise(r => setTimeout(r, 10));
      const etag = reply1.headers['etag'];
      expect(etag).toBeDefined();

      // Conditional request
      const req2 = { method: 'GET', url: '/fastify/data', headers: { 'if-none-match': etag } };
      const reply2 = createMockFastifyReply();
      await app.runRequest(req2, reply2);

      expect(reply2.sent).toBe(true);
      expect(reply2.statusCode).toBe(304);
    });

    it('probing on a miss in Fastify does not call Redis setex with TTL 0 or trip circuit breaker', async () => {
      const redisCache = new CacheService({
        namespace: `fastify_probe_${Date.now()}`,
        disableRedis: false,
        disableDisk: true,
        invalidationBackplane: false,
      });
      const setexSpy = vi.fn(async () => 'OK');
      (redisCache as any).redis = {
        get: vi.fn(async () => null),
        setex: setexSpy,
        disconnect: vi.fn(async () => {}),
      };

      try {
        const app = createMockFastifyApp();
        const plugin = createFastifyPlugin({ cache: redisCache, ttl: 60 });
        await plugin(app);

        const req = { method: 'GET', url: '/fastify/miss-probe', headers: {} };
        const reply = createMockFastifyReply();
        await app.runRequest(req, reply);

        expect(reply.sent).toBe(false);
        expect(setexSpy).not.toHaveBeenCalled();
        expect(redisCache.health().details?.circuitBreakerState).toBe('closed');
      } finally {
        await redisCache.destroy();
      }
    });
  });
});
