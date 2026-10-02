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

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function applyHonoCachedResponse(
  c: HonoCacheContext,
  cached: CachedHonoResponse,
  ifNoneMatch: string | undefined,
): unknown {
  if (cached.etag && ifNoneMatch === cached.etag) {
    const result = c.body(null, 304, { ETag: cached.etag });
    if (result != null) {
      c.res = result as HonoCacheContext['res'];
    }
    return result;
  }

  const headers: Record<string, string> = {};
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

  const clone = typeof res.clone === 'function' ? res.clone() : undefined;
  const text = clone && typeof clone.text === 'function'
    ? await clone.text()
    : typeof res.body === 'string'
      ? res.body
      : '';

  const status = res.status ?? 200;
  const contentType = res.headers?.get?.('content-type') || 'text/plain; charset=utf-8';
  const bodyEtag = etag ? generateETag(text) : undefined;

  return {
    body: text,
    contentType,
    etag: bodyEtag,
    status,
  };
}

/**
 * Creates a Hono middleware that caches GET/HEAD responses through Node
 * `CacheService`, with Express-aligned ttl/tags/SWR options, weak ETags, and
 * RFC 7232 `If-None-Match` → `304 Not Modified`. Non-2xx responses are never kept.
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

  return async (c, next) => {
    const method = (c.req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return await next();
    }

    const reqLike = toRequestLike(c, headerWhitelist);
    if (shouldSkipCache(reqLike, skipCache ? () => skipCache(c) : undefined)) {
      return await next();
    }

    let activeCache = cache;
    if (!activeCache) {
      const { CacheService } = await import('../cache-service.js');
      activeCache = CacheService.create();
    }

    const key = keyGenerator
      ? keyGenerator(c)
      : buildDeterministicKey(reqLike, { headerWhitelist });

    const ifNoneMatch = readRequestHeader(c, 'if-none-match');
    const resolvedTags = typeof tags === 'function' ? tags(c) : tags;

    let ranNext = false;
    const cached = await activeCache.get<CachedHonoResponse>(
      key,
      async () => {
        ranNext = true;
        await next();
        return snapshotHonoResponse(c, etag);
      },
      ttl,
      { swr, tags: resolvedTags },
    );

    // Status gate: only cache 2xx successful responses
    if (typeof cached.status === 'number' && !isSuccessStatus(cached.status)) {
      await activeCache.delete(key).catch(() => {});
      if (!ranNext) {
        return await next();
      }
      return;
    }

    return applyHonoCachedResponse(c, cached, ifNoneMatch);
  };
}

/** Alias matching `createExpressMiddleware` / `createKoaMiddleware` naming. */
export const createHonoMiddleware = cacheMiddleware;
