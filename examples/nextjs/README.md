# TriCache Next.js Demo

Cache Components demo comparing **TriCache `"use cache"`** vs **uncached** fetches on Next.js 16.4.6, React 19.3.1, with the native `CacheHandler` type contract.

## Quick Start

```bash
# Build the linked TriCache package from the repository root first:
pnpm --dir ../.. install
pnpm --dir ../.. build
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## What It Shows

- **Cached panel** — `"use cache"` + `cacheTag` backed by TriCache (`cacheHandlers`)
- **Uncached panel** — raw fetch every request (~1s simulated DB)
- **Revalidate** — `updateTag("products")` via Server Action

## Setup

```typescript
// cache-handler.ts
import { createNextCacheHandler } from "tricache/next";
import type { CacheHandler } from "next/cache";

const Handler = createNextCacheHandler({
  namespace: "nextjs-demo",
  redisHost: process.env.REDIS_HOST,
  disableRedis: !process.env.REDIS_HOST,
  encryptionKey: process.env.TRICACHE_ENCRYPTION_KEY,
});
export default new Handler() satisfies CacheHandler;
```

```typescript
// next.config.ts
const nextConfig = {
  cacheHandlers: { default: require.resolve("./cache-handler.ts") },
  cacheComponents: true,
  partialPrefetching: true,
};
```

The demo uses Next.js 16.4.6 (the latest stable checked 2026-11-15) and React 19.3.1. It uses Webpack because Turbopack's output tracing misinterprets the linked package's CommonJS declaration files. Without `REDIS_HOST`, caching is local. For encrypted storage, provide a valid base64 AES key through `TRICACHE_ENCRYPTION_KEY`; no demo secret is hardcoded. The native handler instance forwards soft tags and tag-expiration durations without a wrapper.
