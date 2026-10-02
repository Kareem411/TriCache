import { generateDrizzleCacheKey } from 'tricache/drizzle';
import { db, queryLog } from './db.js';
import { users } from './schema.js';
import { resetAndSeed } from './seed.js';
import { createDemoCache, lastCacheEvent } from './cache.js';
import { cachedUsersByRole, fingerprintUsersByRole } from './queries.js';
import { QUERY_LATENCY_MS, QUERY_SWR_SEC, QUERY_TTL_SEC } from './config.js';
import { USERS_TAG } from './seed-data.js';
import { sleep, snapshot } from './observe.js';

function banner(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function eventLabel(): string {
  const ev = lastCacheEvent();
  if (!ev) return 'n/a';
  return ev.kind === 'hit' ? `HIT (${ev.tier})` : 'MISS';
}

async function main(): Promise<void> {
  resetAndSeed();
  queryLog.reset();

  const cache = createDemoCache(`drizzle-orm-demo-${Date.now()}`);

  console.log('TriCache + Drizzle ORM (`tricache/drizzle` `withCache`)');
  console.log(`ttl: ${QUERY_TTL_SEC}s   swr: ${QUERY_SWR_SEC}s   simulated SELECT: ${QUERY_LATENCY_MS}ms`);
  console.log('Redis is not required (disableRedis / disableDisk).');

  banner('1. Query fingerprinting (SQL text + bind params → cache key)');
  const adminFp = fingerprintUsersByRole('admin');
  const adminFpAgain = fingerprintUsersByRole('admin');
  const memberFp = fingerprintUsersByRole('member');

  console.log('admin SQL:', adminFp.sql);
  console.log('admin params:', adminFp.params);
  console.log('admin key:   ', adminFp.key);
  console.log('same SQL+params again →', adminFpAgain.key);
  console.log('member SQL:', memberFp.sql);
  console.log('member params:', memberFp.params);
  console.log('member key:  ', memberFp.key);
  console.log(
    'identical fingerprints:',
    adminFp.key === adminFpAgain.key,
    '   different roles differ:',
    adminFp.key !== memberFp.key,
  );
  console.log('key format: generateDrizzleCacheKey() → drizzle:<sha256-prefix>');

  banner('2. withCache miss then hit');
  const miss = await cachedUsersByRole(cache, 'admin');
  const afterMiss = snapshot(cache);
  console.log(
    `first admin query: ${eventLabel()}  ${miss.ms}ms  rows=${miss.value.length}  selects=${afterMiss.selects}  fetches=${afterMiss.fetches}`,
  );
  console.log(
    'names:',
    miss.value.map((u) => u.name).join(', '),
  );

  const hit = await cachedUsersByRole(cache, 'admin');
  const afterHit = snapshot(cache);
  console.log(
    `second admin query: ${eventLabel()}  ${hit.ms}ms  rows=${hit.value.length}  selects=${afterHit.selects}  l1Hits=${afterHit.l1Hits}`,
  );
  console.log('same key:', miss.key === hit.key, '  names unchanged:', hit.value.map((u) => u.name).join(', '));

  const member = await cachedUsersByRole(cache, 'member');
  const afterMember = snapshot(cache);
  console.log(
    `member query (different params): ${eventLabel()}  ${member.ms}ms  key=${member.key}  selects=${afterMember.selects}`,
  );
  console.log('member names:', member.value.map((u) => u.name).join(', '));

  banner(`3. Background SWR (ttl: ${QUERY_TTL_SEC}, swr: ${QUERY_SWR_SEC})`);
  console.log(`waiting ${QUERY_TTL_SEC * 1000 + 200}ms so the hard TTL elapses (SWR grace still open)...`);
  await sleep(QUERY_TTL_SEC * 1000 + 200);

  const selectsBeforeSwr = queryLog.selects;
  const revalidationsBefore = cache.metrics().revalidations.total;
  const stale = await cachedUsersByRole(cache, 'admin');
  const afterStale = snapshot(cache);
  console.log(
    `stale serve: ${eventLabel()}  ${stale.ms}ms  rows=${stale.value.length}  sync selects still ${selectsBeforeSwr}  (background refresh scheduled)`,
  );
  console.log(`revalidations counter: ${revalidationsBefore} → ${afterStale.revalidations}`);

  await sleep(QUERY_LATENCY_MS + 150);
  const afterRefresh = snapshot(cache);
  console.log(
    `after background refresh: selects ${selectsBeforeSwr} → ${afterRefresh.selects}  revalidations=${afterRefresh.revalidations}`,
  );

  banner(`4. Tag invalidation (cache.invalidateTag('${USERS_TAG}'))`);
  db.insert(users)
    .values({
      name: 'Barbara Liskov',
      email: 'barbara@example.com',
      role: 'admin',
      createdAt: new Date(),
    })
    .run();
  console.log('inserted Barbara Liskov (admin). cached admin list still stale until the tag is invalidated.');

  const staleAfterInsert = await cachedUsersByRole(cache, 'admin');
  console.log(
    `before invalidate: ${eventLabel()}  names=${staleAfterInsert.value.map((u) => u.name).join(', ')}`,
  );

  await cache.invalidateTag(USERS_TAG);
  console.log(`called cache.invalidateTag('${USERS_TAG}')`);

  const fresh = await cachedUsersByRole(cache, 'admin');
  const afterInvalidate = snapshot(cache);
  console.log(
    `after invalidate: ${eventLabel()}  ${fresh.ms}ms  names=${fresh.value.map((u) => u.name).join(', ')}  selects=${afterInvalidate.selects}`,
  );

  const final = snapshot(cache);
  console.log('\nDone.');
  console.log(
    `metrics: gets=${final.gets} l1Hits=${final.l1Hits} fetches=${final.fetches} revalidations=${final.revalidations} selects=${final.selects}`,
  );
  console.log(
    'fingerprint helper still matches runtime key:',
    generateDrizzleCacheKey({ sql: fresh.sql, params: fresh.params }) === fresh.key,
  );

  await cache.destroy().catch(() => {});
}

await main();
