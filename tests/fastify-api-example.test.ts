import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import { createFastifyPlugin, fastifyCache, fastifyCachePlugin } from '../src/http/index.js';
import { CATALOG, paginateCatalog, resolveLanguage } from '../examples/fastify-api/src/catalog.js';

describe('Fastify API Reference Example (examples/fastify-api)', () => {
  let cache: CacheService;
  let namespace: string;

  beforeEach(() => {
    namespace = `fastify_demo_test_${Date.now()}`;
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

  describe('Catalog Localization & Pagination', () => {
    it('resolves supported languages and falls back gracefully to default en', () => {
      expect(resolveLanguage('fr-FR,fr;q=0.9')).toBe('fr');
      expect(resolveLanguage('es-ES,es;q=0.8')).toBe('es');
      expect(resolveLanguage('de-DE')).toBe('en');
      expect(resolveLanguage(undefined)).toBe('en');
    });

    it('paginates the catalog correctly and translates items', () => {
      const page1 = paginateCatalog('fr', 1, 3);
      expect(page1.items).toHaveLength(3);
      expect(page1.total).toBe(CATALOG.length);
      expect(page1.items[0].name).toBe('Clavier mécanique');

      const page2 = paginateCatalog('en', 2, 3);
      expect(page2.items).toHaveLength(3);
      expect(page2.items[0].name).toBe('4K Monitor');
    });
  });

  describe('Official Fastify surfaces used by the demo', () => {
    it('exports fastifyCachePlugin as createFastifyPlugin() with no preset options', () => {
      expect(typeof fastifyCachePlugin).toBe('function');
      expect(typeof createFastifyPlugin).toBe('function');
      expect(typeof fastifyCache).toBe('function');
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

    it('createFastifyPlugin: onRequest short-circuit, onSend capture, weak ETag, 304, query order, skipCache', async () => {
      const plugin = createFastifyPlugin({
        cache,
        ttl: 120,
        swr: 30,
        etag: true,
        tags: ['products'],
        headerWhitelist: ['accept-language'],
        skipCache: (req: { headers?: Record<string, unknown> }) => Boolean(req.headers?.authorization),
      });

      const app = createMockFastifyApp();
      await plugin(app);

      const payload = JSON.stringify({ generatedAt: 't0', catalog: 'sample-data' });

      const req1 = { method: 'GET', url: '/api/products?limit=5&page=2', headers: { 'accept-language': 'en' } };
      const reply1 = createMockFastifyReply();
      await app.runRequest(req1, reply1);
      expect(reply1.sent).toBe(false);
      await app.runSend(req1, reply1, payload);
      expect(reply1.headers['etag']).toMatch(/^W\/"/);
      const etag = reply1.headers['etag'];

      await new Promise((r) => setTimeout(r, 15));

      const req2 = { method: 'GET', url: '/api/products?page=2&limit=5', headers: { 'accept-language': 'en' } };
      const reply2 = createMockFastifyReply();
      await app.runRequest(req2, reply2);
      expect(reply2.sent).toBe(true);
      expect(reply2.getPayload()).toBe(payload);
      expect(reply2.headers['etag']).toBe(etag);

      const req3 = {
        method: 'GET',
        url: '/api/products?limit=5&page=2',
        headers: { 'accept-language': 'en', 'if-none-match': etag },
      };
      const reply3 = createMockFastifyReply();
      await app.runRequest(req3, reply3);
      expect(reply3.sent).toBe(true);
      expect(reply3.statusCode).toBe(304);

      const req4 = { method: 'GET', url: '/api/products?limit=5&page=2', headers: { authorization: 'Bearer x' } };
      const reply4 = createMockFastifyReply();
      await app.runRequest(req4, reply4);
      expect(reply4.sent).toBe(false);
    });

    it('fastifyCache preHandler: miss, hit, and If-None-Match 304', async () => {
      const middleware = fastifyCache({
        cache,
        ttl: 120,
        etag: true,
        tags: ['catalog'],
        headerWhitelist: ['accept-language'],
      });

      let handlerCalls = 0;
      const body = { style: 'route-preHandler', generatedAt: 't0' };

      const headers1: Record<string, string> = {};
      const req1 = { method: 'GET', url: '/api/catalog?limit=5&page=2', headers: { 'accept-language': 'en' } };
      const reply1: any = {
        sent: false,
        header: (k: string, v: string) => { headers1[k.toLowerCase()] = v; },
        getHeader: (k: string) => headers1[k.toLowerCase()],
        code: (c: number) => { reply1.statusCode = c; return reply1; },
        send: (b: any) => { reply1.payload = b; reply1.sent = true; return reply1; },
      };

      await middleware(req1, reply1);
      if (!reply1.sent) {
        handlerCalls++;
        reply1.send(body);
      }
      expect(handlerCalls).toBe(1);
      expect(headers1['etag']).toMatch(/^W\/"/);
      const etag = headers1['etag'];

      await new Promise((r) => setTimeout(r, 15));

      const headers2: Record<string, string> = {};
      const req2 = { method: 'GET', url: '/api/catalog?page=2&limit=5', headers: { 'accept-language': 'en' } };
      const reply2: any = {
        sent: false,
        header: (k: string, v: string) => { headers2[k.toLowerCase()] = v; },
        getHeader: (k: string) => headers2[k.toLowerCase()],
        code: (c: number) => { reply2.statusCode = c; return reply2; },
        send: (b: any) => { reply2.payload = b; reply2.sent = true; return reply2; },
      };
      await middleware(req2, reply2);
      expect(reply2.sent).toBe(true);
      expect(reply2.payload).toEqual(body);
      expect(headers2['etag']).toBe(etag);

      const headers3: Record<string, string> = {};
      let status3 = 200;
      const req3 = {
        method: 'GET',
        url: '/api/catalog?limit=5&page=2',
        headers: { 'accept-language': 'en', 'if-none-match': etag },
      };
      const reply3: any = {
        sent: false,
        header: (k: string, v: string) => { headers3[k.toLowerCase()] = v; },
        getHeader: (k: string) => headers3[k.toLowerCase()],
        code: (c: number) => { status3 = c; return reply3; },
        send: () => { reply3.sent = true; return reply3; },
      };
      await middleware(req3, reply3);
      expect(status3).toBe(304);
      expect(reply3.sent).toBe(true);
    });
  });
});
