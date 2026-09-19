/**
 * Asserts the three behaviors from Kareem411/TriCache#28:
 * query fingerprinting, background SWR, and tag invalidation via cache.invalidateTag().
 */
import { generateDrizzleCacheKey } from 'tricache/drizzle';
import { db, queryLog } from './db.js';
import { users } from './schema.js';
import { resetAndSeed } from './seed.js';
import { cacheEvents, createDemoCache } from './cache.js';
import { cachedUsersByRole, fingerprintUsersByRole } from './queries.js';
import { QUERY_LATENCY_MS, QUERY_TTL_SEC } from './config.js';
import { USERS_TAG } from './seed-data.js';
import { sleep } from './observe.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  resetAndSeed();
  queryLog.reset();
  const cache = createDemoCache(`drizzle-orm-verify-${Date.now()}`);

  try {
    const adminA = fingerprintUsersByRole('admin');
    const adminB = fingerprintUsersByRole('admin');
    const member = fingerprintUsersByRole('member');
    assert(adminA.key === adminB.key, 'identical SQL+params must share a fingerprint');
    assert(adminA.key !== member.key, 'different bind params must produce a different fingerprint');
    assert(/^drizzle:[a-f0-9]{32}$/.test(adminA.key), `unexpected key shape: ${adminA.key}`);
    assert(adminA.sql.toLowerCase().includes('from'), 'toSQL() should return compiled SQL');
    assert(adminA.params.includes('admin'), 'admin fingerprint must include the role bind param');
    assert(member.params.includes('member'), 'member fingerprint must include the role bind param');

    const miss = await cachedUsersByRole(cache, 'admin');
    assert(miss.key === adminA.key, 'withCache key must match generateDrizzleCacheKey(toSQL())');
    assert(miss.value.length === 2, `expected 2 seeded admins, got ${miss.value.length}`);
    assert(miss.ms >= QUERY_LATENCY_MS * 0.5, `miss should pay SELECT latency, took ${miss.ms}ms`);
    assert(cacheEvents.some((e) => e.kind === 'miss' && e.key === miss.key), 'first read should record onMiss');
    const selectsAfterMiss = queryLog.selects;
    assert(selectsAfterMiss === 1, `first admin query should hit SQLite once, got ${selectsAfterMiss}`);

    const hit = await cachedUsersByRole(cache, 'admin');
    assert(hit.key === miss.key, 'repeat query must reuse the same fingerprint');
    assert(hit.value.map((u) => u.email).join() === miss.value.map((u) => u.email).join(), 'hit payload must match');
    assert(queryLog.selects === selectsAfterMiss, 'cache hit must not run another SELECT');
    assert(hit.ms < QUERY_LATENCY_MS, `hit should skip the ${QUERY_LATENCY_MS}ms SELECT delay, took ${hit.ms}ms`);
    assert(cache.metrics().gets.l1Hits >= 1, 'metrics().gets.l1Hits should increment on the second read');

    const memberRead = await cachedUsersByRole(cache, 'member');
    assert(memberRead.key === member.key, 'member query must use the member fingerprint');
    assert(memberRead.value.length === 1, 'seeded member roster should be Grace Hopper only');
    assert(queryLog.selects === selectsAfterMiss + 1, 'new params should miss and run a fresh SELECT');

    await sleep(QUERY_TTL_SEC * 1000 + 250);
    const selectsBeforeSwr = queryLog.selects;
    const revalidationsBefore = cache.metrics().revalidations.total;
    const stale = await cachedUsersByRole(cache, 'admin');
    assert(stale.value.length === 2, 'SWR should still serve the cached admin roster');
    assert(stale.ms < QUERY_LATENCY_MS, `SWR stale serve must be instant, took ${stale.ms}ms`);
    assert(queryLog.selects === selectsBeforeSwr, 'SWR must not block on the background SELECT');
    assert(
      cache.metrics().revalidations.total === revalidationsBefore + 1,
      `expected revalidations ${revalidationsBefore} + 1, got ${cache.metrics().revalidations.total}`,
    );

    await sleep(QUERY_LATENCY_MS + 200);
    assert(queryLog.selects === selectsBeforeSwr + 1, 'background SWR refresh should execute one SELECT');

    db.insert(users)
      .values({
        name: 'Barbara Liskov',
        email: 'barbara@example.com',
        role: 'admin',
        createdAt: new Date(),
      })
      .run();

    const cachedAfterInsert = await cachedUsersByRole(cache, 'admin');
    assert(
      !cachedAfterInsert.value.some((u) => u.email === 'barbara@example.com'),
      'mutation without invalidateTag must keep serving the cached roster',
    );

    await cache.invalidateTag(USERS_TAG);
    const fresh = await cachedUsersByRole(cache, 'admin');
    assert(
      fresh.value.some((u) => u.email === 'barbara@example.com'),
      'after cache.invalidateTag("users") the next withCache read must include the insert',
    );
    assert(fresh.value.length === 3, `expected 3 admins after invalidation, got ${fresh.value.length}`);
    assert(
      generateDrizzleCacheKey({ sql: fresh.sql, params: fresh.params }) === fresh.key,
      'runtime key must stay a SHA-256 fingerprint of SQL + params',
    );

    console.log('verify: fingerprinting, SWR, and tag invalidation all passed');
  } finally {
    await cache.destroy().catch(() => {});
  }
}

await main();
