import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import {
  createFastifyPlugin,
  fastifyCachePlugin,
  fastifyCache,
} from '../src/fastify/index.js';
import {
  createFastifyPlugin as httpCreateFastifyPlugin,
  fastifyCachePlugin as httpFastifyCachePlugin,
  fastifyCache as httpFastifyCache,
} from '../src/http/index.js';

describe('Fastify plugin (tricache/fastify)', () => {
  let cache: CacheService;
  let namespace: string;

  beforeEach(() => {
    namespace = `test_fastify_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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

  it('exports createFastifyPlugin, fastifyCachePlugin, and fastifyCache from the dedicated entry', () => {
    expect(typeof createFastifyPlugin).toBe('function');
    expect(typeof fastifyCachePlugin).toBe('function');
    expect(typeof fastifyCache).toBe('function');
    expect(createFastifyPlugin).toBe(httpCreateFastifyPlugin);
    expect(fastifyCachePlugin).toBe(httpFastifyCachePlugin);
    expect(fastifyCache).toBe(httpFastifyCache);
  });

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

  describe('createFastifyPlugin (register / onRequest + onSend)', () => {
    it('registers hooks and serves a cache miss then a HIT without re-running onSend capture', async () => {
      const app = createMockFastifyApp();
      const plugin = createFastifyPlugin({ cache, ttl: 60, tags: ['items'] });
      await plugin(app);

      const req1 = { method: 'GET', url: '/fastify/items', headers: {} };
      const reply1 = createMockFastifyReply();

      await app.runRequest(req1, reply1);
      expect(reply1.sent).toBe(false);

      const initialPayload = JSON.stringify([{ id: 1, item: 'Keyboard' }]);
      reply1.header('content-type', 'application/json');
      const delivered = await app.runSend(req1, reply1, initialPayload);
      expect(delivered).toBe(initialPayload);
      expect(reply1.headers['etag']).toBeDefined();

      await new Promise(r => setTimeout(r, 10));

      const req2 = { method: 'GET', url: '/fastify/items', headers: {} };
      const reply2 = createMockFastifyReply();

      await app.runRequest(req2, reply2);
      expect(reply2.sent).toBe(true);
      expect(reply2.getPayload()).toBe(initialPayload);
      expect(reply2.headers['etag']).toBe(reply1.headers['etag']);
    });

    it('evaluates If-None-Match and returns 304 Not Modified', async () => {
      const app = createMockFastifyApp();
      const plugin = createFastifyPlugin({ cache, ttl: 60 });
      await plugin(app);

      const req1 = { method: 'GET', url: '/fastify/data', headers: {} };
      const reply1 = createMockFastifyReply();
      await app.runRequest(req1, reply1);
      await app.runSend(req1, reply1, 'fastify_cached_value');

      await new Promise(r => setTimeout(r, 10));
      const etag = reply1.headers['etag'];
      expect(etag).toBeDefined();

      const req2 = { method: 'GET', url: '/fastify/data', headers: { 'if-none-match': etag } };
      const reply2 = createMockFastifyReply();
      await app.runRequest(req2, reply2);

      expect(reply2.sent).toBe(true);
      expect(reply2.statusCode).toBe(304);
    });

    it('does not cache a 500 response and refetches on the next request', async () => {
      const app = createMockFastifyApp();
      const plugin = createFastifyPlugin({ cache, ttl: 60 });
      await plugin(app);

      const req1 = { method: 'GET', url: '/fastify/flaky', headers: {} };
      const reply1 = createMockFastifyReply();
      await app.runRequest(req1, reply1);
      reply1.code(500);
      const errorPayload = JSON.stringify({ error: 'upstream down' });
      await app.runSend(req1, reply1, errorPayload);

      await new Promise(r => setTimeout(r, 10));

      const req2 = { method: 'GET', url: '/fastify/flaky', headers: {} };
      const reply2 = createMockFastifyReply();
      await app.runRequest(req2, reply2);
      expect(reply2.sent).toBe(false);

      const freshPayload = JSON.stringify({ item: 'ok' });
      reply2.code(200);
      const delivered = await app.runSend(req2, reply2, freshPayload);
      expect(delivered).toBe(freshPayload);
    });
  });

  describe('fastifyCache (route preHandler)', () => {
    it('serves a miss then a HIT with ETag headers without re-running the handler', async () => {
      const middleware = fastifyCache({ cache, ttl: 60, tags: ['products'] });
      let handlerCalls = 0;

      const headers1: Record<string, string> = {};
      let statusCode1 = 200;
      let body1: any = null;

      const req1 = { method: 'GET', url: '/api/v1/products', headers: {} };
      const reply1: any = {
        sent: false,
        statusCode: 200,
        header: (k: string, v: string) => { headers1[k.toLowerCase()] = v; },
        getHeader: (k: string) => headers1[k.toLowerCase()],
        code: (c: number) => { statusCode1 = c; reply1.statusCode = c; return reply1; },
        send: (b: any) => { body1 = b; reply1.sent = true; return reply1; },
      };

      await middleware(req1, reply1);
      if (!reply1.sent) {
        handlerCalls++;
        reply1.send({ product: 'macbook-pro', stock: 12 });
      }

      expect(handlerCalls).toBe(1);
      expect(statusCode1).toBe(200);
      expect(body1).toEqual({ product: 'macbook-pro', stock: 12 });
      const etag = headers1['etag'];
      expect(etag).toBeDefined();

      const headers2: Record<string, string> = {};
      let body2: any = null;
      const req2 = { method: 'GET', url: '/api/v1/products', headers: {} };
      const reply2: any = {
        sent: false,
        statusCode: 200,
        header: (k: string, v: string) => { headers2[k.toLowerCase()] = v; },
        getHeader: (k: string) => headers2[k.toLowerCase()],
        code: (c: number) => { reply2.statusCode = c; return reply2; },
        send: (b: any) => { body2 = b; reply2.sent = true; return reply2; },
      };

      await middleware(req2, reply2);
      if (!reply2.sent) {
        handlerCalls++;
        reply2.send({ product: 'should-not-run' });
      }

      expect(handlerCalls).toBe(1);
      expect(body2).toEqual({ product: 'macbook-pro', stock: 12 });
      expect(headers2['etag']).toBe(etag);
    });

    it('intercepts preHandler, calculates ETag, and short-circuits 304', async () => {
      const middleware = fastifyCache({ cache, ttl: 60 });
      let handlerCalls = 0;

      const headers1: Record<string, string> = {};
      const req1 = { method: 'GET', url: '/api/v1/products', headers: {} };
      const reply1: any = {
        sent: false,
        header: (k: string, v: string) => { headers1[k.toLowerCase()] = v; },
        getHeader: (k: string) => headers1[k.toLowerCase()],
        code: (c: number) => { reply1.statusCode = c; return reply1; },
        send: (b: any) => { reply1.sent = true; return b; },
      };

      await middleware(req1, reply1);
      if (!reply1.sent) {
        handlerCalls++;
        reply1.send({ product: 'macbook-pro', stock: 12 });
      }

      const etag = headers1['etag'];
      expect(etag).toBeDefined();

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
      if (!reply2.sent) {
        handlerCalls++;
      }

      expect(handlerCalls).toBe(1);
      expect(statusCode2).toBe(304);
      expect(reply2.send).toHaveBeenCalled();
    });

    it('does not cache a 500 response and refetches on the next request', async () => {
      const middleware = fastifyCache({ cache, ttl: 60 });
      let routeCalls = 0;

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
  });
});
