import type { CacheService } from '../cache-service.js';
import type { WrapOptions } from '../types.js';
import {
  buildDeterministicKey,
  generateETag,
  shouldSkipCache,
  type KeyDerivationOptions,
} from './utils.js';

export interface ExpressCacheOptions extends Omit<WrapOptions, 'tags'>, KeyDerivationOptions {
  /** TriCache instance. If omitted, lazily resolves the default singleton via CacheService.create(). */
  cache?: CacheService;
  /** Whether to generate and evaluate weak ETags. Default: true. */
  etag?: boolean;
  /** Custom predicate to skip caching dynamically for this request (e.g. authenticated sessions). */
  skipCache?: (req: any) => boolean;
  /** Dynamic tags derivation from request. */
  tags?: string[] | ((req: any) => string[]);
}

export interface CachedHttpResponse {
  body: unknown;
  contentType?: string;
  etag?: string;
  status: number;
}

/**
 * Creates an Express / Connect middleware that provides deterministic response caching,
 * weak ETag generation, conditional 304 Not Modified short-circuiting, and Cache-Control bypass controls.
 *
 * @example
 * import express from 'express';
 * import { CacheService } from 'tricache';
 * import { createExpressMiddleware } from 'tricache/http';
 *
 * const app = express();
 * const cache = CacheService.create();
 *
 * app.get(
 *   '/api/products',
 *   createExpressMiddleware({
 *     cache,
 *     ttl: 120,
 *     tags: ['products'],
 *     headerWhitelist: ['accept-language'],
 *   }),
 *   async (req, res) => {
 *     const data = await getProducts();
 *     res.json(data);
 *   }
 * );
 */
export function createExpressMiddleware(options: ExpressCacheOptions = {}) {
  const {
    cache,
    etag = true,
    ttl = 300,
    swr,
    tags,
    skipCache,
    keyGenerator,
    headerWhitelist,
  } = options;

  return async (req: any, res: any, next: any) => {
    // Only cache safe, idempotent HTTP read methods
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }

    if (shouldSkipCache(req, skipCache)) {
      return next();
    }

    let activeCache = cache;
    if (!activeCache) {
      const { CacheService } = await import('../cache-service.js');
      activeCache = CacheService.create();
    }

    const key = buildDeterministicKey(req, { keyGenerator, headerWhitelist });
    const ifNoneMatch = req.headers ? (req.headers['if-none-match'] || req.headers['If-None-Match']) : undefined;

    const resolvedTags = typeof tags === 'function' ? tags(req) : tags;

    let respondedLocally = false;

    try {
      const cached = await activeCache.get<CachedHttpResponse>(
        key,
        async () => {
          return new Promise<CachedHttpResponse>((resolve, reject) => {
            const rawJson = res.json;
            const rawSend = res.send;
            const rawEnd  = res.end;
            const origJson = rawJson?.bind(res);
            const origSend = rawSend?.bind(res);
            const origEnd  = rawEnd?.bind(res);
            let settled = false;

            const cleanup = () => {
              if (rawJson !== undefined) res.json = rawJson;
              if (rawSend !== undefined) res.send = rawSend;
              if (rawEnd !== undefined) res.end = rawEnd;
              res.removeListener?.('close', onClose);
            };

            const settle = (response: CachedHttpResponse) => {
              if (settled) return;
              settled = true;
              respondedLocally = true;
              cleanup();
              resolve(response);
            };

            const onClose = () => {
              if (settled) return;
              settled = true;
              respondedLocally = true;
              cleanup();
              reject(new Error('Express response closed before completion'));
            };

            res.once?.('close', onClose);

            const getStatusCode = () => (res.statusCode ?? 200);

            if (origJson) {
              res.json = (body: any) => {
                const status = getStatusCode();
                const bodyEtag = etag ? generateETag(body) : undefined;
                const contentType = res.getHeader?.('content-type') || 'application/json; charset=utf-8';

                settle({ body, contentType, etag: bodyEtag, status });

                if (status >= 200 && status < 300 && ifNoneMatch && bodyEtag && ifNoneMatch === bodyEtag) {
                  res.status?.(304);
                  origEnd?.();
                  return;
                }

                if (status >= 200 && status < 300 && bodyEtag && res.setHeader) {
                  res.setHeader('ETag', bodyEtag);
                }
                return origJson(body);
              };
            }

            if (origSend) {
              res.send = (body: any) => {
                const status = getStatusCode();
                const bodyEtag = etag ? generateETag(body) : undefined;
                const contentType = res.getHeader?.('content-type') as string | undefined;

                settle({ body, contentType, etag: bodyEtag, status });

                if (status >= 200 && status < 300 && ifNoneMatch && bodyEtag && ifNoneMatch === bodyEtag) {
                  res.status?.(304);
                  origEnd?.();
                  return;
                }

                if (status >= 200 && status < 300 && bodyEtag && res.setHeader) {
                  res.setHeader('ETag', bodyEtag);
                }
                return origSend(body);
              };
            }

            if (origEnd) {
              res.end = (body?: unknown) => {
                const status = getStatusCode();
                const bodyEtag = etag && body != null ? generateETag(body) : undefined;
                const contentType = res.getHeader?.('content-type') as string | undefined;

                settle({ body, contentType, etag: bodyEtag, status });
                return origEnd(body as never);
              };
            }

            try {
              next();
            } catch (err) {
              if (!settled) {
                settled = true;
                cleanup();
                reject(err);
              }
            }
          });
        },
        ttl,
        { swr, tags: resolvedTags }
      );

      // Status gate: only cache 2xx successful responses
      const isNon2xx = typeof cached.status === 'number' && (cached.status < 200 || cached.status >= 300);
      if (isNon2xx) {
        await activeCache.delete(key).catch(() => {});
      }

      if (!respondedLocally && !res.headersSent) {
        if (!isNon2xx && cached.etag) {
          if (res.setHeader) res.setHeader('ETag', cached.etag);
          if (ifNoneMatch === cached.etag) {
            return res.status(304).end();
          }
        }

        if (cached.contentType && res.setHeader) {
          res.setHeader('Content-Type', cached.contentType);
        }

        if (cached.status && res.status) {
          res.status(cached.status);
        }

        if (typeof cached.body === 'object' && cached.body !== null && res.json) {
          return res.json(cached.body);
        } else if (res.send) {
          return res.send(cached.body);
        } else if (res.end) {
          return res.end(cached.body);
        }
      }
    } catch (err) {
      next(err);
    }
  };
}

/** Alias matching legacy nomenclature */
export const expressCache = createExpressMiddleware;
