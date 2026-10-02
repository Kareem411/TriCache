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

* **Safe methods only**: `GET` and `HEAD` are cached; other HTTP methods pass through untouched.
* **Weak ETags**: SHA-1 weak validators (`ETag: W/"…"`) via the Node cryptographic helper.
* **RFC 7232 304 Not Modified**: matching `If-None-Match` short-circuits with a `304` status, omitting representation headers per RFC 7232.
* **Status gate**: non-2xx responses and `206 Partial Content` are never cached (prevents error or truncated range poisoning).
* **SWR error resilience**: if upstream fails with 5xx/4xx during background Stale-While-Revalidate, healthy stale data is retained instead of overwriting cache with errors.
* **Response Cache-Control protection**: downstream responses with `Cache-Control: no-store`, `no-cache`, or `private` are strictly excluded from shared multi-user cache tiers.
* **Streaming response passthrough**: Server-Sent Events (`Content-Type: text/event-stream`) bypass clone buffering automatically, preventing event-loop hangs.
* **Response header preservation**: custom headers (CORS `Access-Control-Allow-Origin`, custom trace IDs) are captured on miss and restored on cache hits.
* **Bypass**: request `Cache-Control: no-cache` / `no-store` and custom `skipCache` predicates bypass the cache.
* **SWR & tags**: `ttl`, `swr`, and `tags` are forwarded to `CacheService.get` with multi-tier Redis/in-memory generational tag invalidation.

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
