/**
 * tricache/hono — first-class Node.js Hono middleware on CacheService.
 *
 * This is the Node three-tier path (L1 RAM → L1.5 disk → L2 Redis), not the
 * Web-Crypto edge helper exported from `tricache/edge` / `tricache/http`.
 *
 * Usage:
 *   import { Hono } from 'hono';
 *   import { cacheMiddleware } from 'tricache/hono';
 *
 *   const app = new Hono();
 *   app.get('/api/posts', cacheMiddleware({ ttl: 300, tags: ['posts'] }), (c) => {
 *     return c.json({ data: '...' });
 *   });
 */

import type { CacheService } from '../cache-service.js';
import type { WrapOptions } from '../types.js';
import {
  buildDeterministicKey,
  generateETag,
  shouldSkipCache,
  type KeyDerivationOptions,
} from '../http/utils.js';

/**
 * Minimal Hono context surface used by the middleware.
 * Compatible with `import('hono').Context` without taking a runtime dependency.
 */
export interface HonoCacheContext {
  req: {
    method: string;
    url: string;
    header?: (name: string) => string | undefined;
    headers?: Headers | Record<string, string | string[] | undefined>;
  };
  res?: {
    status?: number;
    headers?: { get(name: string): string | null | undefined };
    clone?: () => { text: () => Promise<string> };
    body?: unknown;
  };
  body: (data: unknown, status?: number, headers?: Record<string, string>) => unknown;
  executionCtx?: unknown;
}

export type HonoNext = () => Promise<void>;
export type HonoMiddleware = (c: HonoCacheContext, next: HonoNext) => Promise<unknown>;

export interface HonoCacheOptions extends Omit<WrapOptions, 'tags'>, Omit<KeyDerivationOptions, 'keyGenerator'> {
  /** TriCache instance. If omitted, lazily resolves the default singleton via CacheService.create(). */
  cache?: CacheService;
  /** Whether to generate and evaluate weak ETags. Default: true. */
  etag?: boolean;
  /** Custom cache key. Overrides default method + URL + sorted query derivation. */
  keyGenerator?: (c: HonoCacheContext) => string;
  /** Custom predicate to skip caching dynamically (e.g. authenticated sessions). */
  skipCache?: (c: HonoCacheContext) => boolean;
  /** Dynamic tags derivation from the Hono context. */
  tags?: string[] | ((c: HonoCacheContext) => string[]);
}

export interface CachedHonoResponse {
  body: string;
  contentType?: string;
  headers?: Record<string, string>;
  etag?: string;
  status: number;
}

function readRequestHeader(c: HonoCacheContext, name: string): string | undefined {
  const headerFn = c.req.header;
  if (typeof headerFn === 'function') {
    const viaFn = headerFn(name) ?? headerFn(name.toLowerCase());
    if (viaFn !== undefined && viaFn !== null && viaFn !== '') {
      return viaFn;
    }
  }

  const raw = c.req.headers;
  if (!raw) return undefined;

  if (typeof (raw as Headers).get === 'function') {
    const viaGet = (raw as Headers).get(name);
    if (viaGet) return viaGet;
  }

  const record = raw as Record<string, string | string[] | undefined>;
  const val = record[name.toLowerCase()] ?? record[name];
  if (val === undefined || val === null || val === '') return undefined;
  return Array.isArray(val) ? val.join(',') : String(val);
}

function toRequestLike(c: HonoCacheContext, headerWhitelist?: string[]) {
  const headers: Record<string, string | undefined> = {};
  const cacheControl = readRequestHeader(c, 'cache-control');
  const ifNoneMatch = readRequestHeader(c, 'if-none-match');

  if (cacheControl) {
    headers['cache-control'] = cacheControl;
    headers['Cache-Control'] = cacheControl;
  }
  if (ifNoneMatch) {
    headers['if-none-match'] = ifNoneMatch;
    headers['If-None-Match'] = ifNoneMatch;
  }

  if (headerWhitelist) {
    for (const h of headerWhitelist) {
      headers[h.toLowerCase()] = readRequestHeader(c, h);
    }
  }

  return {
    method: (c.req.method || 'GET').toUpperCase(),
    url: c.req.url || '/',
    headers,
  };
}

function isCacheableStatus(status: number): boolean {
  // Only standard successful full responses (never 206 Partial Content or non-2xx)
  return status >= 200 && status < 300 && status !== 206;
}

function hasNoStoreDirective(cacheControl: string | null | undefined): boolean {
  if (!cacheControl) return false;
  const lower = cacheControl.toLowerCase();
  return lower.includes('no-store') || lower.includes('no-cache') || lower.includes('private');
}

function applyHonoCachedResponse(
  c: HonoCacheContext,
  cached: CachedHonoResponse,
  ifNoneMatch: string | undefined,
): unknown {
  if (cached.etag && ifNoneMatch === cached.etag) {
    const notModifiedHeaders: Record<string, string> = { ETag: cached.etag };
    if (cached.headers?.['cache-control']) notModifiedHeaders['Cache-Control'] = cached.headers['cache-control'];
    if (cached.headers?.['vary']) notModifiedHeaders['Vary'] = cached.headers['vary'];
    const result = c.body(null, 304, notModifiedHeaders);
    if (result != null) {
      c.res = result as HonoCacheContext['res'];
    }
    return result;
  }

  const headers: Record<string, string> = { ...cached.headers };
  if (cached.etag) headers['ETag'] = cached.etag;
  if (cached.contentType) headers['Content-Type'] = cached.contentType;

  const result = c.body(cached.body, cached.status ?? 200, headers);
  if (result != null) {
    c.res = result as HonoCacheContext['res'];
  }
  return result;
}

async function snapshotHonoResponse(
  c: HonoCacheContext,
  etag: boolean,
): Promise<CachedHonoResponse> {
  const res = c.res;
  if (!res) {
    return { body: '', status: 0 };
  }

  const contentType = res.headers?.get?.('content-type') || 'text/plain; charset=utf-8';
  if (contentType.toLowerCase().includes('text/event-stream')) {
    // Never buffer or cache Server-Sent Events / infinite streams
    return { body: '', contentType, status: 0 };
  }

  const cacheControl = res.headers?.get?.('cache-control');
  if (hasNoStoreDirective(cacheControl)) {
    // Response explicitly forbids caching / shared caching
    return { body: '', contentType, status: 0 };
  }

  const status = res.status ?? 200;
  if (!isCacheableStatus(status)) {
    return { body: '', contentType, status };
  }

  const clone = typeof res.clone === 'function' ? res.clone() : undefined;
  const text = clone && typeof clone.text === 'function'
    ? await clone.text()
    : typeof res.body === 'string'
      ? res.body
      : '';

  const bodyEtag = etag ? generateETag(text) : undefined;

  const capturedHeaders: Record<string, string> = {};
  if (res.headers && typeof (res.headers as any).forEach === 'function') {
    (res.headers as any).forEach((value: string, name: string) => {
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

  return {
    body: text,
    contentType,
    headers: capturedHeaders,
    etag: bodyEtag,
    status,
  };
}

class NonCacheableHonoResponseError extends Error {
  readonly isNonCacheable = true;
  constructor(readonly response: CachedHonoResponse) {
    super(`Non-cacheable response: status=${response.status}`);
    this.name = 'NonCacheableHonoResponseError';
  }
}

/**
 * Creates a Hono middleware that caches GET/HEAD responses through Node
 * `CacheService`, with Express-aligned ttl/tags/SWR options, weak ETags, and
 * RFC 7232 `If-None-Match` → `304 Not Modified`. Non-2xx, 206 Partial Content,
 * private/no-store, and streaming SSE responses are never kept.
 *
 * @example
 * import { Hono } from 'hono';
 * import { CacheService } from 'tricache';
 * import { cacheMiddleware } from 'tricache/hono';
 *
 * const app = new Hono();
 * const cache = CacheService.create();
 *
 * app.get(
 *   '/api/posts',
 *   cacheMiddleware({ cache, ttl: 300, tags: ['posts'] }),
 *   (c) => c.json({ data: '...' }),
 * );
 */
export function cacheMiddleware(options: HonoCacheOptions = {}): HonoMiddleware {
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

  let resolvedCache = cache;

  return async (c, next) => {
    const method = (c.req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return await next();
    }

    const reqLike = toRequestLike(c, headerWhitelist);
    if (shouldSkipCache(reqLike, skipCache ? () => skipCache(c) : undefined)) {
      return await next();
    }

    if (!resolvedCache) {
      const { CacheService } = await import('../cache-service.js');
      resolvedCache = CacheService.create();
    }
    const activeCache = resolvedCache;

    const key = keyGenerator
      ? keyGenerator(c)
      : buildDeterministicKey(reqLike, { headerWhitelist });

    const ifNoneMatch = readRequestHeader(c, 'if-none-match');
    const resolvedTags = typeof tags === 'function' ? tags(c) : tags;

    let ranNext = false;
    try {
      const cached = await activeCache.get<CachedHonoResponse>(
        key,
        async () => {
          ranNext = true;
          await next();
          const snapshot = await snapshotHonoResponse(c, etag);
          if (!isCacheableStatus(snapshot.status)) {
            throw new NonCacheableHonoResponseError(snapshot);
          }
          return snapshot;
        },
        ttl,
        { swr, tags: resolvedTags },
      );

      return applyHonoCachedResponse(c, cached, ifNoneMatch);
    } catch (err: unknown) {
      if (err instanceof NonCacheableHonoResponseError) {
        if (!ranNext) {
          return await next();
        }
        return;
      }
      throw err;
    }
  };
}

/** Alias matching `createExpressMiddleware` / `createKoaMiddleware` naming. */
export const createHonoMiddleware = cacheMiddleware;
