import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import { createExpressMiddleware } from '../src/http/index.js';
import { CATALOG, paginateCatalog, resolveLanguage } from '../examples/express-api/src/catalog.js';

describe('Express API Reference Example (examples/express-api)', () => {
  let cache: CacheService;
  let namespace: string;

  beforeEach(() => {
    namespace = `express_demo_test_${Date.now()}`;
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
      // First item in catalog is Mechanical Keyboard -> Clavier mécanique in French
      expect(page1.items[0].name).toBe('Clavier mécanique');

      const page2 = paginateCatalog('en', 2, 3);
      expect(page2.items).toHaveLength(3);
      expect(page2.items[0].name).toBe('4K Monitor');
    });
  });

  describe('Express Middleware Contract Matching Demo', () => {
    function createMockExpressContext(
      url: string,
      headers: Record<string, string> = {},
    ) {
      const resHeaders: Record<string, string> = {};
      let statusCode = 200;
      let sentBody: unknown = null;
      let ended = false;

      const req = {
        method: 'GET',
        url,
        originalUrl: url,
        headers: { ...headers },
      };

      const res = {
        statusCode: 200,
        headersSent: false,
        setHeader(name: string, value: string) {
          resHeaders[name.toLowerCase()] = value;
          return this;
        },
        getHeader(name: string) {
          return resHeaders[name.toLowerCase()];
        },
        status(code: number) {
          this.statusCode = code;
          statusCode = code;
          return this;
        },
        json(data: unknown) {
          sentBody = data;
          ended = true;
          return this;
        },
        send(data: unknown) {
          sentBody = data;
          ended = true;
          return this;
        },
        end(data?: unknown) {
          if (data !== undefined) sentBody = data;
          ended = true;
          return this;
        },
      };

      return {
        req,
        res,
        resHeaders,
        getStatusCode: () => statusCode,
        getBody: () => sentBody,
        isEnded: () => ended,
      };
    }

    it('implements demo pipeline: weak ETag, 304 short-circuit, query order invariance, and skipCache', async () => {
      const middleware = createExpressMiddleware({
        cache,
        ttl: 120,
        swr: 30,
        etag: true,
        tags: ['products'],
        headerWhitelist: ['accept-language'],
        skipCache: (req) => Boolean(req.headers.authorization),
      });

      let originCallCount = 0;
      const handler = (req: unknown, res: { json: (d: unknown) => void }) => {
        originCallCount++;
        res.json({
          generatedAt: Date.now(),
          catalog: 'sample-data',
        });
      };

      // 1. Cold miss: returns 200 and sets weak ETag
      const ctx1 = createMockExpressContext('/api/products?limit=5&page=2', {
        'accept-language': 'en',
      });
      await middleware(ctx1.req, ctx1.res, () => handler(ctx1.req, ctx1.res));
      expect(ctx1.getStatusCode()).toBe(200);
      const etag = ctx1.resHeaders['etag'];
      expect(etag).toMatch(/^W\/"/);
      expect(originCallCount).toBe(1);

      // 2. Query order invariance: /api/products?page=2&limit=5 hits cache and produces same ETag
      const ctx2 = createMockExpressContext('/api/products?page=2&limit=5', {
        'accept-language': 'en',
      });
      await middleware(ctx2.req, ctx2.res, () => handler(ctx2.req, ctx2.res));
      expect(ctx2.getStatusCode()).toBe(200);
      expect(ctx2.resHeaders['etag']).toBe(etag);
      expect(originCallCount).toBe(1); // origin not called, served from cache

      // 3. Conditional request: If-None-Match with matching ETag returns 304 Not Modified
      const ctx3 = createMockExpressContext('/api/products?limit=5&page=2', {
        'accept-language': 'en',
        'if-none-match': etag,
      });
      await middleware(ctx3.req, ctx3.res, () => handler(ctx3.req, ctx3.res));
      expect(ctx3.getStatusCode()).toBe(304);
      expect(ctx3.getBody()).toBeNull();
      expect(ctx3.isEnded()).toBe(true);
      expect(originCallCount).toBe(1);

      // 4. Header whitelisting: changing accept-language to 'fr' causes a fresh miss and different ETag
      const ctx4 = createMockExpressContext('/api/products?limit=5&page=2', {
        'accept-language': 'fr',
      });
      await middleware(ctx4.req, ctx4.res, () => handler(ctx4.req, ctx4.res));
      expect(ctx4.getStatusCode()).toBe(200);
      expect(originCallCount).toBe(2);
      expect(ctx4.resHeaders['etag']).not.toBe(etag);

      // 5. skipCache: authorization header bypasses cache completely
      const ctx5 = createMockExpressContext('/api/products?limit=5&page=2', {
        'accept-language': 'en',
        authorization: 'Bearer token-xyz',
      });
      await middleware(ctx5.req, ctx5.res, () => handler(ctx5.req, ctx5.res));
      expect(ctx5.getStatusCode()).toBe(200);
      expect(originCallCount).toBe(3); // origin bypassed cache
    });
  });
});
