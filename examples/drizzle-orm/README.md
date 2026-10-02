# TriCache Drizzle ORM Demo

Minimal TypeScript + SQLite project that uses [`withCache`](../../src/drizzle/index.ts) from [`tricache/drizzle`](https://kareem411.github.io/TriCache/integrations/drizzle).

It shows the three behaviors from [Kareem411/TriCache#28](https://github.com/Kareem411/TriCache/issues/28):

| Behavior | What to look for |
|---|---|
| Query fingerprinting | `query.toSQL()` → `generateDrizzleCacheKey({ sql, params })` → `drizzle:<32 hex chars>`. Same SQL + bind params share a key; `role = admin` vs `role = member` do not. |
| Background SWR | `withCache(query, { ttl, swr: 60, tags })`. After the hard TTL the next read is still a **HIT** (stale) and `cache.metrics().revalidations` increments while SQLite runs in the background. |
| Tag invalidation | `withCache(..., { tags: ['users'] })` then `cache.invalidateTag('users')` after an `INSERT`. The next read is a **MISS** and includes the new row. |

Origin `SELECT`s are delayed by **200ms** (`QUERY_LATENCY_MS`) so HIT vs MISS is visible in wall-clock time. Hits skip that delay and do not increment the SQL logger.

Redis is not required. The demo uses an in-process L1 cache (`disableRedis: true`, `disableDisk: true`).

SQLite is file-backed via `better-sqlite3` (no Postgres / Docker).

---

## Run locally

From the **repository root**, build the local `tricache` package (the example links to `../..`):

```bash
pnpm install
pnpm build
```

Then install and run the demo:

```bash
cd examples/drizzle-orm
pnpm install
pnpm seed
pnpm demo
```

`pnpm start` and `pnpm dev` are the same as `pnpm demo`.

`pnpm seed` writes `data/demo.sqlite` (gitignored). `pnpm demo` reseeds that file at startup so the walkthrough is deterministic.

If you installed `tricache` from npm instead of the repo link, `pnpm demo` is enough — no root build step.

### Exact commands (copy-paste)

```bash
# from the TriCache repository root
pnpm install
pnpm build
cd examples/drizzle-orm
pnpm install
pnpm seed
pnpm demo
```

---

## What the demo prints

### 1. Fingerprinting

`usersByRoleQuery('admin').toSQL()` is hashed with `generateDrizzleCacheKey`. Building the same query twice yields the same `drizzle:…` key. Switching the bind param to `'member'` yields a different key.

### 2. Miss then hit

The first `withCache` call records `onMiss`, pays the 200ms SELECT, and increments `cache.metrics().gets.fetches`. The second call records `onHit('l1')`, returns in well under 200ms, and does **not** increment the SQL logger.

### 3. Background SWR (`swr: 60`)

The adapter option is `swr` (seconds) on `WrapOptions` / `DrizzleCacheOptions` — not `swrSec`. This demo uses `ttl: 2` so you do not wait a full minute to observe the stale window. After ~2.2s the next `withCache` is still a HIT (stale body, no SELECT delay) and `cache.metrics().revalidations.total` goes up; a SELECT appears in the logger a moment later.

Override timings if you want:

```bash
QUERY_TTL_SEC=2 QUERY_SWR_SEC=60 QUERY_LATENCY_MS=200 pnpm demo
```

### 4. Tag invalidation

An `INSERT` of a new admin does **not** change the cached list. `await cache.invalidateTag('users')` drops every entry tagged `users`. The following `withCache` is a MISS and includes the new row.

---

## Automated check

```bash
pnpm verify
```

Reseeds SQLite and asserts fingerprint equality/inequality, miss/hit timings + SQL counts, SWR stale serve + `metrics().revalidations`, and `cache.invalidateTag('users')` after a mutation.

```bash
pnpm typecheck
```

---

## How `withCache` is wired

```typescript
import { CacheService } from 'tricache';
import { generateDrizzleCacheKey, withCache } from 'tricache/drizzle';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { users } from './schema';

const cache = CacheService.create({
  namespace: 'drizzle-orm-demo',
  disableRedis: true,
  disableDisk: true,
  invalidationBackplane: false,
});

const query = db.select().from(users).where(eq(users.role, 'admin'));
const { sql, params } = query.toSQL();
const key = generateDrizzleCacheKey({ sql, params }); // drizzle:<sha256>

const admins = await withCache(query, {
  cache,
  ttl: 2,
  swr: 60,
  tags: ['users'],
});

await cache.invalidateTag('users');
```

The published options object is `{ cache, ttl, swr, tags }` — the same `WrapOptions` fields the adapter forwards to `cache.wrap()`.

`tricache` / `tricache/drizzle` resolve through `"tricache": "link:../.."` (same pattern as `examples/express-api`).
