import type { CacheService } from '../cache-service.js';
import type { WrapOptions } from '../types.js';
import {
  buildDeterministicKey,
  generateETag,
  shouldSkipCache,
  type KeyDerivationOptions,
} from '../http/utils.js';

/**
 * Minimal Koa context surface used by the middleware.
 * Compatible with `import('koa').Context` without taking a runtime dependency.
 */
export interface KoaCacheContext {
  method: string;
  url: string;
  originalUrl?: string;
  headers?: Record<string, string | string[] | undefined>;
  status: number;
  body: unknown;
  type?: string;
  get?(field: string): string;
  set?(field: string, val: string | number): void;
  request?: {
    method?: string;
    url?: string;
    headers?: Record<string, string | string[] | undefined>;
    header?: Record<string, string | string[] | undefined>;
  };
  response?: {
    get?(field: string): string | number | string[] | undefined;
    set?(field: string, val: string | number): void;
    type?: string;
    status?: number;
    body?: unknown;
  };
  res?: { headersSent?: boolean };
}

export type KoaNext = () => Promise<unknown>;
export type KoaMiddleware = (ctx: KoaCacheContext, next: KoaNext) => Promise<void>;

export interface KoaCacheOptions extends Omit<WrapOptions, 'tags'>, Omit<KeyDerivationOptions, 'keyGenerator'> {
  /** TriCache instance. If omitted, lazily resolves the default singleton via CacheService.create(). */
  cache?: CacheService;
  /** Whether to generate and evaluate weak ETags. Default: true. */
  etag?: boolean;
  /**
   * Koa-native cache key. Preferred over `keyGenerator` (issue #10 / `tricache/koa` surface).
   * Example: `(ctx) => ctx.url`
   */
  key?: (ctx: KoaCacheContext) => string;
  /** Express-compatible key derivation receiving a request-like object. */
  keyGenerator?: (req: any) => string;
  /** Custom predicate to skip caching dynamically for this request (e.g. authenticated sessions). */
  skipCache?: (ctx: KoaCacheContext) => boolean;
  /** Dynamic tags derivation from the Koa context. */
  tags?: string[] | ((ctx: KoaCacheContext) => string[]);
}

export interface CachedKoaResponse {
  body: unknown;
  contentType?: string;
  etag?: string;
  status: number;
}

function toRequestLike(ctx: KoaCacheContext) {
  const headers = ctx.headers
    ?? ctx.request?.headers
    ?? ctx.request?.header
    ?? {};
  const url = ctx.url ?? ctx.request?.url ?? '/';
  return {
    method: ctx.method ?? ctx.request?.method ?? 'GET',
    url,
    originalUrl: ctx.originalUrl ?? url,
    headers,
  };
}

function readRequestHeader(ctx: KoaCacheContext, name: string): string | undefined {
  const fromGet = ctx.get?.(name);
  if (typeof fromGet === 'string' && fromGet !== '') {
    return fromGet;
  }
  const headers = ctx.headers ?? ctx.request?.headers ?? ctx.request?.header;
  if (!headers) return undefined;
  const val = headers[name.toLowerCase()] ?? headers[name];
  if (val === undefined || val === null || val === '') return undefined;
  return Array.isArray(val) ? val.join(',') : String(val);
}

function writeResponseHeader(ctx: KoaCacheContext, name: string, value: string): void {
  if (ctx.set) {
    ctx.set(name, value);
    return;
  }
  ctx.response?.set?.(name, value);
}

function readResponseContentType(ctx: KoaCacheContext): string | undefined {
  const fromResponse = ctx.response?.get?.('content-type') ?? ctx.response?.get?.('Content-Type');
  if (typeof fromResponse === 'string' && fromResponse !== '') {
    return fromResponse;
  }
  if (typeof ctx.type === 'string' && ctx.type !== '') {
    return ctx.type;
  }
  if (typeof ctx.body === 'object' && ctx.body !== null && !Buffer.isBuffer(ctx.body)) {
    return 'application/json; charset=utf-8';
  }
  return undefined;
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function applyCachedResponse(
  ctx: KoaCacheContext,
  cached: CachedKoaResponse,
  ifNoneMatch: string | undefined,
): void {
  if (cached.etag) {
    writeResponseHeader(ctx, 'ETag', cached.etag);
    if (ifNoneMatch === cached.etag) {
      ctx.status = 304;
      ctx.body = null;
      return;
    }
  }

  if (cached.contentType) {
    writeResponseHeader(ctx, 'Content-Type', cached.contentType);
    ctx.type = cached.contentType;
  }

  ctx.status = cached.status ?? 200;
  ctx.body = cached.body;
}

/**
 * Creates a Koa middleware that provides deterministic response caching,
 * weak ETag generation, conditional 304 Not Modified short-circuiting, and
 * Cache-Control bypass controls. Mirrors `createExpressMiddleware`.
 *
 * @example
 * import Koa from 'koa';
 * import { koaCache } from 'tricache/koa';
 *
 * const app = new Koa();
 *
 * app.use(koaCache({
 *   ttl: 60,
 *   key: (ctx) => ctx.url,
 * }));
 */
export function createKoaMiddleware(options: KoaCacheOptions = {}): KoaMiddleware {
  const {
    cache,
    etag = true,
    ttl = 300,
    swr,
    tags,
    skipCache,
    key,
    keyGenerator,
    headerWhitelist,
  } = options;

  return async (ctx, next) => {
    const method = (ctx.method ?? ctx.request?.method ?? 'GET').toUpperCase();
    // Only cache safe, idempotent HTTP read methods
    if (method !== 'GET' && method !== 'HEAD') {
      await next();
      return;
    }

    const reqLike = toRequestLike(ctx);
    if (shouldSkipCache(reqLike, skipCache ? () => skipCache(ctx) : undefined)) {
      await next();
      return;
    }

    let activeCache = cache;
    if (!activeCache) {
      const { CacheService } = await import('../cache-service.js');
      activeCache = CacheService.create();
    }

    const cacheKey = key
      ? key(ctx)
      : buildDeterministicKey(reqLike, { keyGenerator, headerWhitelist });

    const ifNoneMatch = readRequestHeader(ctx, 'If-None-Match');
    const resolvedTags = typeof tags === 'function' ? tags(ctx) : tags;

    const cached = await activeCache.get<CachedKoaResponse>(
      cacheKey,
      async () => {
        await next();
        const status = ctx.status ?? 200;
        const bodyEtag = etag && ctx.body != null ? generateETag(ctx.body) : undefined;
        const contentType = readResponseContentType(ctx);
        const snapshot: CachedKoaResponse = {
          body: ctx.body,
          contentType,
          etag: bodyEtag,
          status,
        };

        if (bodyEtag) {
          writeResponseHeader(ctx, 'ETag', bodyEtag);
        }
        if (ifNoneMatch && bodyEtag && ifNoneMatch === bodyEtag) {
          ctx.status = 304;
          ctx.body = null;
        }

        return snapshot;
      },
      ttl,
      { swr, tags: resolvedTags },
    );

    // Status gate: only cache 2xx successful responses
    if (typeof cached.status === 'number' && !isSuccessStatus(cached.status)) {
      await activeCache.delete(cacheKey).catch(() => {});
      return;
    }

    if (ctx.res?.headersSent) {
      return;
    }

    applyCachedResponse(ctx, cached, ifNoneMatch);
  };
}

/** Alias matching the `tricache/koa` public surface from issue #10. */
export const koaCache = createKoaMiddleware;
