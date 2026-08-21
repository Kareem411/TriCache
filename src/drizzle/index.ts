/**
 * tricache/drizzle — First-class Drizzle ORM query caching wrapper for TriCache.
 *
 * Usage:
 *   import { withCache } from 'tricache/drizzle';
 *
 *   const activeUsers = await withCache(
 *     db.select().from(users).where(eq(users.active, true)),
 *     { cache, ttl: 300, tags: ['users'] }
 *   );
 */

import type { CacheService } from '../cache-service.js';
import type { WrapOptions } from '../types.js';
import crypto from 'crypto';

export interface DrizzleCacheOptions extends WrapOptions {
  /** TriCache instance to use. If omitted, uses process-level singleton `CacheService.create()`. */
  cache?: CacheService;
  /** Explicit cache key. If omitted, automatically derived from SHA-256 hash of `{ sql, params }`. */
  key?: string;
}

export interface DrizzleExecutableQuery<T> {
  toSQL(): { sql: string; params: unknown[] };
  execute?(): Promise<T>;
  then?: (onfulfilled?: (value: T) => unknown, onrejected?: (reason: unknown) => unknown) => Promise<unknown>;
}

/**
 * Generate a deterministic SHA-256 hash key for a Drizzle query based on its compiled SQL and parameters.
 */
export function generateDrizzleCacheKey(sqlInfo: { sql: string; params: unknown[] }): string {
  const normalized = JSON.stringify(sqlInfo);
  const hash = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32);
  return `drizzle:${hash}`;
}

/**
 * Wraps a Drizzle ORM query with TriCache caching.
 *
 * @param query Drizzle query builder or executable query instance.
 * @param options Cache options including TTL, tags, SWR, priority, and optional key.
 */
export async function withCache<T>(
  query: DrizzleExecutableQuery<T>,
  options: DrizzleCacheOptions = {},
): Promise<T> {
  const { cache, key, ttl = 300, swr, priority, tags, dependsOn, refreshAhead, xfetchBeta, notFoundTtl } = options;

  let activeCache = cache;
  if (!activeCache) {
    const { CacheService } = await import('../cache-service.js');
    activeCache = CacheService.create();
  }

  let cacheKey = key;
  if (!cacheKey) {
    if (typeof query.toSQL === 'function') {
      const sqlInfo = query.toSQL();
      cacheKey = generateDrizzleCacheKey(sqlInfo);
    } else {
      throw new Error('tricache/drizzle: query must provide a .toSQL() method or an explicit key option.');
    }
  }

  const executeFn = async (): Promise<T> => {
    if (typeof query.execute === 'function') {
      return await query.execute();
    } else if (typeof query.then === 'function') {
      return await (query as unknown as Promise<T>);
    }
    throw new Error('tricache/drizzle: query is neither executable via .execute() nor thenable.');
  };

  return activeCache.wrap(cacheKey, executeFn, {
    ttl,
    swr,
    priority,
    tags,
    dependsOn,
    refreshAhead,
    xfetchBeta,
    notFoundTtl,
  });
}
