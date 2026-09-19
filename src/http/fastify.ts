import type { CacheService } from '../cache-service.js';
import type { WrapOptions } from '../types.js';
import {
  buildDeterministicKey,
  generateETag,
  shouldSkipCache,
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
}

export interface CachedFastifyResponse {
  body: unknown;
  contentType?: string;
  etag?: string;
  status: number;
}

/**
 * Creates a Fastify plugin that registers `onRequest` and `onSend` lifecycle hooks.
 *
 * Designed to bypass Fastify's route encapsulation barrier (`skip-override`),
 * allowing caching across global and nested route scopes.
 *
 * @example
 * import Fastify from 'fastify';
 * import { fastifyCachePlugin } from 'tricache/fastify';
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

      if (shouldSkipCache(req, mergedOpts.skipCache)) {
        return;
      }

      const key = buildDeterministicKey(req, {
        keyGenerator: mergedOpts.keyGenerator,
        headerWhitelist: mergedOpts.headerWhitelist,
      });

      const ifNoneMatch = req.headers
        ? (req.headers['if-none-match'] || req.headers['If-None-Match'])
        : undefined;

      // Fast probe in cache
      const cached = await activeCache!.get<CachedFastifyResponse | null>(
        key,
        async () => null,
        0
      );

      if (cached && typeof cached === 'object' && cached.body !== null) {
        if (cached.etag) {
          reply.header('ETag', cached.etag);
          if (ifNoneMatch === cached.etag) {
            reply.code(304);
            return reply.send();
          }
        }

        if (cached.contentType) {
          reply.header('Content-Type', cached.contentType);
        }

        reply.code(cached.status ?? 200);
        return reply.send(cached.body);
      }

      // Mark request for response capture in onSend
      req._tricacheKey = key;
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
      if (statusCode >= 200 && statusCode < 300 && payload !== undefined && payload !== null) {
        const payloadEtag = etag ? generateETag(payload) : undefined;
        const contentType = reply.getHeader('content-type')
          || (typeof payload === 'object' ? 'application/json' : 'text/plain');

        if (payloadEtag) {
          reply.header('ETag', payloadEtag);
        }

        const ifNoneMatch = req.headers
          ? (req.headers['if-none-match'] || req.headers['If-None-Match'])
          : undefined;

        if (ifNoneMatch && payloadEtag && ifNoneMatch === payloadEtag) {
          reply.code(304);
          return '';
        }

        // Asynchronously persist to cache without delaying current onSend pipeline
        const entry: CachedFastifyResponse = {
          body: payload,
          contentType,
          etag: payloadEtag,
          status: statusCode,
        };

        void activeCache!.set(key, entry, mergedOpts.ttl ?? ttl, undefined, {
          tags: req._tricacheTags,
        });
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
    if (shouldSkipCache(req, options.skipCache)) return;

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
    const cached = await activeCache.get<CachedFastifyResponse | null>(
      key,
      async () => null,
      0
    );

    if (cached && typeof cached === 'object' && cached.body !== null) {
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

      if (cached.status) {
        if (reply.code) reply.code(cached.status);
        else if (reply.status) reply.status(cached.status);
      }

      if (reply.send) return reply.send(cached.body);
      return;
    }

    // Miss path: intercept reply.send on completion
    const origSend = reply.send?.bind(reply);
    if (origSend) {
      reply.send = function (resPayload: any) {
        if (resPayload !== undefined && resPayload !== null) {
          const payloadEtag = options.etag !== false ? generateETag(resPayload) : undefined;
          const contentType = (reply.getHeader && reply.getHeader('content-type'))
            || (typeof resPayload === 'object' ? 'application/json' : 'text/plain');

          const respStatus = reply.statusCode ?? reply.raw?.statusCode ?? 200;
          if (respStatus >= 200 && respStatus < 300) {
            const resolvedTags = typeof options.tags === 'function' ? options.tags(req) : options.tags;
            void activeCache!.set(
              key,
              { body: resPayload, contentType, etag: payloadEtag, status: respStatus },
              options.ttl ?? 300,
              undefined,
              { tags: resolvedTags }
            );
          }

          if (ifNoneMatch && ifNoneMatch === payloadEtag) {
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
