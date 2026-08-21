/**
 * tricache/http — Universal HTTP Caching, ETag generation, and 304 Not Modified middleware
 * for Express, Fastify, and Hono.
 *
 * Usage with Express:
 *   import { expressCache } from 'tricache/http';
 *   app.get('/api/users', expressCache({ cache, ttl: 300, tags: ['users'] }), handler);
 *
 * Usage with Hono:
 *   import { honoCache } from 'tricache/http';
 *   app.get('/api/users', honoCache({ cache, ttl: 300, tags: ['users'] }), handler);
 */

import type { CacheService } from '../cache-service.js';
import type { WrapOptions } from '../types.js';
import crypto from 'crypto';

export interface HttpCacheOptions extends WrapOptions {
  /** TriCache instance. If omitted, uses singleton CacheService.create(). */
  cache?: CacheService;
  /** Custom key derivation function. Defaults to `${method}:${url}`. */
  keyGenerator?: (req: any) => string;
  /** Whether to emit weak ETags (default: true). */
  etag?: boolean;
}

/** Compute a weak ETag from a string, Buffer, or object */
export function generateETag(data: unknown): string {
  const str = typeof data === 'string'
    ? data
    : Buffer.isBuffer(data)
      ? data.toString('utf8')
      : JSON.stringify(data);
  const hash = crypto.createHash('sha1').update(str).digest('hex').slice(0, 16);
  return `W/"${str.length.toString(16)}-${hash}"`;
}

/** Express / Connect middleware */
export function expressCache(options: HttpCacheOptions = {}) {
  const { cache, keyGenerator, etag = true, ttl = 300, swr, tags } = options;

  return async (req: any, res: any, next: any) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }

    let activeCache = cache;
    if (!activeCache) {
      const { CacheService } = await import('../cache-service.js');
      activeCache = CacheService.create();
    }

    const key = keyGenerator ? keyGenerator(req) : `http:${req.method}:${req.originalUrl || req.url}`;
    const ifNoneMatch = req.headers ? req.headers['if-none-match'] : undefined;

    try {
      const cached = await activeCache.get<{ body: unknown; contentType?: string; etag?: string }>(
        key,
        async () => {
          return new Promise((resolve) => {
            const origJson = res.json?.bind(res);
            const origSend = res.send?.bind(res);

            if (origJson) {
              res.json = (body: any) => {
                const bodyEtag = etag ? generateETag(body) : undefined;
                resolve({ body, contentType: 'application/json; charset=utf-8', etag: bodyEtag });
                if (ifNoneMatch && ifNoneMatch === bodyEtag) {
                  return res.status(304).end();
                }
                if (bodyEtag && res.setHeader) res.setHeader('ETag', bodyEtag);
                return origJson(body);
              };
            }

            if (origSend) {
              res.send = (body: any) => {
                const bodyEtag = etag ? generateETag(body) : undefined;
                resolve({ body, contentType: res.getHeader ? res.getHeader('content-type') : undefined, etag: bodyEtag });
                if (ifNoneMatch && ifNoneMatch === bodyEtag) {
                  return res.status(304).end();
                }
                if (bodyEtag && res.setHeader) res.setHeader('ETag', bodyEtag);
                return origSend(body);
              };
            }

            next();
          });
        },
        ttl,
        { swr, tags }
      );

      if (!res.headersSent) {
        if (cached.etag) {
          if (res.setHeader) res.setHeader('ETag', cached.etag);
          if (ifNoneMatch === cached.etag) {
            return res.status(304).end();
          }
        }
        if (cached.contentType && res.setHeader) {
          res.setHeader('Content-Type', cached.contentType);
        }
        if (typeof cached.body === 'object' && cached.body !== null && res.json) {
          return res.json(cached.body);
        } else if (res.send) {
          return res.send(cached.body);
        }
      }
    } catch (err) {
      next(err);
    }
  };
}

/** Hono / Web Standard middleware */
export function honoCache(options: HttpCacheOptions = {}) {
  const { cache, keyGenerator, etag = true, ttl = 300, swr, tags } = options;

  return async (c: any, next: any) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return await next();
    }

    let activeCache = cache;
    if (!activeCache) {
      const { CacheService } = await import('../cache-service.js');
      activeCache = CacheService.create();
    }

    const key = keyGenerator ? keyGenerator(c.req) : `http:${c.req.method}:${c.req.url}`;
    const ifNoneMatch = c.req.header ? c.req.header('if-none-match') : undefined;

    const cached = await activeCache.get<{ body: unknown; contentType?: string; etag?: string }>(
      key,
      async () => {
        await next();
        const res = c.res;
        const text = await res.clone().text();
        const bodyEtag = etag ? generateETag(text) : undefined;
        return {
          body: text,
          contentType: res.headers.get('content-type') ?? 'text/plain',
          etag: bodyEtag,
        };
      },
      ttl,
      { swr, tags }
    );

    if (cached.etag && ifNoneMatch === cached.etag) {
      return c.body(null, 304, { ETag: cached.etag });
    }

    const headers: Record<string, string> = {};
    if (cached.etag) headers['ETag'] = cached.etag;
    if (cached.contentType) headers['Content-Type'] = cached.contentType;

    return c.body(cached.body, 200, headers);
  };
}

/** Fastify preHandler hook */
export function fastifyCache(options: HttpCacheOptions = {}) {
  const { cache, keyGenerator, etag = true, ttl = 300, tags } = options;

  return async (req: any, reply: any) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return;

    let activeCache = cache;
    if (!activeCache) {
      const { CacheService } = await import('../cache-service.js');
      activeCache = CacheService.create();
    }

    const key = keyGenerator ? keyGenerator(req) : `http:${req.method}:${req.url}`;
    const ifNoneMatch = req.headers ? req.headers['if-none-match'] : undefined;

    // Fast-path: Check if already cached in L1 / Disk / Redis
    const cached = await activeCache.get<{ body: unknown; contentType?: string; etag?: string } | null>(
      key,
      async () => null,
      0
    );

    if (cached) {
      if (cached.etag) {
        if (reply.header) reply.header('ETag', cached.etag);
        if (ifNoneMatch === cached.etag) {
          if (reply.code) reply.code(304);
          else if (reply.status) reply.status(304);
          if (reply.send) return reply.send();
          return;
        }
      }
      if (cached.contentType && reply.header) {
        reply.header('Content-Type', cached.contentType);
      }
      if (reply.send) return reply.send(cached.body);
      return;
    }

    // Miss path: intercept reply.send on completion
    const origSend = reply.send?.bind(reply);
    if (origSend) {
      reply.send = function (payload: any) {
        if (payload !== undefined && payload !== null) {
          const payloadEtag = etag ? generateETag(payload) : undefined;
          const contentType = (reply.getHeader && reply.getHeader('content-type')) || (typeof payload === 'object' ? 'application/json' : 'text/plain');
          activeCache!.set(key, { body: payload, contentType, etag: payloadEtag }, ttl, undefined, { tags }).catch(() => {});
          if (ifNoneMatch && ifNoneMatch === payloadEtag) {
            if (reply.code) reply.code(304);
            else if (reply.status) reply.status(304);
            return origSend();
          }
          if (payloadEtag && reply.header) reply.header('ETag', payloadEtag);
        }
        return origSend(payload);
      };
    }
  };
}
