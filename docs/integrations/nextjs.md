# Next.js Cache Components & Legacy ISR

> Package entry: `tricache/next`

`TriCacheHandler` implements the native Next.js 16 `cacheHandlers` contract for Cache Components. Its types are checked against Next.js 16.4.6, including RSC streams, timing fields, soft tags, and delayed tag expiration. `TriCacheISRHandler` is a separate legacy incremental-cache adapter; do not interchange these exports.

---

## Ready-to-Run Demo Application

A complete, production-ready demo application is available in the repository at [`examples/nextjs`](https://github.com/Kareem411/TriCache/tree/main/examples/nextjs):

- **Next.js 16.4.6 & React 19.3.1** App Router architecture (16.4.6 is the latest stable checked 2026-11-15; 16.5 remains canary).
- **Cache Components (`'use cache'`)** with `cacheTag('products')` backed by TriCache.
- **Side-by-Side Comparison UI**: Live metrics comparing uncached requests (~1000ms simulated latency) against TriCache hits (~1ms).
- **On-Demand Revalidation**: Instant cache revalidation via Server Actions using `updateTag()`.

The linked-package example builds with `next build --webpack`: Next 16.4.6's Turbopack trace follows the package's CommonJS declaration files even for this ESM handler. This is a bundler trace limitation, not a CacheHandler runtime requirement.

```bash
cd examples/nextjs
pnpm --dir ../.. build
pnpm install
pnpm dev
```

Open `http://localhost:3000` to see TriCache in action.

---

## Next.js 16 Configuration (`cacheHandlers`)

Use plural `cacheHandlers` for `'use cache'`/`'use cache: remote'`. Singular `cacheHandler` configures the separate legacy ISR cache; it is not a replacement name for the same interface.

### 1. Configure `next.config.ts`

```typescript
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Use plural cacheHandlers for Next.js 16 Cache Components ('use cache')
  cacheHandlers: {
    default: require.resolve('./cache-handler.ts'),
  },
  cacheComponents: true,
};

export default nextConfig;
```

> **Legacy ISR**: Use a module exporting a configured `TriCacheISRHandler` class with singular `cacheHandler`. Check the documentation of your installed Next.js version; the modern handler instance below must not be passed to the legacy API.

### 2. Implement `cache-handler.ts`

```typescript
import { TriCacheHandler } from 'tricache/next';
import type { CacheHandler } from 'next/cache';

export default new TriCacheHandler({
  namespace: 'my-nextjs-app',
  redisHost: process.env.REDIS_HOST,
  backplaneMode: 'stream',
  maxStreamBytes: 16 * 1024 * 1024,
}) satisfies CacheHandler;
```

---

## Key Architectural Highlights

### Strict Next.js 16 Spec Alignment
The handler is typechecked against `CacheHandler` from `next/cache`: `get(key, softTags)` and `set(key, Promise<CacheEntry>)` use the native method contract, and entries preserve all six fields. Each hit gets a new readable stream. `getExpiration(nonEmptyTags)` delegates soft-tag checks to `get` with Next's documented `Infinity` sentinel.

### Binary Stream Safety (`cloneStrategy: 'none'`)
RSC bytes are buffered with a configurable bound (`maxStreamBytes`, default 16 MiB), stored as base64 for Redis JSON safety, and restored as a new unlocked stream on every read. Failed/oversized streams are discarded. A read waits for a pending write without retaining the request's stream after the write resolves.

### Timing and Tag Revalidation
The handler preserves `timestamp`, `stale`, `revalidate`, and `expire`. `updateTags(tags)` expires prior entries immediately; `updateTags(tags, { expire: seconds })` first returns them with `revalidate: -1`, then expires them after the grace period. `getExpiration(nonEmptyTags)` returns `Infinity` to delegate soft-tag checking to `get(key, softTags)`.

Next's tag-expiration state is separate from the backing cache: raw entries may remain until replacement/TTL even after the handler reports a miss. Use the handler, not `cache.peek()`, to evaluate framework validity. Shared tag state and backplane replay coordinate instances, subject to transport delay and stream retention.

### `/dev/shm` Off-Heap Memory
TriCache can select an existing writable `/dev/shm` mount for L1.5 spill; it does not mount volumes itself. tmpfs counts against container memory, and buffering/encoding still allocates on the Node heap.

---

## Custom Options Factory

For advanced enterprise setups needing custom telemetry, clustering, or Redis credentials:

```typescript
import { createNextCacheHandler } from 'tricache/next';

const Handler = createNextCacheHandler({
  redisHost: process.env.REDIS_HOST,
  redisPort: Number(process.env.REDIS_PORT ?? 6379),
  l1MaxBytes: 512 * 1024 * 1024,
  maxStreamBytes: 16 * 1024 * 1024,
});
export default new Handler(); // Plural cacheHandlers requires an instance.
```
