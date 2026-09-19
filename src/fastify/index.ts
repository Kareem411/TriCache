/**
 * tricache/fastify — first-class Node.js Fastify plugin entry.
 *
 * Re-exports the existing Fastify plugin from `src/http/fastify.ts` so apps can:
 *
 *   import { createFastifyPlugin, fastifyCachePlugin, fastifyCache } from 'tricache/fastify';
 *
 * `import { … } from 'tricache/http'` remains supported for back-compat.
 *
 * Plugin `options` and route `preHandler` already accept `ttl` / `tags` (and
 * `swr`, `etag`, `skipCache`, `keyGenerator`, `headerWhitelist`). Route-level
 * `config.cache` and `x-cache: HIT|MISS|STALE` headers are intentionally left
 * for a follow-up so this entry does not fork a second Fastify stack.
 */

export {
  createFastifyPlugin,
  fastifyCachePlugin,
  fastifyCache,
  type FastifyCacheOptions,
  type CachedFastifyResponse,
} from '../http/fastify.js';
