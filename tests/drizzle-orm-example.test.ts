import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import { generateDrizzleCacheKey, withCache } from '../src/drizzle/index.js';
import { SEED_USERS, USERS_TAG } from '../examples/drizzle-orm/src/seed-data.js';

describe('Drizzle ORM Reference Example (examples/drizzle-orm)', () => {
  let cache: CacheService;

  beforeEach(() => {
    cache = CacheService.create({
      namespace: `drizzle_demo_test_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      disableRedis: true,
      disableDisk: true,
      invalidationBackplane: false,
      ttlJitterFactor: 0,
    });
  });

  afterEach(async () => {
    await cache.destroy();
  });

  it('seeds two admins and one member', () => {
    expect(SEED_USERS.filter((u) => u.role === 'admin')).toHaveLength(2);
    expect(SEED_USERS.filter((u) => u.role === 'member')).toHaveLength(1);
    expect(USERS_TAG).toBe('users');
  });

  it('fingerprints SQL + bind params the same way the demo does', () => {
    const admin = { sql: 'select "id" from "users" where "role" = ?', params: ['admin'] };
    const adminAgain = { sql: 'select "id" from "users" where "role" = ?', params: ['admin'] };
    const member = { sql: 'select "id" from "users" where "role" = ?', params: ['member'] };

    const k1 = generateDrizzleCacheKey(admin);
    const k2 = generateDrizzleCacheKey(adminAgain);
    const k3 = generateDrizzleCacheKey(member);

    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toMatch(/^drizzle:[a-f0-9]{32}$/);
  });

  it('implements demo pipeline: withCache miss/hit, background SWR, invalidateTag', async () => {
    let dbExecutions = 0;
    const admins = SEED_USERS.filter((u) => u.role === 'admin');

    const makeQuery = (params: unknown[] = ['admin']) => ({
      toSQL: () => ({
        sql: 'select * from users where role = ?',
        params,
      }),
      execute: async () => {
        dbExecutions++;
        return admins.map((u) => ({ ...u }));
      },
    });

    const first = await withCache(makeQuery(), { cache, ttl: 1, swr: 60, tags: [USERS_TAG] });
    expect(first).toEqual(admins);
    expect(dbExecutions).toBe(1);

    const second = await withCache(makeQuery(), { cache, ttl: 1, swr: 60, tags: [USERS_TAG] });
    expect(second).toEqual(admins);
    expect(dbExecutions).toBe(1);
    expect(cache.metrics().gets.l1Hits).toBeGreaterThanOrEqual(1);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const revalidationsBefore = cache.metrics().revalidations.total;
    const stale = await withCache(makeQuery(), { cache, ttl: 1, swr: 60, tags: [USERS_TAG] });
    expect(stale).toEqual(admins);
    expect(cache.metrics().revalidations.total).toBe(revalidationsBefore + 1);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dbExecutions).toBe(2);

    await cache.invalidateTag(USERS_TAG);
    const afterInvalidate = await withCache(makeQuery(), { cache, ttl: 1, swr: 60, tags: [USERS_TAG] });
    expect(afterInvalidate).toEqual(admins);
    expect(dbExecutions).toBe(3);
  });
});
