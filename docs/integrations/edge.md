# Edge Isolates & Serverless Runtimes

> Package entry: `tricache/edge`

TriCache provides a zero-Node-dependency caching engine engineered specifically for modern Web Standards and V8 edge isolates:
- **Cloudflare Workers**
- **Vercel Edge Runtime**
- **Fastly Compute@Edge**
- **Deno Deploy**
- **Hono & Bun**

`tricache/edge` is completely decoupled from Node.js native bindings (`node:fs`, `node:worker_threads`, and SQLite) and runs strictly on Web standard APIs (`Request`, `Response`, `crypto.subtle`).

### Ready-to-run Hono + Cloudflare Workers demo

A self-contained Worker lives at [`examples/edge-hono`](https://github.com/Kareem411/TriCache/tree/main/examples/edge-hono). It exercises `honoEdgeCache`, Web Crypto weak ETags, `If-None-Match` → `304`, deterministic query sorting, and an in-memory `Murmur3BloomFilter` cold-miss defense.

```bash
pnpm install && pnpm build
cd examples/edge-hono
pnpm install
pnpm dev
```

Then follow the `curl -i` walkthrough in that README (`pnpm verify` automates the same checks).

---

## 1. Quick Start in Cloudflare Workers

```typescript
import { EdgeCacheService } from 'tricache/edge';

// Reuse within the isolate; constructing per request discards the local cache.
const cache = new EdgeCacheService({ maxKeys: 5_000, bloomFilter: true });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const data = await cache.get(
      `route:${url.pathname}`,
      async () => {
        return await fetchFromOrigin(url.pathname);
      },
      300 // 5-minute TTL
    );

    return Response.json(data);
  },
};
```

---

## 2. Decoupled Hono Edge Middleware (`honoEdgeCache`)

TriCache includes native middleware for Hono edge applications. The published export is `honoEdgeCache({ cache, ttl, … })` from `tricache/edge` (`src/edge/hono.ts`).

```typescript
import { Hono } from 'hono';
import { EdgeCacheService, honoEdgeCache } from 'tricache/edge';

const app = new Hono();
const edgeCache = new EdgeCacheService({ maxKeys: 2_000 });

// Mount route cache with ETag calculation & 304 short-circuiting
app.get(
  '/api/feed',
  honoEdgeCache({
    cache: edgeCache,
    ttl: 180,
    headerWhitelist: ['accept-language'],
  }),
  async (c) => {
    const feed = await fetchLatestFeed();
    return c.json(feed);
  }
);
```

### Key Edge Middleware Features:
* **Zero Node Native Dependencies**: Pure Web Standards (`crypto.subtle`, `Headers`, `Response`).
* **Web Crypto Weak ETags**: Automatically calculates SHA-1 / Murmur3 digests using `crypto.subtle.digest('SHA-1', ...)`.
* **RFC 7232 304 Not Modified**: Intercepts matching `If-None-Match` headers for instant 304 responses, omitting representation headers per RFC 7232.
* **Deterministic Query Sorting**: Groups identical query permutations into a single cache entry.
* **Non-2xx & 206 Status Gating**: Never caches error responses or `206 Partial Content` slices.
* **Request-Bound Response Refresh**: Never reruns a completed Hono `next()` chain in background work. Use independent `EdgeCacheService.get()` data fetchers for SWR and pass `ctx.waitUntil` on edge platforms.
* **Response Cache-Control Protection**: Honors downstream `Cache-Control: no-store`, `no-cache`, and `private` headers.
* **Streaming Response Passthrough**: Automatically bypasses Server-Sent Events (`text/event-stream`), avoiding isolate buffer hangs.
* **Header Preservation**: Restores downstream custom headers (e.g. CORS and regional routing headers) on cache hits.
* **Conditional Bypass**: Automatically honors request `Cache-Control: no-cache, no-store` and custom `skipCache` rules.

---

## 3. Remote L2 Storage Adapters

In edge environments where TCP sockets are unavailable, TriCache connects to distributed key-value tiers via HTTP REST or native bindings:

### Upstash Redis (HTTPS REST)
```typescript
import { EdgeCacheService, UpstashRedisAdapter } from 'tricache/edge';

const cache = new EdgeCacheService({
  remoteStorage: new UpstashRedisAdapter({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  }),
});
```

### Cloudflare Workers KV
```typescript
import { EdgeCacheService, CloudflareKVAdapter } from 'tricache/edge';

const cache = new EdgeCacheService({
  remoteStorage: new CloudflareKVAdapter(env.MY_KV_NAMESPACE),
});
```

---

## 4. Cold-Miss Penetration Defense (Edge Murmur3 Bloom Filter)

Edge subrequests to remote HTTP key-value stores incur metered API costs and 20–50ms latencies. 

TriCache includes in-isolate WASM and TypeScript Bloom filters. An isolate-local filter cannot know about keys another isolate wrote remotely, so remote negative gating is **disabled by default**, even with `bloomFilter: true`.

Pass `bloomFilter: true` for the WASM filter (Murmur3 TypeScript fallback), or pass an explicit instance:

```typescript
import { EdgeCacheService, Murmur3BloomFilter } from 'tricache/edge';

const cache = new EdgeCacheService({
  bloomFilter: new Murmur3BloomFilter(),
  remoteStorage,
  // Leave bloomFilterAuthoritative false unless this filter represents every remote key.
});
```

`bloomFilterAuthoritative: true` trusts negative results only when you maintain a complete, current remote key set. An empty/new isolate filter is not authoritative. WASM compilation is lazy and falls back to TypeScript where dynamic compilation is restricted.

New remote entries contain values, tags, generations, and absolute expiry/SWR times. Cold reads promote locally without rewriting storage or restarting TTLs. Legacy plain JSON remains readable but is not promoted without trustworthy expiry metadata.

---

## 5. Pipelined Batch Reads (`EdgeCacheService.mget`)

In edge isolates, batch requests frequently require resolving multiple keys (e.g. tenant configurations, user claims, or localized product catalogs). `EdgeCacheService.mget()` resolves warm keys locally in isolate memory, falls back to remote HTTP storage (Upstash Redis or Cloudflare KV), and calls `fetchFn(missKeys)` **only for unfulfilled keys**:

```typescript
const keys = ['tenant:org_1', 'tenant:org_2', 'tenant:org_3'];

const configs = await cache.mget<TenantConfig>(
  keys,
  async (missKeys) => {
    // Only invoked with keys that missed isolate memory and remote L2
    const remoteData = await fetchTenantConfigsFromOrigin(missKeys);
    return remoteData; // Record<string, TenantConfig> or Map<string, TenantConfig>
  },
  300 // TTL seconds
);

// configs -> [(Config 1), (Config 2), (Config 3)] in deterministic order
```

---

## 6. Wildcard & Cascading Tag Invalidation in Edge Isolates

`EdgeCacheService` supports wildcard matching (`*`, `?`) and parent-child cascading for tags known to this isolate. Concrete version changes use remote storage when available. Wildcards cannot discover every tag on other isolates, and eventually consistent KV storage does not provide immediate fleet-wide invalidation; use explicit tags and an atomic counter backend when stronger coordination is needed.

```typescript
// Tag items during set
await cache.set('user:101', userData, 300, { tags: ['org:123:users'] });
await cache.set('settings:101', settingsData, 300, { tags: ['org:123:settings'] });

// Invalidate all tags under "org:123:" using wildcards
await cache.invalidateTag('org:123:*');

// Parent-child cascading invalidation
await cache.invalidateTag('org:123', { cascade: true });
```


