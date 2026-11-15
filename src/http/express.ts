import type { CacheService } from '../cache-service.js';
import type { WrapOptions } from '../types.js';
import {
  buildDeterministicKey,
  generateETag,
  shouldSkipCache,
  isCacheableHttpResponse,
  isShareableHttpResponse,
  matchesETag,
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
  /** @deprecated Response refreshes run on live requests. Use data-level cache.get()/wrap() for SWR. */
  swr?: number;
}

export interface CachedHttpResponse {
  body: unknown;
  contentType?: string;
  etag?: string;
  status: number;
  binary?: boolean;
  headers?: Record<string, string | string[]>;
}

class UncacheableHttpResponse extends Error {
  constructor(readonly response: CachedHttpResponse, readonly shareable: boolean) {
    super('Response is not cacheable');
  }
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
    tags,
    skipCache,
    keyGenerator,
    headerWhitelist,
    cacheAuthenticated,
  } = options;

  return async (req: any, res: any, next: any) => {
    // Only cache safe, idempotent HTTP read methods
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }

    if (shouldSkipCache(req, skipCache, options)) {
      return next();
    }

    let activeCache = cache;
    if (!activeCache) {
      const { CacheService } = await import('../cache-service.js');
      activeCache = CacheService.create();
    }

    const keyOptions = { keyGenerator, headerWhitelist, cacheAuthenticated };
    const key = buildDeterministicKey(req, keyOptions);
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
            const rawWrite = res.write;
            const origJson = rawJson?.bind(res);
            const origSend = rawSend?.bind(res);
            const origEnd  = rawEnd?.bind(res);
            let settled = false;
            let streamed = false;

            const cleanup = () => {
              if (rawJson !== undefined) res.json = rawJson;
              if (rawSend !== undefined) res.send = rawSend;
              if (rawEnd !== undefined) res.end = rawEnd;
              if (rawWrite !== undefined) res.write = rawWrite;
              res.removeListener?.('close', onClose);
            };

            const settle = (response: CachedHttpResponse) => {
              if (settled) return;
              settled = true;
              respondedLocally = true;
              response.binary = Buffer.isBuffer(response.body);
              if (typeof res.getHeaders === 'function') {
                const headers: Record<string, string | string[]> = {};
                for (const [name, value] of Object.entries(res.getHeaders())) {
                  if (!['content-length', 'transfer-encoding', 'connection', 'set-cookie', 'etag', 'content-type'].includes(name.toLowerCase()) && value != null) {
                    headers[name] = Array.isArray(value) ? value as string[] : String(value);
                  }
                }
                response.headers = headers;
              }
              const header = (name: string) => res.getHeader?.(name);
              cleanup();
              if (!streamed && isCacheableHttpResponse(response.status, header, keyOptions)) resolve(response);
              else reject(new UncacheableHttpResponse(response, !streamed && isShareableHttpResponse(response.status, header, keyOptions)));
            };

            const onClose = () => {
              if (settled) return;
              settled = true;
              respondedLocally = true;
              cleanup();
              reject(new Error('Express response closed before completion'));
            };

            res.once?.('close', onClose);
            if (rawWrite) res.write = (...args: unknown[]) => {
              streamed = true;
              return rawWrite.apply(res, args);
            };

            const getStatusCode = () => (res.statusCode ?? 200);

            if (origJson) {
              res.json = (body: any) => {
                const status = getStatusCode();
                const bodyEtag = etag ? generateETag(body) : undefined;
                const contentType = res.getHeader?.('content-type') || 'application/json; charset=utf-8';

                settle({ body, contentType, etag: bodyEtag, status });

                if (isCacheableHttpResponse(status, name => res.getHeader?.(name), keyOptions) && bodyEtag && matchesETag(ifNoneMatch, bodyEtag)) {
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

                if (isCacheableHttpResponse(status, name => res.getHeader?.(name), keyOptions) && bodyEtag && matchesETag(ifNoneMatch, bodyEtag)) {
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
              res.end = (body?: unknown, ...args: unknown[]) => {
                const status = getStatusCode();
                const bodyEtag = etag && body != null ? generateETag(body) : undefined;
                const contentType = res.getHeader?.('content-type') as string | undefined;

                settle({ body, contentType, etag: bodyEtag, status });
                return origEnd(body, ...args);
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
        // res/next belong to this request and cannot be reused for background SWR.
        { swr: 0, tags: resolvedTags }
      );

      if (!respondedLocally && !res.headersSent) {
        for (const [name, value] of Object.entries(cached.headers ?? {})) res.setHeader?.(name, value);
        if (cached.etag) {
          if (res.setHeader) res.setHeader('ETag', cached.etag);
          if (matchesETag(ifNoneMatch, cached.etag)) {
            return res.status(304).end();
          }
        }

        if (cached.contentType && res.setHeader) {
          res.setHeader('Content-Type', cached.contentType);
        }

        if (cached.status && res.status) {
          res.status(cached.status);
        }

        if (req.method === 'HEAD') return res.end?.();
        if (cached.binary) {
          const body = Buffer.isBuffer(cached.body) ? cached.body : Buffer.from((cached.body as { data: number[] }).data);
          return res.send ? res.send(body) : res.end?.(body);
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
      if (err instanceof UncacheableHttpResponse) {
        if (respondedLocally || res.headersSent) return;
        // Never share a private, varied, cookie-setting, or partial response with another request.
        if (!err.shareable) return next();
        const response = err.response;
        if (response.contentType) res.setHeader?.('Content-Type', response.contentType);
        res.status?.(response.status);
        return typeof response.body === 'object' && response.body !== null && !response.binary && res.json
          ? res.json(response.body)
          : res.send ? res.send(response.body) : res.end?.(response.body);
      }
      next(err);
    }
  };
}

/** Alias matching legacy nomenclature */
export const expressCache = createExpressMiddleware;
