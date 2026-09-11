# TriCache Next.js Demo

Cache Components demo comparing **TriCache `"use cache"`** vs **uncached** fetches.

## Quick Start

```bash
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

const Handler = createNextCacheHandler({ namespace: "nextjs-demo" });
const handler = new Handler();

export default {
  get: (key, softTags) => handler.get(key, { softTags }),
  set: (key, entry) => handler.set(key, entry),
  refreshTags: () => handler.refreshTags(),
  getExpiration: (tags) => handler.getExpiration(tags),
  updateTags: (tags) => handler.updateTags(tags),
};
```

```typescript
// next.config.ts
const nextConfig = {
  cacheHandlers: { default: require.resolve("./cache-handler.ts") },
  cacheMaxMemorySize: 0,
  cacheComponents: true,
};
```
