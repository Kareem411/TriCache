# TriCache Fastify API Demo

Minimal Fastify TypeScript app that uses the official Fastify helpers from [`tricache/http`](https://kareem411.github.io/TriCache/integrations/http):

| Export | Role in this demo |
|---|---|
| [`createFastifyPlugin`](../../src/http/fastify.ts) | Global `fastify.register(...)` — `onRequest` short-circuit + `onSend` capture |
| `fastifyCachePlugin` | Same factory with no preset options (`createFastifyPlugin()`); pass `{ cache, ttl, ... }` at `register()` |
| `fastifyCache` | Dual helper used as a route `preHandler` on `/api/catalog` |

It shows the behaviors from [Kareem411/TriCache#26](https://github.com/Kareem411/TriCache/issues/26):

| Behavior | What to look for |
|---|---|
| Global plugin | `GET /api/products` is cached by `onRequest` / `onSend` |
| Route `preHandler` | `GET /api/catalog` is cached by `preHandler: fastifyCache({ ... })` |
| Weak ETag | `ETag: W/"…"` on `200` responses |
| RFC 7232 `304` | Repeat with `If-None-Match` → empty `304 Not Modified` |
| Deterministic query sorting | `?limit=5&page=2` and `?page=2&limit=5` share `generatedAt` + ETag |
| `headerWhitelist: ['accept-language']` | `en` vs `fr` are separate cache entries (`/api/products`) |
| `skipCache` for auth | `Authorization: Bearer …` on `/api/products` always hits origin |

Origin work is a simulated **350ms** catalog query. Cache hits replay the stored JSON and skip that delay. Hits do **not** replay `X-TriCache-Demo: origin` — that header is set only when the route handler runs.

The published API is `createFastifyPlugin(options)` / `fastifyCache(options)` with an optional `cache` field — not `createFastifyPlugin(cache, options)`, and not `plugin.preHandler`.

Redis is not required. The demo uses an in-process L1 cache (`disableRedis: true`, `disableDisk: true`).

---

## Run locally

From the **repository root**, build the local `tricache` package (the example links to `../..`):

```bash
pnpm install
pnpm build
```

Then start the demo:

```bash
cd examples/fastify-api
pnpm install
pnpm dev
```

`pnpm start` is the same command. The process listens on `http://127.0.0.1:3000`. Override with `PORT` / `HOST` / `ORIGIN_LATENCY_MS`.

If you installed `tricache` from npm instead of the repo link, `node --import tsx src/server.ts` (or `pnpm dev`) is enough — no root build step.

---

## Try it with `curl -i`

Keep the server running in another terminal. Use an explicit `Accept-Language`: an omitted language header and `Accept-Language: en` are **different** cache keys (the whitelist only adds the header when it is present).

Capture the ETag from a **GET** (`curl -sI` is HEAD, and HEAD is a different cache key).

### 1. Global plugin — cold miss, weak ETag

```bash
curl -i 'http://127.0.0.1:3000/api/products?limit=5&page=2' \
  -H 'Accept-Language: en'
```

Expect `HTTP/1.1 200`, `ETag: W/"…"`, `X-TriCache-Demo: origin`, `"style":"global-plugin"`, and a `generatedAt` timestamp. This request takes ~350ms. The plugin captures the serialized body in `onSend`.

### 2. Global plugin — swapped query, cache hit (`onRequest` short-circuit)

```bash
curl -i 'http://127.0.0.1:3000/api/products?page=2&limit=5' \
  -H 'Accept-Language: en'
```

Expect the **same** `ETag` and `generatedAt`, no `X-TriCache-Demo` header, and a much faster response. The handler does not run.

### 3. Global plugin — `304 Not Modified`

```bash
ETAG=$(curl -sD - -o /dev/null 'http://127.0.0.1:3000/api/products?limit=5&page=2' \
  -H 'Accept-Language: en' \
  | awk -F': ' 'tolower($1)=="etag"{gsub("\r","",$2); print $2}')

curl -i 'http://127.0.0.1:3000/api/products?limit=5&page=2' \
  -H 'Accept-Language: en' \
  -H "If-None-Match: $ETAG"
```

Expect `HTTP/1.1 304 Not Modified`, the same `ETag`, and an **empty** body.

### 4. Language variants — `headerWhitelist`

```bash
curl -i 'http://127.0.0.1:3000/api/products?limit=5&page=2' \
  -H 'Accept-Language: fr'
```

Expect a new origin fetch (`X-TriCache-Demo: origin`), a **different** ETag, `lang: "fr"`, and localized names (for example `Haut-parleurs de bureau`).

### 5. Authenticated request — `skipCache`

```bash
curl -i 'http://127.0.0.1:3000/api/products?limit=5&page=2' \
  -H 'Accept-Language: en' \
  -H 'Authorization: Bearer demo'
```

Expect `cacheBypassed: true`, `X-TriCache-Demo: origin`, **no** `ETag`, and a new `generatedAt` on every call.

### 6. Route `preHandler` — miss, hit, and `304`

```bash
curl -i 'http://127.0.0.1:3000/api/catalog?limit=5&page=2' \
  -H 'Accept-Language: en'
```

Expect `"style":"route-preHandler"` and a weak ETag. Repeat the swapped query and the `If-None-Match` dance from steps 2–3 against `/api/catalog` — same hit / empty `304` behaviour, implemented by `fastifyCache` wrapping `reply.send` instead of Fastify lifecycle hooks.

`Cache-Control: no-cache` / `no-store` also bypass the cache (built into `tricache/http`).

---

## Automated check

```bash
pnpm typecheck
pnpm verify
```

`pnpm verify` starts the server on port `34568` and asserts plugin + preHandler hit / 304 behaviour.

---

## How the plugin is wired

```typescript
import Fastify from 'fastify';
import { CacheService } from 'tricache';
import { createFastifyPlugin, fastifyCache, fastifyCachePlugin } from 'tricache/http';

const cache = CacheService.create({
  namespace: 'fastify-api-demo',
  disableRedis: true,
  disableDisk: true,
  invalidationBackplane: false,
});

const app = Fastify();

// Global: onRequest short-circuit + onSend persistence.
await app.register(createFastifyPlugin({
  cache,
  ttl: 120,
  swr: 30,
  etag: true,
  tags: ['products'],
  headerWhitelist: ['accept-language'],
  skipCache: (req) => req.url?.split('?')[0] !== '/api/products'
    || Boolean(req.headers?.authorization),
}));

// Equivalent: await app.register(fastifyCachePlugin, { cache, ttl: 120, ... })

app.get('/api/catalog', {
  preHandler: fastifyCache({
    cache,
    ttl: 120,
    etag: true,
    tags: ['catalog'],
    headerWhitelist: ['accept-language'],
  }),
}, async () => fetchCatalog());
```

The published options object is `{ cache, ttl, swr, etag, tags, headerWhitelist, skipCache }` — not `(cache, { ttlSeconds })`.
