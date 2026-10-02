import { describe, it, expect, beforeEach } from 'vitest';
import { EdgeCacheService } from '../src/edge/cache';
import {
  honoEdgeCache,
  computeEdgeETag,
  buildEdgeDeterministicKey,
} from '../src/edge/hono';

describe('Decoupled Hono Edge Middleware - Phase 2', () => {
  let edgeCache: EdgeCacheService;

  beforeEach(() => {
    edgeCache = new EdgeCacheService({
      namespace: `test_edge_hono_${Date.now()}`,
      maxKeys: 1_000,
      maxBytes: 10 * 1024 * 1024,
    });
  });

  describe('Edge Utilities', () => {
    it('computes compliant weak ETags using Web Crypto API', async () => {
      const tag1 = await computeEdgeETag('hello edge world');
      const tag2 = await computeEdgeETag('hello edge world');
      const tag3 = await computeEdgeETag('different edge payload');

      expect(tag1.startsWith('W/"')).toBe(true);
      expect(tag1).toBe(tag2);
      expect(tag1).not.toBe(tag3);
    });

    it('generates deterministic edge keys with query sorting', () => {
      const mockContext1 = {
        req: {
          method: 'GET',
          url: 'https://example.com/api/feed?limit=10&cursor=abc&filter=active',
        },
      };
      const mockContext2 = {
        req: {
          method: 'GET',
          url: 'https://example.com/api/feed?filter=active&limit=10&cursor=abc',
        },
      };

      const key1 = buildEdgeDeterministicKey(mockContext1);
      const key2 = buildEdgeDeterministicKey(mockContext2);

      expect(key1).toBe('edge:http:GET:https://example.com/api/feed?cursor=abc&filter=active&limit=10');
      expect(key1).toBe(key2);
    });

    it('includes whitelisted headers in deterministic edge key', () => {
      const mockContextA = {
        req: {
          method: 'GET',
          url: '/api/user',
          header: (name: string) => (name.toLowerCase() === 'authorization' ? 'Bearer token-a' : undefined),
        },
      };
      const mockContextB = {
        req: {
          method: 'GET',
          url: '/api/user',
          header: (name: string) => (name.toLowerCase() === 'authorization' ? 'Bearer token-b' : undefined),
        },
      };

      const keyA = buildEdgeDeterministicKey(mockContextA, { headerWhitelist: ['authorization'] });
      const keyB = buildEdgeDeterministicKey(mockContextB, { headerWhitelist: ['authorization'] });

      expect(keyA).toBe('edge:http:GET:/api/user|h:authorization=Bearer token-a');
      expect(keyB).toBe('edge:http:GET:/api/user|h:authorization=Bearer token-b');
      expect(keyA).not.toBe(keyB);
    });
  });

  describe('Hono Middleware Execution', () => {
    function createMockHonoContext(url = '/api/status', headers: Record<string, string> = {}) {
      const reqHeaders = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      let responseBody: any = null;
      let responseStatus = 200;
      let responseHeaders: Record<string, string> = {};

      const c: any = {
        req: {
          method: 'GET',
          url,
          header: (name: string) => reqHeaders.get(name.toLowerCase()),
        },
        res: null as Response | null,
        body(data: any, status = 200, headers: Record<string, string> = {}) {
          responseBody = data;
          responseStatus = status;
          responseHeaders = { ...headers };
          return new Response(data, { status, headers });
        },
        executionCtx: {
          waitUntil: (promise: Promise<any>) => {
            void promise;
          },
        },
        getResult: () => ({
          body: responseBody,
          status: responseStatus,
          headers: responseHeaders,
        }),
      };

      return c;
    }

    it('handles cache miss and serves cached body on subsequent call', async () => {
      const middleware = honoEdgeCache({ cache: edgeCache, ttl: 60 });
      let downstreamCalls = 0;

      const downstream = async (c: any) => {
        downstreamCalls++;
        const payload = JSON.stringify({ edge: true, count: downstreamCalls });
        c.res = new Response(payload, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      // Call 1: Miss
      const c1 = createMockHonoContext('/api/edge-data');
      await middleware(c1, async () => downstream(c1));

      expect(downstreamCalls).toBe(1);
      const res1 = c1.getResult();
      expect(JSON.parse(res1.body)).toEqual({ edge: true, count: 1 });
      expect(res1.headers['ETag']).toBeDefined();

      // Call 2: Hit
      const c2 = createMockHonoContext('/api/edge-data');
      await middleware(c2, async () => downstream(c2));

      // Downstream must not be called again
      expect(downstreamCalls).toBe(1);
      const res2 = c2.getResult();
      expect(JSON.parse(res2.body)).toEqual({ edge: true, count: 1 });
      expect(res2.headers['ETag']).toBe(res1.headers['ETag']);
    });

    it('returns 304 Not Modified when If-None-Match header matches', async () => {
      const middleware = honoEdgeCache({ cache: edgeCache, ttl: 60 });

      // Populate cache
      const c1 = createMockHonoContext('/api/resource');
      await middleware(c1, async () => {
        c1.res = new Response('static-edge-payload', { status: 200 });
      });

      const etag = c1.getResult().headers['ETag'];
      expect(etag).toBeDefined();

      // Conditional request
      const c2 = createMockHonoContext('/api/resource', { 'if-none-match': etag });
      let downstreamExecuted = false;
      await middleware(c2, async () => {
        downstreamExecuted = true;
      });

      expect(downstreamExecuted).toBe(false);
      const res2 = c2.getResult();
      expect(res2.status).toBe(304);
      expect(res2.body).toBeNull();
      expect(res2.headers['ETag']).toBe(etag);
    });

    it('replaces a Hono-finalized downstream Response so the miss path still emits ETag', async () => {
      const middleware = honoEdgeCache({ cache: edgeCache, ttl: 60 });
      const c = createMockHonoContext('/api/finalized-miss');
      Object.defineProperty(c, 'finalized', { value: true, writable: true });

      await middleware(c, async () => {
        c.res = new Response(JSON.stringify({ miss: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const res = c.getResult();
      expect(res.status).toBe(200);
      expect(res.headers['ETag']?.startsWith('W/"')).toBe(true);
      expect(c.res).toBeInstanceOf(Response);
      expect((c.res as Response).headers.get('ETag')).toBe(res.headers['ETag']);
    });

    it('bypasses cache when Cache-Control: no-store is passed', async () => {
      const middleware = honoEdgeCache({ cache: edgeCache, ttl: 60 });
      let callCount = 0;

      const downstream = async (c: any) => {
        callCount++;
        c.res = new Response(`call-${callCount}`, { status: 200 });
      };

      const c1 = createMockHonoContext('/api/bypass');
      await middleware(c1, async () => downstream(c1));
      expect(callCount).toBe(1);

      // Bypass request
      const c2 = createMockHonoContext('/api/bypass', { 'cache-control': 'no-store' });
      await middleware(c2, async () => downstream(c2));
      expect(callCount).toBe(2);
    });
  });
});
