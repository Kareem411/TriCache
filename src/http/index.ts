/**
 * tricache/http — Universal HTTP Caching, ETag generation, and 304 Not Modified middleware
 * for Express and Fastify.
 *
 * Usage with Express:
 *   import { createExpressMiddleware } from 'tricache/http';
 *   app.get('/api/users', createExpressMiddleware({ cache, ttl: 300, tags: ['users'] }), handler);
 *
 * Usage with Fastify:
 *   import { fastifyCachePlugin } from 'tricache/http';
 *   await fastify.register(fastifyCachePlugin, { cache, ttl: 300 });
 *
 * For Node Hono (CacheService, three-tier L1/L1.5/L2), use the dedicated entry:
 *   import { cacheMiddleware } from 'tricache/hono';
 *
 * For Edge runtimes (Cloudflare Workers, Vercel Edge, Deno) and Hono, use:
 *   import { honoEdgeCache } from 'tricache/edge';
 *
 * `honoCache` below remains the edge helper re-export for compatibility.
 */

export {
  buildDeterministicKey,
  shouldSkipCache,
  generateETag,
  type KeyDerivationOptions,
} from './utils.js';

export {
  createExpressMiddleware,
  expressCache,
  type ExpressCacheOptions,
  type ExpressCacheOptions as HttpCacheOptions,
  type CachedHttpResponse,
} from './express.js';

export {
  createFastifyPlugin,
  fastifyCachePlugin,
  fastifyCache,
  type FastifyCacheOptions,
  type CachedFastifyResponse,
} from './fastify.js';

export {
  honoEdgeCache as honoCache,
  computeEdgeETag,
  buildEdgeDeterministicKey,
  type HonoEdgeCacheOptions,
  type CachedEdgeHttpResponse,
} from '../edge/hono.js';
