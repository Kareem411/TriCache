import type { CacheService } from '../cache-service.js';
import type { WrapOptions } from '../types.js';
import {
  buildDeterministicKey,
  generateETag,
  shouldSkipCache,
  isCacheableHttpResponse,
  matchesETag,
  type KeyDerivationOptions,
} from './utils.js';

export interface FastifyCacheOptions extends Omit<WrapOptions, 'tags'>, KeyDerivationOptions {
  /** TriCache instance. If omitted, lazily resolves the default singleton via CacheService.create(). */
  cache?: CacheService;
  /** Whether to generate and evaluate weak ETags. Default: true. */
  etag?: boolean;
  /** Custom predicate to skip caching dynamically for this request. */
  skipCache?: (req: any) => boolean;
  /** Dynamic tags derivation from request. */
  tags?: string[] | ((req: any) => string[]);
  /** @deprecated Response refreshes run on live requests. Use data-level cache.get()/wrap() for SWR. */
  swr?: number;
}

export interface CachedFastifyResponse {
  body: unknown;
  contentType?: string;
  etag?: string;
  status: number;
  binary?: boolean;
  headers?: Record<string, string | string[]>;
}

function responseBody(entry: CachedFastifyResponse): unknown {
  return entry.binary && !Buffer.isBuffer(entry.body) ? Buffer.from((entry.body as { data: number[] }).data) : entry.body;
}

/**
 * Creates a Fastify plugin that registers `onRequest` and `onSend` lifecycle hooks.
 *
 * Designed to bypass Fastify's route encapsulation barrier (`skip-override`),
 * allowing caching across global and nested route scopes.
 *
 * @example
 * import Fastify from 'fastify';
 * import { fastifyCachePlugin } from 'tricache/http';
 *
 * const app = Fastify();
 * await app.register(fastifyCachePlugin, {
 *   ttl: 300,
 *   tags: ['api'],
 * });
 */
export function createFastifyPlugin(options: FastifyCacheOptions = {}) {
  const plugin = async function (fastify: any, pluginOpts: FastifyCacheOptions = {}) {
    const mergedOpts = { ...options, ...pluginOpts };
    const etag = mergedOpts.etag ?? true;
    const ttl = mergedOpts.ttl ?? 300;
    let activeCache = mergedOpts.cache;

    if (!activeCache) {
      const { CacheService } = await import('../cache-service.js');
      activeCache = CacheService.create();
    }

    fastify.addHook('onRequest', async (req: any, reply: any) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return;
      }

      if (shouldSkipCache(req, mergedOpts.skipCache, mergedOpts)) {
        return;
      }

      const key = buildDeterministicKey(req, {
        keyGenerator: mergedOpts.keyGenerator,
        headerWhitelist: mergedOpts.headerWhitelist,
      });

      const ifNoneMatch = req.headers
        ? (req.headers['if-none-match'] || req.headers['If-None-Match'])
        : undefined;

      // Fast probe in cache without writing null entries on misses
      const cached = await activeCache!.peek<CachedFastifyResponse>(key);

      if (cached && typeof cached === 'object' && cached.body !== null) {
        for (const [name, value] of Object.entries(cached.headers ?? {})) reply.header(name, value);
        if (cached.etag) {
          reply.header('ETag', cached.etag);
          if (matchesETag(ifNoneMatch, cached.etag)) {
            reply.code(304);
            return reply.send();
          }
        }

        if (cached.contentType) {
          reply.header('Content-Type', cached.contentType);
        }

        reply.code(cached.status ?? 200);
        return reply.send(req.method === 'HEAD' ? undefined : responseBody(cached));
      }

      // Mark request for response capture in onSend
      req._tricacheKey = key;
      req._tricacheCanCommit = activeCache!.captureMutationFence(key);
      const resolvedTags = typeof mergedOpts.tags === 'function'
        ? mergedOpts.tags(req)
        : mergedOpts.tags;
      req._tricacheTags = resolvedTags;
    });

    fastify.addHook('onSend', async (req: any, reply: any, payload: unknown) => {
      const key = req._tricacheKey;
      if (!key) {
        return payload;
      }

      const statusCode = reply.statusCode ?? reply.raw?.statusCode ?? 200;

      // Status gate: only cache 2xx successful responses
      if (req._tricacheCanCommit?.() && isCacheableHttpResponse(statusCode, name => reply.getHeader(name), mergedOpts) && payload !== undefined && payload !== null &&
          !(typeof payload === 'object' && typeof (payload as { pipe?: unknown }).pipe === 'function')) {
        const payloadEtag = etag ? generateETag(payload) : undefined;
        const contentType = reply.getHeader('content-type')
          || (typeof payload === 'object' ? 'application/json' : 'text/plain');

        if (payloadEtag) {
          reply.header('ETag', payloadEtag);
        }

        const ifNoneMatch = req.headers
          ? (req.headers['if-none-match'] || req.headers['If-None-Match'])
          : undefined;

        // Asynchronously persist to cache without delaying current onSend pipeline
        const entry: CachedFastifyResponse = {
          body: payload,
          contentType,
          etag: payloadEtag,
          status: statusCode,
          binary: Buffer.isBuffer(payload),
          headers: reply.getHeaders ? Object.fromEntries(Object.entries(reply.getHeaders()).filter(([name]) =>
            !['content-length', 'transfer-encoding', 'connection', 'set-cookie', 'content-type', 'etag'].includes(name.toLowerCase()))) as Record<string, string | string[]> : undefined,
        };

        void activeCache!.set(key, entry, mergedOpts.ttl ?? ttl, undefined, {
          tags: req._tricacheTags,
        }).catch(() => {});
        if (payloadEtag && matchesETag(ifNoneMatch, payloadEtag)) {
          reply.code(304);
          return '';
        }
      }

      return payload;
    });
  };

  // Attach Fastify skip-override symbol so plugin is not scoped to child contexts
  (plugin as any)[Symbol.for('skip-override')] = true;
  return plugin;
}

/** Standard Fastify plugin export */
export const fastifyCachePlugin = createFastifyPlugin();

/**
 * Universal Fastify middleware: functions both as a Fastify plugin (`fastify.register(fastifyCache(options))`)
 * and as a route preHandler hook (`fastify.get('/route', { preHandler: fastifyCache(options) })`).
 */
export function fastifyCache(options: FastifyCacheOptions = {}) {
  const plugin = createFastifyPlugin(options);

  const dualHandler = async function (first: any, second?: any) {
    // If invoked as a Fastify plugin: (fastify, pluginOpts)
    if (first && typeof first.addHook === 'function') {
      return plugin(first, second);
    }

    // Otherwise invoked as a route preHandler: (req, reply)
    const req = first;
    const reply = second;

    if (req.method !== 'GET' && req.method !== 'HEAD') return;
    if (shouldSkipCache(req, options.skipCache, options)) return;

    let activeCache = options.cache;
    if (!activeCache) {
      const { CacheService } = await import('../cache-service.js');
      activeCache = CacheService.create();
    }

    const key = buildDeterministicKey(req, {
      keyGenerator: options.keyGenerator,
      headerWhitelist: options.headerWhitelist,
    });

    const ifNoneMatch = req.headers
      ? (req.headers['if-none-match'] || req.headers['If-None-Match'])
      : undefined;

    // Fast-path probe
    const cached = await activeCache.peek<CachedFastifyResponse>(key);

    if (cached && typeof cached === 'object' && cached.body !== null) {
      for (const [name, value] of Object.entries(cached.headers ?? {})) reply.header?.(name, value);
      if (cached.etag) {
        if (reply.header) reply.header('ETag', cached.etag);
        if (matchesETag(ifNoneMatch, cached.etag)) {
          if (reply.code) reply.code(304);
          else if (reply.status) reply.status(304);
          if (reply.send) return reply.send();
          return;
        }
      }

      if (cached.contentType && reply.header) {
        reply.header('Content-Type', cached.contentType);
      }

      if (cached.status) {
        if (reply.code) reply.code(cached.status);
        else if (reply.status) reply.status(cached.status);
      }

      if (reply.send) return reply.send(req.method === 'HEAD' ? undefined : responseBody(cached));
      return;
    }

    // Miss path: intercept reply.send on completion
    const canCommit = activeCache.captureMutationFence(key);
    const origSend = reply.send?.bind(reply);
    if (origSend) {
      reply.send = function (resPayload: any) {
        if (resPayload !== undefined && resPayload !== null) {
          const payloadEtag = options.etag !== false ? generateETag(resPayload) : undefined;
          const contentType = (reply.getHeader && reply.getHeader('content-type'))
            || (typeof resPayload === 'object' ? 'application/json' : 'text/plain');

          const respStatus = reply.statusCode ?? reply.raw?.statusCode ?? 200;
          const cacheable = isCacheableHttpResponse(respStatus, name => reply.getHeader?.(name), options);
          if (cacheable && canCommit() && !(typeof resPayload === 'object' && typeof resPayload.pipe === 'function')) {
            const resolvedTags = typeof options.tags === 'function' ? options.tags(req) : options.tags;
            void activeCache!.set(
              key,
              { body: resPayload, contentType, etag: payloadEtag, status: respStatus, binary: Buffer.isBuffer(resPayload) },
              options.ttl ?? 300,
              undefined,
              { tags: resolvedTags }
            ).catch(() => {});
          }

          if (cacheable && payloadEtag && matchesETag(ifNoneMatch, payloadEtag)) {
            if (reply.code) reply.code(304);
            else if (reply.status) reply.status(304);
            return origSend();
          }

          if (payloadEtag && reply.header) reply.header('ETag', payloadEtag);
        }
        return origSend(resPayload);
      };
    }
  };

  (dualHandler as any)[Symbol.for('skip-override')] = true;
  return dualHandler;
}
