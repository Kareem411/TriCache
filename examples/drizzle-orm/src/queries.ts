import { eq } from 'drizzle-orm';
import { generateDrizzleCacheKey, withCache, type DrizzleExecutableQuery } from 'tricache/drizzle';
import type { CacheService } from 'tricache';
import { db } from './db.js';
import { users, type User } from './schema.js';
import { QUERY_LATENCY_MS, QUERY_SWR_SEC, QUERY_TTL_SEC } from './config.js';
import { USERS_TAG, type UserRole } from './seed-data.js';
import { sleep } from './time.js';

export interface CachedQueryResult<T> {
  value: T;
  key: string;
  sql: string;
  params: unknown[];
  ms: number;
}

/**
 * Fresh builder every call. `execute()` is async so the simulated SELECT
 * delay yields — SWR background refresh must not block the stale serve
 * (better-sqlite3 itself is synchronous).
 */
export function usersByRoleQuery(role: UserRole): DrizzleExecutableQuery<User[]> {
  const query = db.select().from(users).where(eq(users.role, role));
  return {
    toSQL: () => query.toSQL(),
    async execute() {
      await sleep(QUERY_LATENCY_MS);
      if (typeof query.execute === 'function') {
        return await query.execute();
      }
      return await query;
    },
  };
}

export function fingerprintUsersByRole(role: UserRole): { key: string; sql: string; params: unknown[] } {
  const { sql, params } = usersByRoleQuery(role).toSQL();
  return { key: generateDrizzleCacheKey({ sql, params }), sql, params };
}

export async function cachedUsersByRole(
  cache: CacheService,
  role: UserRole,
): Promise<CachedQueryResult<User[]>> {
  const query = usersByRoleQuery(role);
  const { sql, params } = query.toSQL();
  const key = generateDrizzleCacheKey({ sql, params });
  const started = Date.now();
  const value = await withCache(query, {
    cache,
    ttl: QUERY_TTL_SEC,
    swr: QUERY_SWR_SEC,
    tags: [USERS_TAG],
  });
  return { value, key, sql, params, ms: Date.now() - started };
}
