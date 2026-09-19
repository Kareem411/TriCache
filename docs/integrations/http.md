# Express & Fastify HTTP Middleware

> Package entry: `tricache/http`

TriCache provides enterprise-grade HTTP route caching middleware with weak ETag calculation, deterministic query sorting, and RFC 7232 `304 Not Modified` short-circuiting for Express, Fastify, Connect, and Node.js HTTP servers.

### Ready-to-run Express demo

A self-contained microservice lives at [`examples/express-api`](https://github.com/Kareem411/TriCache/tree/main/examples/express-api). It exercises weak ETags, `If-None-Match` → `304`, deterministic query sorting, `headerWhitelist: ['accept-language']`, and `skipCache` for `Authorization`.

```bash
pnpm install && pnpm build
cd examples/express-api
pnpm install
pnpm dev
```

Then follow the `curl -i` walkthrough in that README.

### Ready-to-run Fastify demo

A self-contained TypeScript app lives at [`examples/fastify-api`](https://github.com/Kareem411/TriCache/tree/main/examples/fastify-api). It exercises both official surfaces — global `createFastifyPlugin` / `fastifyCachePlugin` (`onRequest` short-circuit + `onSend` capture) and route-level `preHandler: fastifyCache(...)` — plus weak ETags and `If-None-Match` → `304`.

```bash
pnpm install && pnpm build
cd examples/fastify-api
pnpm install
pnpm dev
```

Then follow the `curl -i` walkthrough in that README.

---

## 1. Express & Connect (`createExpressMiddleware`)

Mount `createExpressMiddleware` on routes or routers:

```typescript
import express from 'express';
import { createExpressMiddleware } from 'tricache/http';
import { CacheService } from 'tricache';

const app = express();
const cache = CacheService.create();

// Route-level caching with automatic 304 Not Modified
app.get(
  '/api/products',
  createExpressMiddleware({
    cache,
    ttl: 300,
    swr: 60,
    headerWhitelist: ['accept-language'],
    tags: ['products'],
  }),
  async (req, res) => {
    const products = await db.products.findMany({ where: req.query });
    res.json(products);
  }
);
```

---

## 2. Fastify Plugin (`createFastifyPlugin`)

TriCache wraps Fastify middleware with `[Symbol.for('skip-override')] = true`, eliminating route encapsulation barriers.

### Global Plugin Registration
```typescript
import Fastify from 'fastify';
import { createFastifyPlugin } from 'tricache/http';
import { CacheService } from 'tricache';

const fastify = Fastify();
const cache = CacheService.create();

// Register globally across all GET routes
await fastify.register(createFastifyPlugin({
  cache,
  ttl: 120,
  headerWhitelist: ['x-tenant-id'],
}));
```

### Route-Level `preHandler` Hook

`createFastifyPlugin` returns a Fastify plugin (lifecycle hooks), not an object with `.preHandler`. Use `fastifyCache` when you want the same options object as either a plugin or a route hook:

```typescript
import { fastifyCache } from 'tricache/http';

fastify.get('/api/catalog', {
  preHandler: fastifyCache({ cache, ttl: 300 }),
}, async (request, reply) => {
  return await fetchCatalog();
});
```

---

## 3. RFC 7232 ETag Validation & Bandwidth Savings

1. **Automatic Weak ETags**: TriCache generates fast weak ETags (`ETag: W/"<hash>"`) across cached response bodies.
2. **Conditional Requests (`If-None-Match`)**: When clients or downstream CDNs present an `If-None-Match` header matching the cached ETag, TriCache halts execution before body serialization, returning an immediate `304 Not Modified` with zero response body bytes.
3. **Bandwidth Savings**: Eliminates up to 100% of redundant data transfer costs for high-traffic mobile applications, REST APIs, and microservice meshes.

---

## 4. Deterministic Key Derivation & Query Sorting

By default, TriCache generates deterministic cache keys using:
- HTTP method (`GET`)
- Request pathname
- **Lexicographically sorted query parameters**: `?limit=10&page=2` and `?page=2&limit=10` produce identical cache keys, maximizing cache hit ratios.
- **Whitelisted headers**: Only headers explicitly configured in `headerWhitelist` affect the cache key (e.g. `accept-language`, `x-tenant-id`), preventing cache fragmentation from random client headers.

---

## 5. Cache Bypass & Conditional Controls

TriCache respects standard HTTP client and server cache control semantics:

* **Client `Cache-Control`**: Requests containing `Cache-Control: no-cache` or `Cache-Control: no-store` bypass the cache and trigger a fresh origin query.
* **Custom `skipCache` Predicate**: Provide a custom rule to conditionally bypass caching (e.g. skip authenticated users or admin requests):

```typescript
app.get(
  '/api/search',
  createExpressMiddleware({
    cache,
    ttl: 60,
    skipCache: (req) => Boolean(req.headers['authorization']),
  }),
  searchHandler
);
```

* **Status Code Gating**: TriCache only caches successful 2xx responses. Error responses (4xx, 5xx) are never cached.

---

## 6. Options Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `cache` | `CacheService` | singleton | TriCache instance. If omitted, lazily resolves `CacheService.create()` |
| `ttl` | `number` | `300` | Time-to-live in seconds |
| `swr` | `number` | `undefined` | Stale-While-Revalidate window in seconds |
| `etag` | `boolean` | `true` | Generate and evaluate weak ETags (`W/"…"`) |
| `keyGenerator` | `(req) => string` | `buildDeterministicKey` | Custom cache key generator function |
| `headerWhitelist` | `string[]` | `[]` | Request headers incorporated into the cache key |
| `skipCache` | `(req) => boolean` | `undefined` | Predicate returning true to bypass cache |
| `tags` | `string[] \| ((req) => string[])` | `[]` | Semantic tags for targeted `cache.invalidateTag()` |
