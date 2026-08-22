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
      const cached = await activeCache.get<{ body: unknown; contentType?: string; etag?: string; status?: number }>(
        key,
        async () => {
          return new Promise((resolve) => {
            const origJson = res.json?.bind(res);
            const origSend = res.send?.bind(res);
            const origEnd  = res.end?.bind(res);
            const statusOf = () => (res as { statusCode?: number }).statusCode;

            if (origJson) {
              res.json = (body: any) => {
                const bodyEtag = etag ? generateETag(body) : undefined;
                resolve({ body, contentType: 'application/json; charset=utf-8', etag: bodyEtag, status: statusOf() });
                if (ifNoneMatch && ifNoneMatch === bodyEtag) {
                  res.status?.(304);
                  origEnd?.();
                  return;
                }
                if (bodyEtag && res.setHeader) res.setHeader('ETag', bodyEtag);
                return origJson(body);
              };
            }

            if (origSend) {
              res.send = (body: any) => {
                const bodyEtag = etag ? generateETag(body) : undefined;
                resolve({ body, contentType: res.getHeader ? (res.getHeader('content-type') as string | undefined) : undefined, etag: bodyEtag, status: statusOf() });
                if (ifNoneMatch && ifNoneMatch === bodyEtag) {
                  res.status?.(304);
                  origEnd?.();
                  return;
                }
                if (bodyEtag && res.setHeader) res.setHeader('ETag', bodyEtag);
                return origSend(body);
              };
            }

            // Handlers that answer via res.end() (empty bodies, strings, buffers)
            // previously never resolved the fetchFn promise — the middleware hung
            // forever. end() is a third completion signal alongside json/send.
            if (origEnd) {
              res.end = (body?: unknown) => {
                const bodyEtag = etag && body != null ? generateETag(body) : undefined;
                resolve({ body, contentType: res.getHeader ? (res.getHeader('content-type') as string | undefined) : undefined, etag: bodyEtag, status: statusOf() });
                return origEnd(body as never);
              };
            }

            next();
          });
        },
        ttl,
        { swr, tags }
      );

      // Status gate: error responses must never be cached. get() has already
      // stored whatever the handler produced — evict it immediately so the next
      // request re-runs the handler instead of replaying a transient 4xx/5xx
      // for the whole TTL window.
      const respStatus = (cached as { status?: number }).status;
      if (typeof respStatus === 'number' && (respStatus < 200 || respStatus >= 300)) {
        await activeCache.delete(key).catch(() => {});
        return;
      }

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

    const cached = await activeCache.get<{ body: unknown; contentType?: string; etag?: string; status?: number }>(
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
          status: typeof (res as { status?: unknown }).status === 'number'
            ? (res as { status: number }).status
            : undefined,
        };
      },
      ttl,
      { swr, tags }
    );

    // Status gate: never replay a transient 4xx/5xx from cache — evict and let
    // the (already-dispatched) live response stand for this request.
    if (typeof cached.status === 'number' && (cached.status < 200 || cached.status >= 300)) {
      await activeCache.delete(key).catch(() => {});
      return;
    }

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
          // Status gate: only cache 2xx. A transient 4xx/5xx must not poison
          // this key for the whole TTL window.
          const respStatus = reply.statusCode ?? reply.raw?.statusCode;
          if (respStatus === undefined || (respStatus >= 200 && respStatus < 300)) {
            activeCache!.set(key, { body: payload, contentType, etag: payloadEtag }, ttl, undefined, { tags }).catch(() => {});
          }
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
