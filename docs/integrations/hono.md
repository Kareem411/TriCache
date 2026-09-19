# Hono Node Middleware

> Package entry: `tricache/hono`

First-class **Node.js** Hono middleware backed by `CacheService` (L1 RAM → L1.5 disk → L2 Redis). This is the adapter requested for Hono apps running on Node — not the Web-Crypto edge helper under [`tricache/edge`](/integrations/edge).

```typescript
import { Hono } from 'hono';
import { cacheMiddleware } from 'tricache/hono';

const app = new Hono();

app.get('/api/posts', cacheMiddleware({ ttl: 300, tags: ['posts'] }), (c) => {
  return c.json({ data: '...' });
});
```

Pass an explicit `CacheService` when you already have one:

```typescript
import { CacheService } from 'tricache';
import { cacheMiddleware } from 'tricache/hono';

const cache = CacheService.create();

app.get(
  '/api/posts',
  cacheMiddleware({
    cache,
    ttl: 300,
    swr: 60,
    tags: ['posts'],
    headerWhitelist: ['accept-language'],
  }),
  (c) => c.json({ data: '...' }),
);
```

`createHonoMiddleware` is an alias of `cacheMiddleware`.

---

## Node vs edge

| Entry | Runtime | Cache engine | Import |
|:---|:---|:---|:---|
| **`tricache/hono`** | Node.js | `CacheService` | `import { cacheMiddleware } from 'tricache/hono'` |
| **`tricache/edge`** | Workers / edge isolates | `EdgeCacheService` | `import { honoEdgeCache } from 'tricache/edge'` |

`tricache/http` still re-exports the edge helper as `honoCache` for compatibility. New Node Hono apps should import `tricache/hono`.

---

## Behavior

* **Safe methods only**: `GET` and `HEAD` are cached; other methods pass through.
* **Weak ETags**: SHA-1 weak validators (`ETag: W/"…"`) via the same Node helper as Express.
* **304 Not Modified**: matching `If-None-Match` short-circuits with an empty body.
* **Status gate**: non-2xx responses are never kept (4xx/5xx cannot poison a key).
* **Bypass**: `Cache-Control: no-cache` / `no-store` and a custom `skipCache` predicate skip the cache.
* **SWR & tags**: `ttl`, `swr`, and `tags` are forwarded to `CacheService.get`, matching Express middleware.

---

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `cache` | `CacheService` | singleton | TriCache instance. If omitted, lazily resolves `CacheService.create()` |
| `ttl` | `number` | `300` | Time-to-live in seconds |
| `swr` | `number` | `undefined` | Stale-While-Revalidate window in seconds |
| `etag` | `boolean` | `true` | Generate and evaluate weak ETags (`W/"…"`) |
| `keyGenerator` | `(c) => string` | method + URL + sorted query | Custom cache key from the Hono context |
| `headerWhitelist` | `string[]` | `[]` | Request headers incorporated into the cache key |
| `skipCache` | `(c) => boolean` | `undefined` | Predicate returning true to bypass cache |
| `tags` | `string[] \| ((c) => string[])` | `[]` | Semantic tags for targeted `cache.invalidateTag()` |
