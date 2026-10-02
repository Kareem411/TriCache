import type { EdgeCacheService } from './cache.js';

export interface HonoEdgeCacheOptions {
  /** EdgeCacheService instance. If omitted, requires explicit cache passing. */
  cache?: EdgeCacheService | any;
  /** Custom key generator. Defaults to deterministic method + URL + sorted query string. */
  keyGenerator?: (c: any) => string;
  /** Optional list of header names to include in the cache key. */
  headerWhitelist?: string[];
  /** Whether to generate and evaluate weak ETags. Default: true. */
  etag?: boolean;
  /** TTL in seconds. Default: 300. */
  ttl?: number;
  /** Stale-While-Revalidate window in seconds. Default: undefined. */
  swr?: number;
  /** Cache tags for invalidation. */
  tags?: string[] | ((c: any) => string[]);
  /** Predicate to skip caching dynamically. */
  skipCache?: (c: any) => boolean;
}

export interface CachedEdgeHttpResponse {
  body: string;
  contentType: string;
  headers?: Record<string, string>;
  etag?: string;
  status: number;
}

/**
 * Computes a weak ETag using Web Crypto API (crypto.subtle) without importing Node.js modules.
 */
export async function computeEdgeETag(text: string): Promise<string> {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const encoder = new TextEncoder();
      const data = encoder.encode(text);
      const hashBuf = await crypto.subtle.digest('SHA-1', data);
      const hashArr = Array.from(new Uint8Array(hashBuf));
      const hashHex = hashArr.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
      return `W/"${text.length.toString(16)}-${hashHex}"`;
    }
  } catch {
    // Fallback if subtle crypto is unavailable in test environment
  }

  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  }
  return `W/"${text.length.toString(16)}-${Math.abs(h).toString(16)}"`;
}

/**
 * Generates a deterministic cache key from standard Web Request / Hono context.
 */
export function buildEdgeDeterministicKey(c: any, options?: { keyGenerator?: (c: any) => string; headerWhitelist?: string[] }): string {
  if (options?.keyGenerator) {
    return options.keyGenerator(c);
  }

  const req = c.req;
  const method = (req.method || 'GET').toUpperCase();
  const rawUrl = req.url || '/';

  const qIdx = rawUrl.indexOf('?');
  const path = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  let queryString = '';

  if (qIdx >= 0) {
    const rawQuery = rawUrl.slice(qIdx + 1);
    try {
      const params = new URLSearchParams(rawQuery);
      params.sort();
      queryString = params.toString();
    } catch {
      queryString = rawQuery;
    }
  }

  let key = `edge:http:${method}:${path}`;
  if (queryString) {
    key += `?${queryString}`;
  }

  if (options?.headerWhitelist && options.headerWhitelist.length > 0 && req.header) {
    const sortedHeaders = [...options.headerWhitelist].sort();
    for (const h of sortedHeaders) {
      const val = req.header(h);
      if (val !== undefined && val !== null && val !== '') {
        key += `|h:${h.toLowerCase()}=${val}`;
      }
    }
  }

  return key;
}

class NonCacheableEdgeResponseError extends Error {
  readonly isNonCacheable = true;
  constructor(readonly response: CachedEdgeHttpResponse) {
    super(`Non-cacheable status: ${response.status}`);
    this.name = 'NonCacheableEdgeResponseError';
  }
}

/**
 * Pure Web Standards Hono middleware for V8 Edge Isolates (Cloudflare Workers, Fastly, Vercel Edge).
 *
 * Operates strictly with Web Request/Response and Web Crypto APIs.
 *
 * @example
 * import { Hono } from 'hono';
 * import { EdgeCacheService, honoEdgeCache } from 'tricache/edge';
 *
 * const app = new Hono();
 * const cache = new EdgeCacheService({ maxKeys: 10_000 });
 *
 * app.get('/api/feed', honoEdgeCache({ cache, ttl: 60 }), async (c) => {
 *   return c.json({ status: 'ok', timestamp: Date.now() });
 * });
 */
export function honoEdgeCache(options: HonoEdgeCacheOptions = {}) {
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

  return async (c: any, next: () => Promise<void>) => {
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD') {
      return await next();
    }

    if (skipCache && skipCache(c)) {
      return await next();
    }

    const cc = c.req.header?.('cache-control') || c.req.header?.('Cache-Control');
    if (typeof cc === 'string') {
      const lower = cc.toLowerCase();
      if (lower.includes('no-cache') || lower.includes('no-store')) {
        return await next();
      }
    }

    if (!cache) {
      // If no cache instance passed, proceed without caching
      return await next();
    }

    const key = buildEdgeDeterministicKey(c, { keyGenerator, headerWhitelist });
    const ifNoneMatch = c.req.header?.('if-none-match') || c.req.header?.('If-None-Match');
    const resolvedTags = typeof tags === 'function' ? tags(c) : tags;

    let ranNext = false;
    try {
      const cached = await cache.get(
        key,
        async () => {
          ranNext = true;
          await next();
          const res = c.res;
          if (!res) {
            return null;
          }

          const contentType = res.headers?.get?.('content-type') || 'text/plain; charset=utf-8';
          if (contentType.toLowerCase().includes('text/event-stream')) {
            throw new NonCacheableEdgeResponseError({
              body: '',
              contentType,
              status: 0,
            });
          }

          const cc = res.headers?.get?.('cache-control');
          if (cc) {
            const lowerCc = cc.toLowerCase();
            if (lowerCc.includes('no-store') || lowerCc.includes('no-cache') || lowerCc.includes('private')) {
              throw new NonCacheableEdgeResponseError({
                body: '',
                contentType,
                status: 0,
              });
            }
          }

          const statusCode = res.status ?? 200;
          if (statusCode < 200 || statusCode >= 300 || statusCode === 206) {
            throw new NonCacheableEdgeResponseError({
              body: '',
              contentType,
              status: statusCode,
            });
          }

          const clone = res.clone();
          const text = await clone.text();
          const bodyEtag = etag ? await computeEdgeETag(text) : undefined;

          const capturedHeaders: Record<string, string> = {};
          if (res.headers && typeof res.headers.forEach === 'function') {
            res.headers.forEach((value: string, name: string) => {
              const lower = name.toLowerCase();
              if (
                lower !== 'content-length' &&
                lower !== 'transfer-encoding' &&
                lower !== 'connection' &&
                lower !== 'etag' &&
                lower !== 'content-type'
              ) {
                capturedHeaders[name] = value;
              }
            });
          }

          const snapshot: CachedEdgeHttpResponse = {
            body: text,
            contentType,
            headers: capturedHeaders,
            etag: bodyEtag,
            status: statusCode,
          };

          return snapshot;
        },
        ttl,
        {
          swr,
          tags: resolvedTags,
          ctx: c.executionCtx,
        }
      );

      if (!cached) {
        return;
      }

      if (cached.etag && ifNoneMatch === cached.etag) {
        const notModifiedHeaders: Record<string, string> = { ETag: cached.etag };
        if (cached.headers?.['cache-control']) notModifiedHeaders['Cache-Control'] = cached.headers['cache-control'];
        if (cached.headers?.['vary']) notModifiedHeaders['Vary'] = cached.headers['vary'];
        return applyEdgeResponse(c, null, 304, notModifiedHeaders);
      }

      const headers: Record<string, string> = { ...cached.headers };
      if (cached.etag) headers['ETag'] = cached.etag;
      if (cached.contentType) headers['Content-Type'] = cached.contentType;

      return applyEdgeResponse(c, cached.body, cached.status ?? 200, headers);
    } catch (err: unknown) {
      if (err instanceof NonCacheableEdgeResponseError) {
        if (!ranNext) {
          return await next();
        }
        return;
      }
      throw err;
    }
  };
}

/**
 * Hono's `compose` ignores a middleware return value once `next()` has set
 * `c.res` (`finalized === true`). Assigning `c.res` replaces the downstream
 * body so weak ETags and 304s are visible on both cache miss and hit.
 */
function applyEdgeResponse(
  c: any,
  body: string | null,
  status: number,
  headers: Record<string, string>,
): Response {
  const response = c.body(body, status, headers);
  c.res = response;
  return response;
}
