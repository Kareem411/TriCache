# TriCache Express API Demo

Minimal Express microservice that uses [`createExpressMiddleware`](../../src/http/express.ts) from [`tricache/http`](https://kareem411.github.io/TriCache/integrations/http).

It shows the five behaviors from [Kareem411/TriCache#25](https://github.com/Kareem411/TriCache/issues/25):

| Behavior | What to look for |
|---|---|
| Weak ETag | `ETag: W/"…"` on `200` responses |
| RFC 7232 `304` | Repeat with `If-None-Match` → empty `304 Not Modified` |
| Deterministic query sorting | `?limit=5&page=2` and `?page=2&limit=5` share `generatedAt` + ETag |
| `headerWhitelist: ['accept-language']` | `en` vs `fr` are separate cache entries |
| `skipCache` for auth | `Authorization: Bearer …` always hits origin (no ETag, new `generatedAt`) |

Origin work is a simulated **350ms** catalog query. Cache hits replay the stored JSON and skip that delay. Hits do **not** replay `X-TriCache-Demo: origin` — that header is set only when the route handler runs.

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
cd examples/express-api
pnpm install
pnpm dev
```

`pnpm start` is the same command. The process listens on `http://127.0.0.1:3000`. Override with `PORT` / `HOST` / `ORIGIN_LATENCY_MS`.

If you installed `tricache` from npm instead of the repo link, `node --import tsx src/server.ts` (or `pnpm dev`) is enough — no root build step.

---

## Try it with `curl -i`

Keep the server running in another terminal. Use an explicit `Accept-Language`: an omitted language header and `Accept-Language: en` are **different** cache keys (the whitelist only adds the header when it is present).

### 1. Cold miss — weak ETag

```bash
curl -i 'http://127.0.0.1:3000/api/products?limit=5&page=2' \
  -H 'Accept-Language: en'
```

Expect `HTTP/1.1 200`, `ETag: W/"…"`, `X-TriCache-Demo: origin`, and a `generatedAt` timestamp. This request takes ~350ms.

### 2. Same page, swapped query — cache hit

```bash
curl -i 'http://127.0.0.1:3000/api/products?page=2&limit=5' \
  -H 'Accept-Language: en'
```

Expect the **same** `ETag` and `generatedAt`, no `X-TriCache-Demo` header, and a much faster response. TriCache sorts query parameters before hashing the key.

### 3. Conditional GET — `304 Not Modified`

Capture the ETag from a **GET** (`curl -sI` is HEAD, and HEAD is a different cache key):

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

Expect a new origin fetch (`X-TriCache-Demo: origin`), a **different** ETag, `lang: "fr"`, and localized names (for example `Haut-parleurs de bureau`). `User-Agent` and other non-whitelisted headers do not fragment the cache.

### 5. Authenticated request — `skipCache`

```bash
curl -i 'http://127.0.0.1:3000/api/products?limit=5&page=2' \
  -H 'Accept-Language: en' \
  -H 'Authorization: Bearer demo'
```

Expect `cacheBypassed: true`, `X-TriCache-Demo: origin`, **no** `ETag`, and a new `generatedAt` on every call. Repeat the same command to confirm the timestamp changes.

`Cache-Control: no-cache` / `no-store` also bypass the cache (built into `tricache/http`).

---

## Automated check

```bash
pnpm verify
```

Starts the server on port `34567` and asserts the five behaviors above.

---

## How the middleware is wired

```typescript
import { CacheService } from 'tricache';
import { createExpressMiddleware } from 'tricache/http';

const cache = CacheService.create({
  namespace: 'express-api-demo',
  disableRedis: true,
  disableDisk: true,
  invalidationBackplane: false,
});

app.get(
  '/api/products',
  createExpressMiddleware({
    cache,
    ttl: 120,
    swr: 30,
    etag: true,
    tags: ['products'],
    headerWhitelist: ['accept-language'],
    skipCache: (req) => Boolean(req.headers.authorization),
  }),
  productsHandler
);
```

The published options object is `{ cache, ttl, swr, etag, tags, headerWhitelist, skipCache }` — not `(cache, { ttlSeconds })`.
