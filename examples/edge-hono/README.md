# TriCache Hono + Cloudflare Workers Demo

Minimal [Hono](https://hono.dev) Worker that uses [`honoEdgeCache`](../../src/edge/hono.ts) and [`EdgeCacheService`](../../src/edge/cache.ts) from [`tricache/edge`](https://kareem411.github.io/TriCache/integrations/edge).

It shows the behaviors from [Kareem411/TriCache#27](https://github.com/Kareem411/TriCache/issues/27):

| Behavior | What to look for |
|---|---|
| Pure Web Standards | Worker path uses `Request` / `Response` / `crypto.subtle` only — no `nodejs_compat`, no `tricache` (Node) import |
| Weak ETag | `ETag: W/"…"` on `200` responses (`computeEdgeETag` via `crypto.subtle.digest('SHA-1', …)`) |
| RFC 7232 `304` | Repeat with `If-None-Match` → empty `304 Not Modified` |
| Deterministic query sorting | `?limit=5&page=2` and `?page=2&limit=5` share `generatedAt` + ETag |
| `headerWhitelist: ['accept-language']` | `en` vs `fr` are separate cache entries |
| MurmurHash3 Bloom filter | After a cached feed, `GET /stats/bloom-probe` reports `bloomMightContain: false` and `remoteGetSkipped: true` |

Origin work is a simulated **250ms** catalog query. Cache hits replay the stored JSON and skip that delay. Hits do **not** replay `X-TriCache-Demo: origin` — that header is set only when the route handler runs.

The published export is **`honoEdgeCache({ cache, ttl, … })`**. Older docs called this `createHonoEdgeMiddleware(cache, { ttlSeconds })` — that name is not exported from `tricache/edge`.

---

## Run locally

From the **repository root**, build the local `tricache` package (the example links to `../..`):

```bash
pnpm install
pnpm build
```

Then start the Worker with Wrangler (`pnpm dev` is `wrangler dev`):

```bash
cd examples/edge-hono
pnpm install
pnpm dev
```

`pnpm start` is the same command. Wrangler prints a local URL (default `http://127.0.0.1:8787`).

If you installed `tricache` from npm instead of the repo link, `pnpm dev` is enough — no root build step.

---

## Try it with `curl -i`

Keep `wrangler dev` running in another terminal. Use an explicit `Accept-Language`: an omitted language header and `Accept-Language: en` are **different** cache keys (the whitelist only adds the header when it is present).

Replace `8787` if Wrangler bound a different port.

### 1. Cold miss — weak ETag

```bash
curl -i 'http://127.0.0.1:8787/api/feed?limit=5&page=2' \
  -H 'Accept-Language: en'
```

Expect `HTTP/1.1 200`, `ETag: W/"…"`, `X-TriCache-Demo: origin`, and a `generatedAt` timestamp. This request takes ~250ms.

### 2. Same page, swapped query — cache hit

```bash
curl -i 'http://127.0.0.1:8787/api/feed?page=2&limit=5' \
  -H 'Accept-Language: en'
```

Expect the **same** `ETag` and `generatedAt`, no `X-TriCache-Demo` header, and a much faster response. TriCache sorts query parameters before hashing the key.

### 3. Conditional GET — `304 Not Modified`

Capture the ETag from a **GET** (`curl -sI` is HEAD, and HEAD is a different cache key):

```bash
ETAG=$(curl -sD - -o /dev/null 'http://127.0.0.1:8787/api/feed?limit=5&page=2' \
  -H 'Accept-Language: en' \
  | awk -F': ' 'tolower($1)=="etag"{gsub("\r","",$2); print $2}')

curl -i 'http://127.0.0.1:8787/api/feed?limit=5&page=2' \
  -H 'Accept-Language: en' \
  -H "If-None-Match: $ETAG"
```

Expect `HTTP/1.1 304 Not Modified`, the same `ETag`, and an **empty** body.

### 4. Language variants — `headerWhitelist`

```bash
curl -i 'http://127.0.0.1:8787/api/feed?limit=5&page=2' \
  -H 'Accept-Language: fr'
```

Expect a new origin fetch (`X-TriCache-Demo: origin`), a **different** ETag, `lang: "fr"`, and localized names (for example `Haut-parleurs de bureau`).

### 5. Authenticated request — `skipCache`

```bash
curl -i 'http://127.0.0.1:8787/api/feed?limit=5&page=2' \
  -H 'Accept-Language: en' \
  -H 'Authorization: Bearer demo'
```

Expect `cacheBypassed: true`, `X-TriCache-Demo: origin`, **no** `ETag`, and a new `generatedAt` on every call.

`Cache-Control: no-cache` / `no-store` also bypass the cache (built into `honoEdgeCache`).

### 6. Bloom filter cold-miss defense

```bash
curl -s 'http://127.0.0.1:8787/stats' | jq .
curl -s 'http://127.0.0.1:8787/stats/bloom-probe' | jq .
```

After at least one cached `/api/feed`, `/stats` shows `bloom.insertions > 0`. `/stats/bloom-probe` looks up a never-seen key: `bloomMightContain` is `false` and `remoteGetSkipped` is `true` — `EdgeCacheService` does not call L2.

---

## Automated check

```bash
pnpm verify
```

Starts `wrangler dev` on port `18787` and asserts ETag / 304 / query sorting / language / skipCache / Bloom skip.

---

## How the middleware is wired

```typescript
import { Hono } from 'hono';
import {
  EdgeCacheService,
  Murmur3BloomFilter,
  honoEdgeCache,
} from 'tricache/edge';

const bloom = new Murmur3BloomFilter();
const cache = new EdgeCacheService({
  namespace: 'edge-hono-demo',
  maxKeys: 2_000,
  bloomFilter: bloom,
  remoteStorage, // demo: in-memory IEdgeRemoteStorage; prod: CloudflareKVAdapter
});

const app = new Hono();

app.get(
  '/api/feed',
  honoEdgeCache({
    cache,
    ttl: 60,
    swr: 30,
    etag: true,
    tags: ['feed'],
    headerWhitelist: ['accept-language'],
    skipCache: (c) => Boolean(c.req.header('authorization')),
  }),
  feedHandler,
);
```

The published options object is `{ cache, ttl, swr, etag, tags, headerWhitelist, skipCache }` — not `(cache, { ttlSeconds })`. After `next()`, Hono marks `c.res` finalized; `honoEdgeCache` assigns the cached `Response` onto `c.res` so weak ETags are visible on the miss path as well as on hits.

Production L2: pass `new CloudflareKVAdapter(env.CACHE_KV)` or `new UpstashRedisAdapter({ url, token })` as `remoteStorage`. Those classes are exported from `tricache/edge`.

---

## Deploy

```bash
pnpm deploy
```

Requires a Cloudflare account and `wrangler login` (or API token env vars). This demo does not need KV / R2 / Durable Object bindings. Add a KV namespace and `CloudflareKVAdapter` when you want shared L2 across isolates.

Do not enable `nodejs_compat` unless you later import Node-only packages. `tricache/edge` is designed to run without it.
