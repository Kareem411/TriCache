/**
 * tricache/prisma — First-class Prisma Client extension for TriCache.
 *
 * Usage:
 *   import { PrismaClient } from '@prisma/client';
 *   import { withTriCache } from 'tricache/prisma';
 *
 *   const prisma = new PrismaClient().$extends(
 *     withTriCache({
 *       cache,
 *       defaultTtl: 300,
 *       autoInvalidate: true, // Invalidate model tags on create/update/delete
 *     })
 *   );
 *
 *   // Query with cache options:
 *   const users = await prisma.user.findMany({
 *     where: { active: true },
 *     cache: { ttl: 60, tags: ['users'], swr: 30 },
 *   });
 */

import type { CacheService } from '../cache-service.js';
import type { WrapOptions } from '../types.js';
import crypto from 'crypto';

export interface PrismaCacheQueryOptions extends WrapOptions {
  /** Explicit cache key. Defaults to SHA-256 hash of (model + operation + args). */
  key?: string;
  /** Explicit tags for invalidation. Automatically includes `[model.toLowerCase()]`. */
  tags?: string[];
}

export interface PrismaTriCacheOptions {
  /** TriCache instance to use for caching. */
  cache: CacheService;
  /** Default TTL in seconds for cached queries (default: 300 s). */
  defaultTtl?: number;
  /** Whether to automatically invalidate model tags on write operations (default: true). */
  autoInvalidate?: boolean;
  /** Automatically cache all read queries even if `cache` options are not provided (default: false). */
  autoCache?: boolean;
}

const READ_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

const MUTATION_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

/** Recursively sorts object keys for deterministic serialization of nested query filters */
function deterministicStringify(val: unknown): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map(deterministicStringify).join(',')}]`;
  }
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${deterministicStringify(obj[k])}`).join(',')}}`;
}

/** Generate a deterministic SHA-256 hash key for a Prisma query. */
export function generatePrismaCacheKey(model: string, operation: string, args: unknown): string {
  const normalized = deterministicStringify({ model, operation, args });
  const hash = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32);
  return `prisma:${model.toLowerCase()}:${operation}:${hash}`;
}

/**
 * Creates a Prisma Client Extension for TriCache.
 */
export function withTriCache(options: PrismaTriCacheOptions) {
  const { cache, defaultTtl = 300, autoInvalidate = true, autoCache = false } = options;

  return {
    name: 'tricache-prisma-extension',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: {
          model: string;
          operation: string;
          args: Record<string, unknown> | undefined;
          query: (args: unknown) => Promise<unknown>;
        }) {
          const modelTag = model.toLowerCase();

          // Auto-invalidation on write operations
          if (autoInvalidate && MUTATION_OPERATIONS.has(operation)) {
            // Strip the cache pseudo-option here too — the read path removes it,
            // but the mutation path forwarded it verbatim to the Prisma engine.
            const { cache: _cacheOpt, ...cleanMutationArgs } = (args ?? {}) as Record<string, unknown>;
            const result = await query(cleanMutationArgs);
            await cache.invalidateTag(modelTag);
            return result;
          }

          // Read operations
          if (READ_OPERATIONS.has(operation)) {
            const queryArgs = args ?? {};
            const cacheConfig = (queryArgs as { cache?: PrismaCacheQueryOptions | boolean }).cache;

            if (cacheConfig !== undefined || autoCache) {
              const opts: PrismaCacheQueryOptions = typeof cacheConfig === 'object' && cacheConfig !== null
                ? cacheConfig
                : {};

              // Clone args without the `cache` property to pass clean args to Prisma query engine
              const { cache: _c, ...cleanArgs } = queryArgs as Record<string, unknown>;

              const key = opts.key ?? generatePrismaCacheKey(model, operation, cleanArgs);
              const tags = [...new Set([modelTag, ...(opts.tags ?? [])])];

              return cache.wrap(
                key,
                () => query(cleanArgs),
                {
                  ttl: opts.ttl ?? defaultTtl,
                  swr: opts.swr,
                  priority: opts.priority,
                  tags,
                  dependsOn: opts.dependsOn,
                  refreshAhead: opts.refreshAhead,
                  xfetchBeta: opts.xfetchBeta,
                  notFoundTtl: opts.notFoundTtl,
                },
              );
            }
          }

          return query(args);
        },
      },
    },
  };
}
