# Fastify Plugin

> Package entry: `tricache/fastify`

First-class **Node.js** Fastify plugin backed by `CacheService`. This is the dedicated export requested for Fastify apps — the same implementation as [`tricache/http`](/integrations/http), not a second stack.

```typescript
import Fastify from 'fastify';
import { createFastifyPlugin, fastifyCachePlugin, fastifyCache } from 'tricache/fastify';

const app = Fastify();

await app.register(createFastifyPlugin({
  ttl: 300,
  tags: ['api'],
}));
```

`fastifyCachePlugin` is the zero-arg alias (`createFastifyPlugin()`). Pass options at register time:

```typescript
import { CacheService } from 'tricache';
import { fastifyCachePlugin } from 'tricache/fastify';

const cache = CacheService.create();

await app.register(fastifyCachePlugin, {
  cache,
  ttl: 300,
  swr: 60,
  tags: ['api'],
  headerWhitelist: ['accept-language'],
});
```

Route-level `preHandler` (ttl/tags without a global plugin):

```typescript
import { fastifyCache } from 'tricache/fastify';

app.get('/api/catalog', {
  preHandler: fastifyCache({ cache, ttl: 300, tags: ['catalog'] }),
}, async () => {
  return await fetchCatalog();
});
```

`import { createFastifyPlugin, fastifyCachePlugin, fastifyCache } from 'tricache/http'` remains supported for back-compat.

---

## Behavior

* **Safe methods only**: `GET` and `HEAD` are cached; other methods pass through.
* **Weak ETags**: SHA-1 weak validators (`ETag: W/"…"`).
* **304 Not Modified**: matching `If-None-Match` short-circuits with an empty body.
* **Status gate**: non-2xx responses are never kept (4xx/5xx cannot poison a key).
* **Bypass**: `Cache-Control: no-cache` / `no-store` and a custom `skipCache` predicate skip the cache.
* **ttl / tags**: already covered by plugin options and `fastifyCache({ ttl, tags })` `preHandler` opts.

Route-level `config.cache` and `x-cache: HIT|MISS|STALE` response headers are **not** in this entry. Those can land as a follow-up on the same plugin — this package does not introduce a second Fastify implementation.

---

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `cache` | `CacheService` | singleton | TriCache instance. If omitted, lazily resolves `CacheService.create()` |
| `ttl` | `number` | `300` | Time-to-live in seconds |
| `swr` | `number` | `undefined` | Stale-While-Revalidate window in seconds |
| `etag` | `boolean` | `true` | Generate and evaluate weak ETags (`W/"…"`) |
| `keyGenerator` | `(req) => string` | method + URL + sorted query | Custom cache key from the Fastify request |
| `headerWhitelist` | `string[]` | `[]` | Request headers incorporated into the cache key |
| `skipCache` | `(req) => boolean` | `undefined` | Predicate returning true to bypass cache |
| `tags` | `string[] \| ((req) => string[])` | `[]` | Semantic tags for targeted `cache.invalidateTag()` |
