# Drizzle ORM Wrapper

> Package entry: `tricache/drizzle`

TriCache provides a lightweight query wrapper for Drizzle ORM (`withCache`) that transparently caches query results using deterministic SQL + parameterized argument hashing.

### Ready-to-run SQLite demo

A self-contained TypeScript project lives at [`examples/drizzle-orm`](https://github.com/Kareem411/TriCache/tree/main/examples/drizzle-orm). It exercises query fingerprinting (`generateDrizzleCacheKey`), background SWR (`swr: 60`), and `cache.invalidateTag('users')` after mutations.

```bash
pnpm install && pnpm build
cd examples/drizzle-orm
pnpm install
pnpm seed
pnpm demo
```

Then follow the printed walkthrough (or `pnpm verify`) in that README.

---

## Usage

Wrap any Drizzle `select` query statement with `withCache`:

```typescript
import { withCache } from 'tricache/drizzle';
import { db } from './db';
import { users } from './schema';
import { eq } from 'drizzle-orm';
import { cache } from './cache';

const query = db
  .select()
  .from(users)
  .where(eq(users.role, 'admin'));

// Execute or return from TriCache
const admins = await withCache(query, {
  cache,
  ttl: 600,            // 10-minute hard TTL (WrapOptions.ttl, seconds)
  swr: 60,             // 60-second SWR grace (WrapOptions.swr, seconds)
  tags: ['admins'],    // Semantic tag for cache.invalidateTag()
});
```

---

## Architectural Properties

### Deterministic SQL Hashing
Drizzle queries compile down to parameterized SQL (`query.toSQL()`). TriCache generates cache keys by hashing:
$$\text{Key} = \text{sha256}(\text{sql} + \text{stringify}(\text{params}))$$

This guarantees that identical SQL statements with identical parameter bindings resolve to the same cache entry across all cluster nodes.

### Zero Result Mutation
Query results are serialized using `msgpackr` 2.1.0 records, preserving Date instances, BigInt values, and null values with zero loss of type precision.

---

## Mutation Invalidation

Combine with TriCache's atomic tag invalidation after mutations:

```typescript
// Insert new admin
await db.insert(users).values({ name: 'Alice', role: 'admin' });

// Invalidate all queries tagged with 'admins' across all pods in O(1) time
await cache.invalidateTag('admins');
```
