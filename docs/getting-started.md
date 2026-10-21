# Getting Started

Welcome to **TriCache** — an enterprise three-tier caching engine engineered for high-throughput Node.js microservices, Next.js applications, and containerized cloud workloads.

---

## Installation

Install TriCache via your preferred package manager:

::: code-group
```bash [npm]
npm install tricache
```
```bash [pnpm]
pnpm add tricache
```
```bash [yarn]
yarn add tricache
```
```bash [bun]
bun add tricache
```
:::

Node.js $\ge 20.10.0$ is required. `ioredis` and `msgpackr` are bundled as production dependencies.

---

## 30-Second Quickstart

```typescript
import { CacheService } from 'tricache';

// 1. Initialize with an optimal production preset
const cache = CacheService.preset('nextjs', {
  redisHost: process.env.REDIS_HOST ?? '127.0.0.1',
  redisPort: Number(process.env.REDIS_PORT ?? 6379),
});

// 2. Wrap expensive queries in get-or-fetch with SWR
const user = await cache.get(
  `user:${userId}`,
  async () => {
    return await db.users.findUnique({ where: { id: userId } });
  },
  300,            // 5-minute hard TTL
  { swr: 60 }     // 60s soft TTL: serve stale instantly while refreshing in background
);

// 3. Invalidate tags in O(1) time across your entire cluster
await cache.invalidateTag('users');
```

---

## Production Presets

Rather than tuning dozens of configuration flags, use `CacheService.preset(type, overrides)` to apply battle-tested profiles for your specific environment:

```typescript
import { CacheService } from 'tricache';

// Next.js 16/15 App Router
const cache = CacheService.preset('nextjs', { redisHost: 'redis.internal' });
```

### Available Presets

| Preset | Target Environment | Key Behaviors |
|:---|:---|:---|
| `'nextjs'` | Next.js 16 & 15 App Router, React 19 RSC | `cloneStrategy: 'none'` (optimized for stream buffers), W-TinyLFU, `tagStrategy: 'generational'`, Redis Streams backplane, 300s `staleIfError`. |
| `'microservice'` | Express, Fastify, NestJS, gRPC | W-TinyLFU, Redis Streams backplane, `ttlJitterFactor: 0.15` (anti-synchronicity), L2 circuit breaker (5 failures $\rightarrow$ 15s cooldown). |
| `'serverless'` | AWS Lambda, Cloud Run, Vercel Serverless | `disableDisk: true` (memory-only), 1,000ms Redis command timeouts, ephemeral Pub/Sub backplane. |
| `'enterprise-hardened'` | Financial, High-Security, Strict SLA | Generational tags, `strictSingleton: true`, `failClosed: true`, `oomProtection: true` (80% heap threshold emergency shed). |

All preset configurations can be selectively customized by passing an overrides object:

```typescript
const cache = CacheService.preset('microservice', {
  maxMemoryBytes: 512 * 1024 * 1024, // 512MB RAM
  ttlJitterFactor: 0.20,             // 20% jitter
});
```

---

## Core Caching Operations

### 1. Read-Through with Singleflight Coalescing (`cache.get`)

`cache.get(key, fetchFn, ttlSec, options)` executes the three-tier cascade:
1. Checks **L1 RAM** (~350 ns). If found and fresh, returns immediately.
2. Checks **L1.5 Off-Heap `/dev/shm`** (~20 µs). If found, promotes back to L1.
3. Checks **L2 Redis** (~1.2 ms). If found, populates L1 and returns.
4. On miss, invokes `fetchFn()`. Concurrent callers for the identical key coalesce into a single execution.

```typescript
const product = await cache.get(
  `product:${id}`,
  () => fetchProductFromDb(id),
  600, // 10 minutes
  {
    swr: 120,                // Soft TTL: serve stale while background revalidating
    priority: CachePriority.HIGH, // Eviction protection in L1
    tags: ['products', `category:${catId}`],
  }
);
```

### 2. Manual Set (`cache.set`)

Explicitly writes to L1 RAM, spills to `/dev/shm`, and replicates to L2 Redis:

```typescript
await cache.set('config:rate-limits', rateLimits, 3600, {
  priority: CachePriority.CRITICAL, // Never evict unless expired
  tags: ['config'],
});
```

### 3. Cluster-Wide Tag Invalidation (`cache.invalidateTag` & `cache.invalidateTags`)

Invalidates all keys associated with tags across the entire cluster. Under `tagStrategy: 'generational'`, invalidations execute in $O(1)$ time via atomic version counters.

#### Discrete Tags & Batch Invalidation:
```typescript
// Invalidate a single tag
await cache.invalidateTag('products');

// Invalidate multiple tags in a pipelined batch
await cache.invalidateTags(['products', 'inventory', 'pricing']);
```

#### Wildcard Glob Matching (`*` and `?`):
```typescript
// Invalidate all tags starting with "org:123:" (e.g. org:123:users, org:123:settings)
await cache.invalidateTag('org:123:*');

// Invalidate all comment tags regardless of entity type (e.g. post:1:comments, case:42:comments)
await cache.invalidateTag('*:comments');

// Single character wildcard matching
await cache.invalidateTag('tenant:?:active');
```

#### Parent-Child Tag Cascading:
```typescript
// Invalidates 'org:123' and all descendant namespaces (e.g. 'org:123:dept:456')
// Preserves delimiter boundary safety (will never accidentally match 'org:1234')
await cache.invalidateTag('org:123', { cascade: true });
```

#### Hierarchical Tag Auto-Expansion:
Enable `hierarchicalTags: true` in `CacheOptions` to automatically associate entries with all ancestor namespaces:
```typescript
const cache = CacheService.create({
  hierarchicalTags: true,
  tagHierarchyDelimiter: ':', // default ':' (or '/' for 'geo/us/west')
});

// Tagging with 'org:123:dept:456' automatically expands to:
// ['org', 'org:123', 'org:123:dept', 'org:123:dept:456']
await cache.set('payroll', data, 3600, { tags: ['org:123:dept:456'] });

// Invalidating any parent tag now automatically purges the entry:
await cache.invalidateTag('org:123'); // Or await cache.invalidateTag('org');
```

### 4. Direct Key Deletion (`cache.delete`)

Deletes a key across all local tiers and publishes an invalidation event across the backplane:

```typescript
await cache.delete(`user:${userId}`);
```

### 5. Multi-Key Operations (`cache.mget`, `cache.mset`, `cache.mdel`)

TriCache provides enterprise-grade batch operations with **differential multi-tier waterfall resolution**, eliminating the classic $N+1$ query problem across distributed cache tiers.

#### Cascading Batch Read (`cache.mget`)
`cache.mget` queries L1 RAM first. Unresolved keys fall through to a pipelined Redis `MULTI` call, then to L1.5 disk spill. **Only the remaining unfulfilled keys** are passed to `fetchFn(missKeys)`:

```typescript
// Solve N+1 database queries in high-throughput endpoints
const userIds = ['user:101', 'user:102', 'user:103', 'user:104'];

const users = await cache.mget<User>(
  userIds,
  async (missKeys) => {
    // missKeys contains ONLY keys that missed L1, L2, and L1.5 disk!
    // Example: If user:101 and user:102 were cached, missKeys is ['user:103', 'user:104']
    const ids = missKeys.map(k => k.replace('user:', ''));
    const rows = await db.query('SELECT * FROM users WHERE id = ANY($1)', [ids]);

    // Return as Record<string, User> or Map<string, User>
    const result: Record<string, User> = {};
    for (const row of rows) {
      result[`user:${row.id}`] = row;
    }
    return result;
  },
  // Dynamic per-key TTL: pass a number (seconds) or a function for heterogeneous TTLs
  (key) => (key.includes('admin') ? 60 : 3600),
);

// Results preserve exact input ordering: users[i] corresponds to userIds[i]
// users -> [(User 101), (User 102), (User 103), (User 104)]
```

#### Converting `mget` Results to a `Map`
If your service prefers a lookup Map rather than an index-aligned array:

```typescript
function toLookupMap<T>(keys: string[], values: (T | undefined)[]): Map<string, T> {
  const map = new Map<string, T>();
  for (let i = 0; i < keys.length; i++) {
    const val = values[i];
    if (val !== undefined) map.set(keys[i], val);
  }
  return map;
}

const userMap = toLookupMap(userIds, users);
const user101 = userMap.get('user:101');
```

#### Batch Writes & Deletions (`cache.mset` & `cache.mdel`)
```typescript
// Pipelined multi-key write across all tiers in a single network round-trip
await cache.mset({
  'item:1': { value: data1, ttl: 300, tags: ['catalog'] },
  'item:2': { value: data2, ttl: 600, tags: ['catalog'] },
});

// Pipelined multi-key deletion across L1, disk, and L2
await cache.mdel(['item:1', 'item:2']);
```

---

### 6. Automatic Compression Layer (`'zstd'`, `'lz4'`, `'brotli'`, `'gzip'`)

For cached payloads exceeding a configurable threshold (e.g. large analytics datasets or activity histories), payload size is the primary bottleneck for Redis network throughput and memory costs. TriCache provides transparent compression before writing to L1.5 disk or L2 Redis:

```typescript
const cache = CacheService.create({
  // 'zstd' (WebAssembly, ultra-high ratio) | 'lz4' (ultra-low latency) | 'brotli' | 'gzip' | 'none'
  compression: 'zstd',
  // Compress payloads larger than 1 KB (default: 1024 bytes)
  compressionThresholdBytes: 1024,
});
```

* **Zstandard (`'zstd'`)**: Powered by official WebAssembly build (`zstd-codec`), achieving 70–90% payload reduction with zero native C++ build requirements (`node-gyp`).
* **LZ4 (`'lz4'`)**: Ultra-fast compression and decompression with negligible CPU overhead for latency-critical high-throughput microservices.
* **Format Auto-Detection**: Magic header sniffing auto-detects Zstandard (`0x28 0xB5 0x2F 0xFD`), LZ4 (`0x04 0x22 0x4D 0x18`), and Gzip frames, enabling seamless algorithm transitions without cache purges.
* **Pluggable Compressor**: Supply `customCompressor: { name, compress, decompress }` to plug in your own proprietary compression or serialization engine.

---

## Container Readiness & Health Probes

In containerized runtimes (Kubernetes, ECS), decouple process liveness from traffic readiness:

```typescript
import express from 'express';

const app = express();

// Kubernetes Liveness Probe: always 200 unless process has crashed
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// Kubernetes Readiness Probe: checks cache health and tier status
app.get('/ready', async (req, res) => {
  const health = cache.health();
  if (health.healthy) {
    res.status(200).json(health);
  } else {
    // Sheds traffic from ingress load balancer until cache heals
    res.status(503).json(health);
  }
});
```

For complete deployment manifests, cgroup budgeting, and eviction defense, see the [Kubernetes Production Guide](/kubernetes-production-guide).
