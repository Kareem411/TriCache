# TriCache

[![CI](https://github.com/Kareem411/TriCache/actions/workflows/ci.yml/badge.svg)](https://github.com/Kareem411/TriCache/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/tricache.svg)](https://www.npmjs.com/package/tricache)
[![Tests](https://img.shields.io/badge/tests-563%20passing-brightgreen)](tests)
[![Code Quality](https://img.shields.io/badge/oxlint-0%20warnings-brightgreen)](src)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js ≥ 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%20%7C%205.x%20%7C%206.x-blue)](https://www.typescriptlang.org)
[![npm provenance](https://img.shields.io/badge/provenance-verified-brightgreen)](https://www.npmjs.com/package/tricache)

tricache is a three-tier Node.js cache library — in-memory (L1), local disk spill, and Redis/Valkey (L2). Warm L1 reads run at 2.81 million operations per second on a single thread (356 ns/op) — well below any network round-trip, including a local Redis call. When L1 fills, evicted entries spill to disk instead of being dropped, keeping hit rates high without unbounded RAM growth. Misses that reach L2 are coalesced across concurrent callers, so a spike of simultaneous requests for the same key triggers exactly one fetchFn call, not one per caller. See the performance section for full numbers. Optional configuration adds Stale-While-Revalidate, at-rest encryption (AES-256-GCM by default), pub/sub fleet-wide invalidation, an OOM guard, cold-start snapshots, and Prometheus metrics — none of it required to get started.

<img src="https://raw.githubusercontent.com/Kareem411/TriCache/main/public/SmartMemoryCache_DiskTier.jpeg" width="600" alt="tricache architecture" />

---

## 🏆 What Makes TriCache a "No-Brainer"

| Dimension | Industry Standard (`keyv`, `@neshca/cache-handler`, `cache-manager`) | **TriCache v0.8.0** |
|:---|:---|:---|
| **Storage Hierarchy** | Single-tier (RAM or Redis or Disk) | **Three-Tier (RAM → NVMe Disk Spill → Redis/Valkey L2)** |
| **Throughput & Latency** | ~200k – 600k ops/sec | **2.81 Million ops/sec (356 ns/op) warm L1 on a single core** |
| **Thundering-Herd** | Unhandled / requires external single-flight libraries | **Built-in Inflight Promise Coalescing (10,000 tested concurrent callers)** |
| **Tag Invalidation** | $O(N)$ bulk key scans or blocking Redis `SMEMBERS` | **$O(1)$ Generational Version Counters (`MULTI/EXEC`) in < 1 ms** |
| **ORM & Database Layer** | Manual boilerplate wrappers | **Native Prisma Extension (`withTriCache`) & Drizzle Wrapper (`withCache`)** |
| **Serialization & Payload**| Heavy JSON stringification | **`msgpackr` 2.1.0 Record Compression (~45% smaller binary footprint)** |
| **Next.js 16 & 15** | Basic key-value handlers, broken RSC stream reuse | **Native 5-Method Bridge with stream re-hydration & `cacheLife`** |
| **NestJS Ecosystem** | Generic `CacheModule` missing batch & tag methods | **Dynamic `TriCacheModule` + `@Cacheable` & `@CacheEvict` decorators** |
| **Cluster Invalidation** | At-most-once Pub/Sub (drops invalidations on blips) | **Durable Redis Streams (`XADD`/`XREAD`) with zero-drop reconnect replay** |
| **Memory Hygiene** | Unconstrained RAM until node crashes (OOM) | **Count-Min Sketch (84% flood survival), WASM Bloom filter, OOM guard** |
| **Failure Tolerance** | Cascading 500s when Redis or upstream flutters | **Circuit Breaker, `staleIfError` SWR grace, monotonic tag guarantees** |


---

## ✨ Features

| Feature | Detail |
|---|---|
| **Next.js 16 & 15 Adapter** | Full `CacheHandler` implementation for Next.js 16 `"use cache"` and legacy ISR; single-use stream re-hydration, dynamic `softTags` checking, and automatic `NEXT_PHASE` build bypass |
| **NestJS Dynamic Module & Store** | Dedicated `TriCacheModule.register()` dynamic module, `TriCacheStore` adapter for `@nestjs/cache-manager`, and declarative `@Cacheable` / `@CacheEvict` method decorators |
| **First-Class Prisma Extension** | `withTriCache(options)` for `$extends` with automatic query key hashing, cache options, and write mutation tag invalidation |
| **First-Class Drizzle Wrapper** | `withCache(query, options)` wrapping Drizzle queries with automatic SQL + params hashing and SWR support |
| **Distributed Mutex Lock** | `cache.lock(key, fn, options)` with Redis `SET NX EX`, atomic Lua token-release, and local promise-chain fallback |
| **Native OpenTelemetry Metrics** | Direct `meter` integration publishing monotonic counters and observable gauges without scrapers |
| **Interactive Developer CLI** | Zero-dependency CLI (`npx tricache inspect`, `ping`, `clear`) with terminal dashboard and latency probes |
| **Universal `cache.wrap()` Primitive** | Options-object wrapper (`{ ttl, swr, tags, dependsOn, priority }`) for ORMs and service layers |
| **Generational Tagging** | $O(1)$ tag invalidations via Redis version counters (`INCR tag_ver:<tag>`); atomic `{d, t, tv}` hash schema, pipelined batch `invalidateTags()`, and time-based self-healing reconciliation |
| **Read Safety (`cloneStrategy`)** | `cloneStrategy: 'structuredClone'` isolates returned objects from caller mutation; sub-microsecond raw reference fallback (`'none'`) |
| **Redis Streams Backplane** | `backplaneMode: 'stream'` replaces at-most-once Pub/Sub with durable `XADD`/`XREAD` append-only log; cluster hash tag slot safety and zero-drop reconnect replay |
| **Atomic Disk Writes** | Atomic staging via unique `.tmp` sibling files with Windows NTFS file-lock micro-retries and background `.tmp` janitor sweep |
| **Adaptive eviction** | LFU × LRU × priority score + Count-Min Sketch cross-eviction frequency; reservoir-sampled O(1) hot path; category limits prevent any prefix monopolising RAM |
| **Count-Min Sketch** | 4 × 512 `Uint16Array` (4 KB) tracks historical access frequency across eviction boundaries — same-priority burst keys cannot displace long-resident entries; **84 % survival rate** in benchmark flood tests |
| **WASM Bloom filter** | 562-byte binary inlined as Base64 — O(k=7) guaranteed-miss detection, no filesystem access, pure-JS fallback |
| **msgpackr 2.1.0 serialization** | L1 and disk-tier entries packed with `msgpackr` 2.1.0 via `CacheCodec` — record structure compression (`useRecords: true`, ~45% smaller binary footprint), rich type preservation (`moreTypes: true`), DoS defense, and `serializeToJSON` toggle |
| **Stale-While-Revalidate** | Serve stale instantly, revalidate in background — zero added latency on cache hit |
| **Stale-if-error** | Extend a stale entry's TTL when SWR revalidation fails — no errors served during upstream outages |
| **Thundering-herd prevention** | Inflight `Promise` registry — only one `fetchFn` call per key regardless of concurrency (10,000 tested) |
| **Pub/sub invalidation backplane** | Redis pub/sub channel propagates deletes across all instances in real time |
| **Tag-based invalidation** | Tag entries on write; `invalidateTag('catalog')` evicts all matching entries from L1, disk, and Redis atomically |
| **Batch read** | `mget()` collects L1 hits, calls `fetchFn` only for misses, preserves ordering |
| **Batch write** | `mset()` / `mdel()` write or delete many keys in a single `Promise.all` call |
| **TTL jitter** | `ttlJitterFactor` spreads expirations across a configurable ± window — prevents thundering-cliff mass-expiry |
| **OpenTelemetry spans** | Structural `ICacheTracer` / `ICacheSpan` interfaces — pass any OTEL-compatible tracer; no peer dep required |
| **L2 circuit breaker** | Suspends Redis after N consecutive failures; auto-probes after cooldown; state visible in `metrics()` |
| **`warmFromL2(pattern)`** | Scan Redis and pre-populate L1 at startup; returns count loaded; no-op when Redis unavailable |
| **OOM guard** | Polls `heapUsed/heapTotal` on a timer; emergency-evicts coldest L1 entries before the process crashes |
| **Cold-start snapshot** | L1 serialised to disk on `SIGTERM`/`SIGINT`, reloaded on next startup — warm cache, cold process |
| **AES-256-GCM encryption** | L2 (Redis) values, disk spill files, and snapshots encrypted at rest; zero-downtime key rotation via `previousEncryptionKey` |
| **Prometheus metrics** | `cache.metrics()` + `CacheService.toPrometheusText()` — drop into any `/metrics` endpoint |
| **Distributed counter** | `cache.increment()` backed by Redis `INCR` for distributed rate limiting; in-process fallback when Redis is disabled |
| **Pluggable logger** | Bring your own `pino`, `winston`, etc. |
| **L2 read-only mode** | `l2WriteMode: 'read-only'` reads from Redis but skips all writes — canary deploys, read replicas |
| **Eviction callback** | `onEviction(key, reason)` fires on every L1 eviction with a typed reason string |
| **Negative caching (`notFoundTtl`)** | Cache `null`/`undefined` fetchFn results for a configurable TTL — prevents hammering upstream on repeated misses |
| **`setIfAbsent()`** | Atomic "set if not cached" — L1 `has()` check → Redis `SET NX EX` → L1 set on success; returns `true` if written, `false` if already present |
| **Refresh-ahead** | Proactively recompute an entry in the background when remaining TTL falls below a configured fraction — zero-latency freshness |
| **XFetch probabilistic early expiry** | Probabilistic background recompute keyed to last fetch duration and `xfetchBeta` — optimal protection against expiry spikes under load |
| **Adaptive TTL** | Tracks per-key fetch latency in a rolling ring buffer; once ≥ 5 samples are collected, automatically sets TTL = `p95LatencyMs × multiplier`. Expensive keys get cached longer; cheap keys stay close to their base TTL — no manual TTL tuning required |
| **`hotKeys(n)`** | Returns top N keys by Count-Min Sketch access frequency with size — no full Map scan |
| **`dependsOn` cascade invalidation** | Tag entries with parent keys; deleting a parent automatically evicts all declared dependents from L1 |
| **`onHit` / `onMiss` callbacks** | Per-operation hit/miss hooks with tier info (`'l1'` \| `'disk'` \| `'l2'`) — no wait for the metrics interval |
| **`frozen` mode** | Dev-time mutation guard — `Object.freeze()` applied recursively to every L1 hit so accidental mutations throw immediately |
| **`tags` in `get()` opts** | Attach tags at read time; when `fetchFn` populates the entry on a miss the tags are registered automatically |

---

## 📦 Install

```bash
npm install tricache
# or
pnpm add tricache
```

---

## 🚀 Quick start

```typescript
import { CacheService, CachePriority } from 'tricache';

// Get (or create) the process-level singleton
const cache = CacheService.create({
  redisHost: 'my-redis.example.com',   // omit or set NODE_ENV!=production to disable L2
});

// Get-or-fetch with a 5-minute TTL
const user = await cache.get(
  `user:${userId}`,
  () => db.users.findById(userId),
  300,
);

// Universal wrap() with options object (alternative to get)
const profile = await cache.wrap(
  `user:${userId}:profile`,
  () => db.users.findProfile(userId),
  { ttl: 300, swr: 60, tags: ['users'] },
);

// Explicit set
await cache.set(`user:${userId}`, user, 300);

// Delete one key
await cache.delete(`user:${userId}`);

// Delete by glob pattern
await cache.delete(`user:${userId}:*`);

// Stale-While-Revalidate: serve stale for up to 30 s while refreshing in background
const dashboard = await cache.get(
  `dashboard:${orgId}`,
  () => analytics.buildDashboard(orgId),
  300,
  { swr: 30 },
);

// Distributed rate-limiting counter
const hits = await cache.increment(`ratelimit:${ip}`, 60 /* TTL seconds */);

// Check if a key is cached (fast, no fetch)
const isCached = cache.has(`user:${userId}`);

// Batch read
const [userA, userB] = await cache.mget(
  [`user:${userIdA}`, `user:${userIdB}`],
  (missKeys) => db.users.findByIds(missKeys).then(rowsToMap),
  300,
);

// Batch write
await cache.mset({
  [`user:${userIdA}`]: { value: userA, ttl: 300 },
  [`user:${userIdB}`]: { value: userB, ttl: 300 },
});

// Batch delete
await cache.mdel([`user:${userIdA}`, `user:${userIdB}`]);
```

> [!TIP]
> **In-Memory Reference Semantics & Mutation Safety:**  
> By default, TriCache returns direct in-memory object references from L1 RAM (`cloneStrategy: 'none'`) to achieve sub-microsecond throughput (**2.81M ops/sec / 356 ns**). If your callers mutate returned objects in-place, enable `cloneStrategy: 'structuredClone'` for deep copy isolation, or enable `frozen: true` in non-production environments to catch mutations at runtime.

```typescript
// Warm L1 from Redis at startup
const loaded = await cache.warmFromL2('user:*');
console.log(`Pre-warmed ${loaded} user entries`);

// Or auto-warm at construction + gate traffic with ready()
const cache2 = CacheService.create({ warmKeys: 'user:*' });
await cache2.ready(); // resolves once warm-up completes — ideal for k8s readiness probes

// Atomic set-if-absent — returns true if written, false if key already cached
const written = await cache.setIfAbsent(`session:${id}`, sessionData, 3600);

// Dependency cascade: deleting 'org:42' automatically evicts 'org:42:config'
await cache.set('org:42:config', config, 300, undefined, { dependsOn: ['org:42'] });
await cache.delete('org:42'); // also evicts org:42:config

// Top 10 hottest keys by Count-Min Sketch frequency
const hot = cache.hotKeys(10);
console.log(hot); // [{ key: 'user:1', hits: 842, sizeBytes: 512 }, ...]

// Tag entries for group invalidation
await cache.set(`product:${id}`, product, 300, undefined, { tags: ['catalog'] });
await cache.invalidateTag('catalog'); // evict all catalog entries

// Health check with tier latencies
const { l1, disk, l2 } = await cache.ping();

// Prometheus metrics
const snap = cache.metrics();
console.log(CacheService.toPrometheusText(snap));
```

---

## ⚙️ Configuration

All options are optional — sensible defaults apply.

```typescript
CacheService.create({
  // ── Namespace ─────────────────────────────────────────────────────────
  // Isolates keys, disk dir, snapshot file, and Redis backplane channel.
  // Two instances with different namespaces are fully independent.
  namespace: 'my-app',

  // ── Logger ────────────────────────────────────────────────────────────
  logger: pinoLogger,               // default: console warn/error only

  // ── L1 (in-memory) ───────────────────────────────────────────────────
  l1MaxBytes:   200 * 1024 * 1024,  // 200 MB total RAM cap (default)
  l1MaxEntries: 2_000,              // max entries in L1 (default)
  l1EvictionWatermark: 0.9,         // proactive eviction fires at 90 % of l1MaxEntries / l1MaxBytes (default)
                                    // lower to 0.8 to reduce GC pressure on heap-bound workloads
  categoryLimits: {
    // per-prefix limits — keys are matched by startsWith()
    'user:':      { maxEntries: 500,  maxSizeBytes: 50  * 1024 * 1024 },
    'analytics:': { maxEntries: 100,  maxSizeBytes: 20  * 1024 * 1024 },
    'default':    { maxEntries: 1000, maxSizeBytes: 100 * 1024 * 1024 },
  },

  // ── L1.5 (disk spill) ────────────────────────────────────────────────
  diskCacheDir:      '/tmp/my-app-cache',  // default: os.tmpdir()/tricache-disk
  diskMaxBytes:      500 * 1024 * 1024,   // 500 MB (default)
  diskEntryMaxBytes: 10  * 1024 * 1024,   // 10 MB per entry (default)

  // ── L2 (Redis / Valkey) ──────────────────────────────────────────────
  redisHost:    'my-redis.example.com',   // or REDIS_HOST env var
  redisPort:    6379,
  redisTls:     true,                     // default: true when NODE_ENV=production
  redisProtocol: 3,                       // default: 3 (RESP3 in ioredis v6+); set to 2 for RESP2 proxies (Twemproxy/Envoy)
  disableRedis: false,                    // default: true when NODE_ENV!=production

  // ── Transparent payload compression ──────────────────────────────────
  // 'none' (default)   — raw msgpack/JSON representation
  // 'brotli' | 'gzip'  — compress Redis L2 payloads and disk tier binaries
  compression:               'none',
  compressionThresholdBytes: 1024,        // only compress entries ≥ 1 KB (default)

  // ── Invalidation backplane ───────────────────────────────────────────
  invalidationBackplane:  true,
  // 'pubsub' (default) — Ephemeral Redis Pub/Sub (at-most-once delivery)
  // 'stream'           — Durable Redis Streams (XADD/XREAD) with replay on reconnect
  backplaneMode:          'pubsub',
  backplaneStreamMaxLen:  10_000, // max entries retained in invalidation stream
  backplaneStreamBlockMs: 2_000,  // blocking poll interval for XREAD BLOCK
  // backplaneStreamKey:  'tricache:stream:{my-app}', // custom stream key override

  // ── Generational tagging & clone strategy ─────────────────────────────
  // 'set' (default)    — traditional Redis Set member tracking
  // 'generational'     — atomic O(1) integer version counters in Redis + memory
  tagStrategy:            'set',
  tagVersionTtlMs:        5_000,  // ms before local generational tag is re-synced from Redis
  // 'none' (default)   — raw in-memory references (~350 ns performance)
  // 'structuredClone'  — deep-clones returned values to prevent caller mutation
  cloneStrategy:          'none',

  // ── Serialization & Record Compression ────────────────────────────────
  // serializeToJSON: (default: true) uses msgpackr 2.1.0 useToJSON.
  // Set to false to preserve internal object properties without invoking .toJSON()
  serializeToJSON:        true,

  // ── OOM guard ────────────────────────────────────────────────────────
  oomProtection:      true,   // enabled by default
  oomHeapThreshold:   0.85,   // evict when heapUsed/heapTotal > 85 %
  oomCheckIntervalMs: 10_000, // poll every 10 s
  oomEvictPercent:    0.20,   // evict coldest 20 % of L1 per trigger

  // ── Encryption ───────────────────────────────────────────────────────
  // base64-encoded 32-byte key; or set CACHE_ENCRYPTION_KEY env var.
  // node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  encryptionKey: process.env.CACHE_ENCRYPTION_KEY,

  // Zero-downtime key rotation — remove after all old entries have expired
  previousEncryptionKey:  process.env.PREV_ENCRYPTION_KEY,
  previousEncryptionMode: 'aes-256-gcm', // defaults to current encryptionMode

  // ── L2 write mode ────────────────────────────────────────────────────
  // 'read-write' (default) — reads and writes to Redis
  // 'read-only'            — reads from Redis, skips all writes (canary / replica)
  l2WriteMode: 'read-write',

  // ── Stale-if-error ───────────────────────────────────────────────────
  // Extra seconds to extend a stale L1 entry's expiry when a SWR fetchFn fails.
  // Prevents serving errors while the upstream is temporarily down.
  staleIfError: 300, // keep stale for 5 more minutes on revalidation error

  // ── Eviction callback ────────────────────────────────────────────────
  // Called synchronously whenever L1 evicts a key.
  // reason: 'capacity' | 'category' | 'rebalance' | 'oom' | 'ttl' | 'manual'
  onEviction: (key, reason) => metrics.increment(`cache.eviction.${reason}`),

  // ── TTL jitter ────────────────────────────────────────────────────────
  // Multiply each TTL by a random factor in [1-j, 1+j] to spread expiry.
  // Prevents mass-expiry stampedes ("thundering cliff").
  // Range [0, 1]; default 0 (no jitter).
  ttlJitterFactor: 0.15,  // ± 15 % spread

  // ── Adaptive TTL ──────────────────────────────────────────────────────
  // When true, tricache tracks per-key fetch latency in a rolling ring
  // buffer and derives an optimal TTL from the p95 fetch duration:
  //   adaptedTtl = clamp(p95LatencyMs × multiplier, min, max)
  // The caller-supplied ttlSeconds is used until ≥ 5 samples are collected,
  // then the library takes over TTL management autonomously.
  adaptiveTtl:            true,
  adaptiveTtlMin:         10,      // floor: never assign TTL below 10 s (default)
  adaptiveTtlMax:         86400,   // ceiling: never exceed 24 h (default)
  adaptiveTtlMultiplier:  20,      // p95Ms × 20 = TTL in seconds (default)

  // ── Singleton + rate-limit safety ──────────────────────────────────────
  // strictSingleton: when true, a later create() for an existing namespace
  // whose options differ from the first call THROWS instead of silently
  // returning the existing instance. Guards against conflicting init points.
  strictSingleton:       false,
  // failClosed: when true, increment() re-throws on a Redis error instead of
  // failing open (returning 0). Enforces the rate-limit guard during outages.
  failClosed:            false,

  // ── OpenTelemetry tracer ──────────────────────────────────────────────
  // Pass any @opentelemetry/api-compatible tracer. No peer dependency.
  // Spans: 'tricache.get' | 'tricache.set' | 'tricache.delete'
  // Attributes: cache.key_prefix, cache.hit ('l1'|'disk'|'l2'|'miss')
  tracer: trace.getTracer('my-app'),

  // ── L2 circuit breaker ────────────────────────────────────────────────
  // Opens after N consecutive Redis errors; probes after cooldown ms.
  // State visible in cache.metrics().l2CircuitBreaker.state
  l2CircuitBreakerThreshold:  5,      // default
  l2CircuitBreakerCooldownMs: 30_000, // default

  // ── Negative caching ──────────────────────────────────────────────────
  // Cache null/undefined fetchFn results for this many seconds globally.
  // Prevents repeated upstream calls for keys that genuinely don't exist.
  // Can be overridden per-call via opts.notFoundTtl in cache.get().
  notFoundTtl: 30, // seconds; 0 = disabled (default)

  // ── Startup warm-up ───────────────────────────────────────────────────
  // Auto-call warmFromL2(pattern) at construction time.
  // cache.ready() resolves once warm-up finishes — use as a k8s readiness gate.
  // No-op when Redis is disabled or unreachable.
  warmKeys: 'user:*',

  // ── Prometheus instance label ─────────────────────────────────────────
  // Adds an `instance` label to every metric in toPrometheusText().
  instanceName: 'api-us-east-1',

  // ── Cold-start snapshot ──────────────────────────────────────────────
  snapshotPath:              '/tmp/my-app-cache-snapshot.msgpack',
  snapshotMaxAgeMs:          2 * 60 * 60 * 1000,  // 2 hours (default)
  forbiddenSnapshotPrefixes: ['auth:', 'session:', 'mfa:', 'rate_limit:'],

  // ── Remote blob snapshot (stateless containers / Kubernetes / Cloud Run) ─
  // Hydrates L1 from S3, Cloudflare R2, GCS, or HTTP before accepting traffic.
  // remoteSnapshot: {
  //   adapter: createHttpSnapshotAdapter({ getUrl: 'https://s3.amazonaws.com/...presigned-get' }),
  //   maxAgeMs: 2 * 60 * 60 * 1000,
  //   saveOnShutdown: true,
  //   intervalMs: 5 * 60 * 1000, // periodic background sync every 5 min
  // },

  // ── Metrics callback ─────────────────────────────────────────────────
  metricsIntervalMs: 60_000,                       // emit every 60 s (default)
  onMetrics: (m) => myMonitoring.record(m),        // optional push callback

  // ── Per-operation hooks ───────────────────────────────────────────────
  // onHit fires on every L1, disk, or L2 hit with the caller-facing key (no prefix)
  // and the tier that served it. Lower latency than waiting for onMetrics.
  onHit:  (key, tier) => cloudwatch.putMetricData({ key, tier }),

  // onMiss fires when all three tiers are exhausted — before fetchFn is called.
  onMiss: (key) => cloudwatch.putMetricData({ key }),

  // ── Development mutation guard ────────────────────────────────────────
  // When true, every L1 hit value is deep-frozen before being returned.
  // Mutation attempts throw TypeError immediately in development.
  // Do NOT enable in production — deep-freezing large objects has measurable overhead.
  frozen: process.env.NODE_ENV !== 'production',
});
```

### Environment variables

| Variable | Purpose |
|---|---|
| `REDIS_HOST` | Redis/Valkey hostname (used when `redisHost` option is not set) |
| `CACHE_ENCRYPTION_KEY` | Base64-encoded 32-byte AES-256-GCM key |
| `NODE_ENV` | When `!== 'production'`, L2 Redis and TLS are disabled by default |

---

## 📖 API reference

### `CacheService.create(options?)` → `CacheService`

Returns the process-level singleton. Options are only applied on the **first** call per namespace — subsequent calls return the existing instance. When the new options differ from what the existing singleton was built with, this is a **silent no-op by default** (a one-time warning is logged and the `singletonDivergences` metric is incremented). Set `strictSingleton: true` on the first call to instead **throw** on a divergent later call — use this when multiple init points could pass conflicting Redis credentials or TTLs.

### `CacheService.createAsync(optionsOrPromise)` → `Promise<CacheService>`

Async factory that resolves a `Promise<CacheOptions>` before constructing the singleton. Useful when config is fetched from a secret store at startup.

```typescript
const cache = await CacheService.createAsync(fetchSecretsFromVault());
```

### `CacheService.reset(options?)` → `CacheService`

Destroys the existing singleton and creates a fresh one. Useful in tests.

### `cache.get<T>(key, fetchFn, ttlSeconds?, opts?)` → `Promise<T>`

Get from cache or call `fetchFn` on a miss. The inflight map ensures `fetchFn` fires at most once per key regardless of concurrency.

> **Reference semantics:** on an L1 hit, the returned value is the live JS object stored in the entry — not a deep copy. Mutating it will corrupt the cached entry. Deep-clone at the call site if you need an independent copy.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `key` | `string` | — | Cache key |
| `fetchFn` | `() => Promise<T>` | — | Called on a miss; result is cached |
| `ttlSeconds` | `number` | `300` | Hard TTL in seconds. **When `adaptiveTtl` is enabled, this is only authoritative until ≥ 5 samples are collected for the key — after that the library derives TTL from the p95 fetch latency** (see Adaptive TTL config). Use `opts` or a separate cache instance if you need a hard floor. |
| `opts.swr` | `number` | `0` | Stale-While-Revalidate grace seconds |
| `opts.priority` | `CachePriority` | auto-inferred | Eviction priority override |
| `opts.refreshAhead` | `number` | — | Fraction `(0, 1]` of TTL — triggers background recompute when `remaining ≤ ttl × (1 - refreshAhead)` |
| `opts.xfetchBeta` | `number` | — | XFetch β ≥ 0 — scales probabilistic early recompute by last fetch duration; higher = recompute earlier |
| `opts.notFoundTtl` | `number` | — | Per-call TTL in seconds for `null`/`undefined` results (overrides global `notFoundTtl`) |
| `opts.tags` | `string[]` | — | Tags to register when `fetchFn` populates the entry on a miss; no-op on L1/L2 hits where tags are already registered |

### `cache.set<T>(key, data, ttlSeconds?, priority?, opts?)` → `Promise<void>`

Writes to L1 and (in production) L2. Publishes an invalidation to the backplane.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `opts.tags` | `string[]` | `[]` | Associate tags with this entry for group invalidation |
| `opts.dependsOn` | `string[]` | `[]` | Parent keys — when any parent is deleted, this entry is automatically evicted from L1 |

```typescript
await cache.set('product:1', data, 60, undefined, { tags: ['catalog', 'featured'] });

// Cascade invalidation: evicting 'org:42' also evicts 'org:42:members'
await cache.set('org:42:members', members, 300, undefined, { dependsOn: ['org:42'] });
await cache.delete('org:42'); // org:42:members is evicted too
```

### `cache.mget<T>(keys, fetchFn, ttl?, priority?)` → `Promise<(T | undefined)[]>`

Batch read. Checks **all three tiers** for each key — L1 (RAM), then L2 (Redis, in one pipelined `MGET`), then the L1.5 disk spill — and calls `fetchFn` only for keys that miss every tier. Preserves input ordering and counts exactly one hit per key (no double-counting across tiers).

`ttl` accepts a **plain number** (uniform TTL) or a **function `(key: string) => number`** (per-key TTL). The function is only called for miss keys — L1 hits are unaffected.

```typescript
// Uniform TTL
const [userA, userB] = await cache.mget(
  ['user:1', 'user:2'],
  (missKeys) => db.users.findByIds(missKeys).then(rowsToMap),
  300,
);

// Per-key TTL — heterogeneous data in one batch call
const results = await cache.mget(
  ['user:1', 'config:global', 'feature:flags'],
  fetchFn,
  (key) => key.startsWith('config:') ? 3600 : 300,
);
```

### `cache.mset<T>(entries)` → `Promise<void>`

Write multiple entries in a single call. Each entry accepts `value`, `ttl`, `priority`, and `tags`.

```typescript
await cache.mset({
  'user:1': { value: alice, ttl: 300, priority: CachePriority.HIGH, tags: ['users'] },
  'user:2': { value: bob,   ttl: 300 },
});
```

### `cache.mdel(keys)` → `Promise<void>`

Delete multiple keys in a single call. No-op for keys that do not exist.

```typescript
await cache.mdel(['user:1', 'user:2', 'user:3']);
```

### `cache.warmFromL2(pattern)` → `Promise<number>`

Scan Redis for keys matching a glob pattern (e.g. `'user:*'`) and load their values into L1 with a 10-minute TTL. Returns the number of keys loaded. Returns `0` immediately when Redis is disabled or unreachable — safe to call unconditionally at startup.

```typescript
// In your application startup
const loaded = await cache.warmFromL2('user:*');
console.log(`Pre-warmed ${loaded} user entries from Redis`);
```

### `cache.ready()` → `Promise<void>`

Returns a Promise that resolves once the cache is fully initialised. Without `warmKeys`, resolves immediately. With `warmKeys`, resolves once the automatic `warmFromL2` call completes.

Designed for k8s readiness probes — await before accepting traffic, then never call again:

```typescript
const cache = CacheService.create({ warmKeys: 'user:*' });

// k8s readiness probe endpoint
app.get('/ready', async (_req, res) => {
  await cache.ready();
  res.sendStatus(200);
});
```

### `cache.has(key)` → `boolean`

Return `true` if the key exists in L1 and has not expired. Bloom-filter fast-path — no fetch, no disk or Redis round-trip.

### `cache.ttl(key)` → `number | null`

Return the remaining TTL in **seconds** for a key currently held in L1. Returns `null` if the key is absent or expired. Does not fetch or consume the value.

```typescript
const remaining = cache.ttl('user:123'); // e.g. 247 (seconds left)
if (remaining !== null && remaining < 30) await cache.touch('user:123', 300);
```

### `cache.touch(key, newTtlSeconds)` → `Promise<boolean>`

Extend the TTL of a key in L1 (and fire-and-forget `EXPIRE` in Redis) without reading or re-fetching its value. Returns `false` if the key is absent or already expired.

### `cache.getIfFresh<T>(key)` → `T | null`

Return the L1 value only if it is **fresh** (not yet in the SWR grace window). Returns `null` when absent, expired, or stale — without triggering a revalidation.

```typescript
const fresh = cache.getIfFresh<User>('user:123');
if (fresh !== null) return fresh; // serve from L1, no network hop
```

### `cache.setIfAbsent<T>(key, value, ttlSeconds?)` → `Promise<boolean>`

Atomically write `value` only if `key` is not already cached. Checks L1 first, then attempts a Redis `SET NX EX`. Returns `true` if the value was written, `false` if a live entry already existed.

Useful for distributed lock-style writes, session initialisation, or any pattern where you must not overwrite an already-cached value.

```typescript
const written = await cache.setIfAbsent(`session:${id}`, sessionData, 3600);
if (!written) {
  // session already exists — do not overwrite
}
```

### `cache.hotKeys(n?)` → `Array<{ key: string; hits: number; sizeBytes: number }>`

Returns the top `n` live L1 keys ranked by Count-Min Sketch access frequency. Namespace prefix is stripped from each key. Expired entries are excluded. Default `n = 10`.

```typescript
const hot = cache.hotKeys(5);
// [
//   { key: 'user:1',    hits: 1024, sizeBytes: 512 },
//   { key: 'product:7', hits:  893, sizeBytes: 256 },
//   ...
// ]
```

### `cache.invalidateTag(tag)` / `cache.invalidateTags(tags)` → `Promise<void>`

Evict all entries associated with one or more tags from L1, disk, and Redis.
When `tagStrategy: 'generational'` is active, `invalidateTags(tags)` pipelines multi-tag increments in a single network round-trip.

```typescript
await cache.set('product:1', data, 60, undefined, { tags: ['catalog', 'electronics'] });
await cache.set('product:2', data, 60, undefined, { tags: ['catalog', 'deals'] });

await cache.invalidateTag('catalog');                // single tag
await cache.invalidateTags(['electronics', 'deals']); // pipelined batch invalidation
```

### `cache.ping()` → `Promise<CachePingResult>`

Measure L1 / disk / Redis latency in milliseconds. Returns `{ l1, disk, l2 }` — `l2` is `null` when Redis is disabled. Suitable for health-check endpoints.

```typescript
app.get('/health', async (_req, res) => {
  const { l1, disk, l2 } = await cache.ping();
  res.json({ status: 'ok', latencyMs: { l1, disk, l2 } });
});
```

### `cache.drainToL2()` → `Promise<number>`

Pipeline all live L1 entries to Redis in a single round-trip. Returns the number of keys written. Useful for warming a new Redis node or zero-downtime failover.

### `cache.delete(key)` → `Promise<void>`

Deletes one exact key or a glob pattern (`user:abc:*`). Propagates to disk, Redis, and all backplane peers.

### `cache.clear(prefix?)` → `Promise<void>`

Flush all entries, or only those whose key starts with `prefix`. Propagates to disk and Redis.

```typescript
await cache.clear();           // flush everything
await cache.clear('session:'); // flush only session keys
```

### `cache.rebalance()` → `void`

Evict L1 entries that now violate the current category or global capacity limits. Useful when `categoryLimits` are tightened after startup — normally, existing entries are not re-evaluated until they expire naturally.

```typescript
// Tighten analytics limit at runtime, then immediately enforce it
cache.options.categoryLimits['analytics:'].maxEntries = 50;
cache.rebalance();
```

### `cache.increment(key, ttlSeconds?)` → `Promise<number>`

Distributed counter. With Redis active, atomically increments via `INCR` and returns the fleet-wide value. **By default it fails OPEN on a Redis error** — it returns `0`, so a caller's `if (count > LIMIT) reject()` guard will NOT reject during an outage. Set `failClosed: true` to re-throw the error instead, enforcing the limit even when Redis is unavailable. Track failures via `cache.metrics().counters.errors`.

When Redis is disabled, it maintains an **in-process** counter with the same TTL semantics so dev/test rate-limiting works — but rate-limiting is then per-instance, **not fleet-wide**. A one-time warning is logged the first time this fallback is used.

### `cache.metrics()` → `CacheMetrics`

Returns a full metrics snapshot including hit rates, bloom filter stats, backplane counters, OOM eviction history, and tier sizes.

### `CacheService.toPrometheusText(metrics, prefix?, instanceName?)` → `string`

Converts a `CacheMetrics` snapshot to Prometheus text exposition format. Pass `instanceName` to add an `instance` label alongside `namespace`.

```typescript
app.get('/metrics', (_req, res) => {
  res.type('text/plain').send(
    CacheService.toPrometheusText(cache.metrics(), 'tricache', 'api-us-east-1'),
  );
});
```

### `cache.stats()` → `{ l1, disk }`

Lightweight L1 and disk stats without the full metrics breakdown.

### `cache.writeSnapshot(altPath?)` / `cache.loadSnapshot()`

Manual snapshot control. Called automatically on `SIGTERM`/`SIGINT` — only needed when you manage shutdown yourself. `writeSnapshot()` accepts an optional path to write to an alternate location without touching the configured default snapshot file.

```typescript
// Graceful-shutdown hook — write to a dated backup path
process.on('SIGTERM', async () => {
  await cache.writeSnapshot(`/backups/cache-${Date.now()}.snap`);
  process.exit(0);
});
```

### `await cache.ready()` → `Promise<void>`

Waits until cold-start hydration (remote blob snapshot hydration and/or `warmKeys` L2 warming) completes. Gate your HTTP listener or Kubernetes readiness probe on this promise to guarantee zero cold-cache traffic spikes.

```typescript
const cache = CacheService.create({ remoteSnapshot: { adapter: httpAdapter } });

// Gate HTTP traffic until L1 is fully hydrated from remote blob storage
await cache.ready();
app.listen(3000);
```

### `await cache.writeRemoteSnapshot()` → `Promise<boolean>` / `await cache.loadRemoteSnapshot()` → `Promise<number>`

Explicitly export/import L1 snapshots to/from remote blob storage (S3, Cloudflare R2, GCS, Azure, HTTP). Useful for Kubernetes `preStop` hooks or NestJS `onApplicationShutdown` lifecycle events:

```typescript
// NestJS graceful shutdown lifecycle hook
async onApplicationShutdown() {
  await cache.writeRemoteSnapshot();
  await cache.destroy();
}
```

### `cache.keys()` → `Generator<string>`

Lazily yields the key for every live (non-expired) L1 entry. Namespace prefix is stripped automatically. Uses a dedicated generator that skips intermediate tuple allocation.

```typescript
for (const key of cache.keys()) console.log(key);
```

### `cache.values<T>()` → `Generator<T>`

Lazily yields the cached value for every live L1 entry. Returns the live deserialized object (same reference semantics as `get()`). Uses `yield*` delegation — no intermediate generator frame.

```typescript
for (const session of cache.values<Session>()) evict(session);
```

### `cache.entries<T>()` → `Generator<[string, T]>`

Lazily yields `[key, value]` pairs for every live L1 entry. Key has namespace prefix stripped.

```typescript
for (const [key, user] of cache.entries<User>()) sync(key, user);
```

### `cache.rotateEncryptionKey(newKeyBase64, newMode?)` → `Promise<void>`

Dynamically rotates the active encryption key at runtime with zero downtime:
- Installs the new key as primary for all subsequent writes.
- Automatically preserves the previous key for seamless fallback decryption of existing cache entries.
- Gracefully drains and re-initializes all worker threads in the crypto pool (`WorkerPool.drainAndReinit()`).

```typescript
await cache.rotateEncryptionKey(newKeyBase64, 'aes-256-gcm');
```

### `cache.lock<T>(resourceKey, fn, options?)` → `Promise<T>`

Acquire a distributed (or in-process) mutual exclusion lock on `resourceKey`, execute `fn`, and automatically release the lock on return or throw.
- Prevents concurrent executions of critical tasks across a cluster (e.g. database migrations, nightly syncs, cron jobs).
- Safe token comparison via Redis Lua script prevents deleting a lock acquired by another worker if execution exceeded the lock TTL.
- Automatically falls back to an in-process promise-chain mutex in single-process or dev environments.

```typescript
const result = await cache.lock('cron:nightly-sync', async () => {
  return await runNightlyDatabaseSync();
}, {
  ttl: 60,              // Auto-release TTL in seconds (prevents deadlocks on crash)
  acquireTimeout: 5000, // Maximum wait time to acquire lock in ms
  retryInterval: 100,   // Polling retry interval in ms
});
```

### `cache.destroy()` → `Promise<void>`

Closes the Redis connection, unsubscribes the backplane, and stops all background timers.

---

## 🗄️ First-Class ORM Extensions (Prisma & Drizzle)

### Prisma Client Extension (`tricache/prisma`)

Add one-line query caching and automatic model tag invalidation to Prisma:

```typescript
import { PrismaClient } from '@prisma/client';
import { withTriCache } from 'tricache/prisma';
import { CacheService } from 'tricache';

const cache = CacheService.create({ redisHost: 'localhost' });

const prisma = new PrismaClient().$extends(
  withTriCache({
    cache,
    defaultTtl: 300,
    autoInvalidate: true, // Automatically invalidates 'user' tag on user.create / update / delete
  })
);

// Automatic caching with explicit options:
const activeUsers = await prisma.user.findMany({
  where: { active: true },
  cache: { ttl: 60, tags: ['users'], swr: 30 },
});
```

### Drizzle ORM Wrapper (`tricache/drizzle`)

Wrap any Drizzle query builder with automatic SQL + parameter hashing and caching:

```typescript
import { withCache } from 'tricache/drizzle';
import { eq } from 'drizzle-orm';

const activeUsers = await withCache(
  db.select().from(users).where(eq(users.active, true)),
  { cache, ttl: 300, tags: ['users'] }
);
```

---

## 📊 OpenTelemetry Native Metrics

TriCache integrates directly with OpenTelemetry `Meter` (`@opentelemetry/api`) to publish monotonic counters and observable gauges without scrapers:

```typescript
import { metrics } from '@opentelemetry/api';
import { CacheService } from 'tricache';

const meter = metrics.getMeter('my-service');

const cache = CacheService.create({
  redisHost: 'localhost',
  meter, // Native OpenTelemetry meter integration
});
```

---

## 💻 Developer & Troubleshooting CLI (`npx tricache`)

Inspect running caches, test latency across tiers, or flush namespaces directly from your terminal:

```bash
# Display full live dashboard (hit ratios, latencies, Count-Min Sketch hot keys)
npx tricache inspect --redis redis://localhost:6379 --namespace my-app

# Measure 3-tier response latency
npx tricache ping --redis redis://localhost:6379

# Flush namespace or prefix
npx tricache clear --redis redis://localhost:6379 --namespace my-app --prefix user:
```

---

## 🌐 HTTP Caching & 304 ETag Middleware (`tricache/http`)

Drop-in HTTP caching with automatic weak ETag generation and RFC-compliant `304 Not Modified` short-circuiting:

### Express & Connect
```typescript
import express from 'express';
import { expressCache } from 'tricache/http';
import { CacheService } from 'tricache';

const app = express();
const cache = CacheService.create({ redisHost: 'localhost' });

// Automatically caches GET /api/users, emits ETag, and returns 304 on If-None-Match
app.get('/api/users', expressCache({ cache, ttl: 300, tags: ['users'] }), async (_req, res) => {
  const users = await db.user.findMany();
  res.json(users);
});
```

### Hono & Web Standards
```typescript
import { Hono } from 'hono';
import { honoCache } from 'tricache/http';

const app = new Hono();

app.get('/api/users', honoCache({ ttl: 300, tags: ['users'] }), async (c) => {
  const users = await db.user.findMany();
  return c.json(users);
});
```

---

## 🎯 Priority levels

```typescript
import { CachePriority } from 'tricache';

CachePriority.LOW      // 1 — analytics, reports — evicted first
CachePriority.NORMAL   // 2 — general application data (default)
CachePriority.HIGH     // 3 — user profiles, config — evicted last
CachePriority.CRITICAL // 4 — never evicted while valid (auth tokens, sessions)
```

Priority is **auto-inferred** from the key when not specified:

| Key contains | Inferred priority |
|---|---|
| `auth:` or `session:` | `CRITICAL` |
| `user:`, `org:`, or `profile:` | `HIGH` |
| `analytics:`, `report:`, or `stats:` | `LOW` |
| anything else | `NORMAL` |

---

## 🧠 Eviction algorithm

L1 eviction uses **reservoir sampling** — an O(n) single pass samples 16 candidates, then sorts only those 16 (O(1)). Each candidate is scored:

```
score = priority × 1000 + min(hits, 100) × 10 + ttlRemaining/60s − age/60s
```

- Higher score = kept longer
- `CRITICAL` entries are excluded from sampling while valid
- When a category limit is breached, entries from that category receive a score penalty

---

## 🪵 Pluggable logger

Bring your own structured logger — tricache doesn't care if it's `pino`, `winston`, or `console`.

```typescript
import pino from 'pino';
const logger = pino();

CacheService.create({
  logger: {
    debug: (msg, meta) => logger.debug(meta ?? {}, msg),
    info:  (msg, meta) => logger.info(meta  ?? {}, msg),
    warn:  (msg, meta) => logger.warn(meta  ?? {}, msg),
    error: (msg, meta, err) => logger.error({ ...(meta ?? {}), err }, msg),
  },
});
```

---

## 🔐 Encryption

AES-256-GCM for L2 (Redis) values, disk spill files, and cold-start snapshots. Four modes are available via `encryptionMode`:

| Mode | Key length | Notes |
|---|---|---|
| `aes-256-gcm` | 32 bytes | **Default.** Authenticated encryption (AEAD). |
| `aes-128-gcm` | 16 bytes | ~15% faster than AES-256. Same AEAD guarantees. |
| `aes-128-ctr` | 16 bytes | Fastest cipher mode. AES-NI keystream, no auth tag. Use when integrity is guaranteed elsewhere (TLS, HMAC). |
| `xor` | any (≥ 16 bytes recommended) | **NOT cryptographic.** XOR obfuscation only. Dev/non-sensitive data. |

**Key generation:**

```bash
# AES-256 (32 bytes)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# AES-128 / AES-128-CTR (16 bytes)
node -e "console.log(require('crypto').randomBytes(16).toString('base64'))"

# XOR — any length, minimum 16 bytes recommended
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```typescript
// AES-256-GCM (default)
CacheService.create({ encryptionKey: '<base64-32-bytes>' });

// AES-128-GCM
CacheService.create({ encryptionKey: '<base64-16-bytes>', encryptionMode: 'aes-128-gcm' });

// AES-128-CTR (fastest cipher, no auth tag)
CacheService.create({ encryptionKey: '<base64-16-bytes>', encryptionMode: 'aes-128-ctr' });

// XOR obfuscation (NOT cryptographic — dev/non-sensitive only)
CacheService.create({ encryptionKey: '<base64-key>', encryptionMode: 'xor' });

// or use the env var: CACHE_ENCRYPTION_KEY=<base64-key>
```

| Mode | Redis format | Disk / snapshot format |
|---|---|---|
| `aes-256-gcm` | `enc:v1:<base64(IV[12]\|Tag[16]\|CT)>` | `TRIC1ENC\|IV[12]\|Tag[16]\|CT[N]` |
| `aes-128-gcm` | `a128:v1:<base64(IV[12]\|Tag[16]\|CT)>` | `TRIC1128\|IV[12]\|Tag[16]\|CT[N]` |
| `aes-128-ctr` | `ctr:v1:<base64(IV[16]\|CT)>` | `TRIC1CTR\|IV[16]\|CT[N]` |
| `xor` | `xor:v1:<base64(key⊕data)>` | `TRIC1XOR\|key⊕data[N]` |

Existing plaintext values are read transparently during key rotation.

### Zero-downtime key rotation

Set `previousEncryptionKey` to your old key while rolling out a new one. The cache tries the current key first; if decryption fails it transparently retries with the previous key. Remove `previousEncryptionKey` once all old entries have expired.

```typescript
CacheService.create({
  encryptionKey:         process.env.NEW_ENCRYPTION_KEY, // new AES-256 key
  previousEncryptionKey: process.env.OLD_ENCRYPTION_KEY, // fallback for old entries
  // previousEncryptionMode defaults to current encryptionMode
});
```

---

## 🧵 Worker thread crypto offload

By default, AES-GCM encryption/decryption runs synchronously on the V8 main thread. For payloads above a configurable size threshold this blocks the event loop for measurable durations. Enable worker thread offload to move encryption off the main thread:

```typescript
CacheService.create({
  encryptionKey:        process.env.CACHE_ENCRYPTION_KEY,
  workerThreads:        true,    // enable off-main-thread crypto
  workerThresholdBytes: 131_072, // only offload payloads ≥ 128 KB (default)
  workerPoolSize:       4,       // threads; 0 = auto (min(4, logical CPUs))
});
```

**How it works:**
- A fixed-size pool of Node.js `worker_threads` is created at startup; each worker holds an initialised `CacheEncryption` instance.
- Dispatch is round-robin; inter-thread IPC carries only strings (structured-clone fast path).
- Workers are `unref()`'d — they do not prevent the process from exiting cleanly.
- If worker initialisation fails the pool is silently disabled and synchronous crypto is used as a fallback — zero configuration required in environments where workers are unavailable.

**When to enable:**
- Payloads routinely exceed a few hundred KB with encryption enabled.
- You observe event-loop lag correlated with L2 read/write operations in APM.
- Rule of thumb: the default 128 KB threshold keeps overhead negligible for typical API response payloads while protecting against multi-MB documents.

---

## 🗜️ Transparent Payload Compression

TriCache includes built-in Brotli and Gzip compression for Redis L2 strings and L1.5 disk tier binary payloads, transparently reducing network bandwidth and storage footprints without manual application encoding.

```typescript
CacheService.create({
  compression:               'brotli', // 'brotli' | 'gzip' | 'none' (default: 'none')
  compressionThresholdBytes: 1024,     // only compress entries >= 1024 bytes (default)
});
```

### Storage Envelope Matrix

Entries written to Redis L2 and the disk spill tier use self-describing magic headers, allowing mixed uncompressed, compressed, and encrypted entries to coexist seamlessly during rollout:

| Envelope Header | State | Description |
|---|---|---|
| `cmp:v1:<data>` | Compressed | Compressed payload (Brotli or Gzip) |
| `ecp:v1:<data>` | Encrypted + Compressed | Payload compressed before encryption |
| `enc:v1:<data>` | Encrypted | AES-256-GCM / AES-128 encrypted without compression |
| `{"d": ...}` / raw | Plaintext | Uncompressed, unencrypted legacy JSON / msgpack |

### Worker Thread Offload

When `workerThreads: true` is enabled, compression and decompression for large payloads above `workerThresholdBytes` are offloaded to background worker threads alongside encryption, keeping the V8 main event loop free for concurrent HTTP requests.

---

## ⚡ Next.js 16 & 15 Integration (`tricache/next`)

TriCache provides first-class support for Next.js 16 `"use cache"`, React 19 RSC streaming, and Next.js 15/16 ISR via `tricache/next`.

### Setup in `next.config.mjs`

```javascript
// next.config.mjs
/** @type {import('next').NextConfig} */
const nextConfig = {
  // Point Next.js directly to the default export
  cacheHandler: require.resolve('tricache/next'),
  cacheMaxMemorySize: 0, // Disable Next.js default in-memory cache to let TriCache manage RAM
};

export default nextConfig;
```

### Custom Options Factory

To configure TriCache with custom Redis, encryption, or namespace settings:

```typescript
// cache-handler.mjs
import { createNextCacheHandler } from 'tricache/next';

export default createNextCacheHandler({
  namespace: 'my-next-app',
  redisHost: process.env.REDIS_HOST,
  tagStrategy: 'generational',
  backplaneMode: 'stream',
});
```

```javascript
// next.config.mjs
export default {
  cacheHandler: require.resolve('./cache-handler.mjs'),
};
```

### Key Architectural Highlights
- **Single-Use Stream Re-hydration:** React 19 RSC streams (`ReadableStream<Uint8Array>`) are drained to contiguous binary buffers on `set()`, and fresh unlocked `ReadableStream` instances are re-hydrated on every `get()` hit.
- **Dynamic `softTags` Verification:** In Next.js 16 App Router, layout and route boundary invalidations pass `softTags` into `ctx.softTags` at read time. TriCache dynamically validates them against generational tag versions, triggering misses on invalidated boundaries.
- **Stream Error Boundary:** Mid-flight client disconnects or aborted streams are caught safely without throwing or storing corrupted partial payloads.
- **Automatic Build Phase Bypass:** Automatically detects `NEXT_PHASE=phase-production-build` during `next build` and runs in-memory without opening Redis network sockets.

---

## 🦁 NestJS Integration (`tricache/nestjs`)

TriCache provides an official NestJS dynamic module and `@nestjs/cache-manager` store adapter compatible with `cache-manager` v5/v6:

### Synchronous Module Registration

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { TriCacheModule } from 'tricache/nestjs';

@Module({
  imports: [
    TriCacheModule.register({
      namespace: 'my-nest-api',
      redisHost: process.env.REDIS_HOST,
      encryptionKey: process.env.CACHE_ENCRYPTION_KEY,
    }),
  ],
})
export class AppModule {}
```

### Asynchronous Module Registration (with ConfigService)

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TriCacheModule } from 'tricache/nestjs';

@Module({
  imports: [
    ConfigModule.forRoot(),
    TriCacheModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        namespace: config.get<string>('CACHE_NAMESPACE', 'nest-api'),
        redisHost: config.get<string>('REDIS_HOST'),
        redisPort: config.get<number>('REDIS_PORT', 6379),
        tagStrategy: 'generational',
        backplaneMode: 'stream',
      }),
    }),
  ],
})
export class AppModule {}
```

### Injecting into Services & Controllers

Use either standard `@Inject(CACHE_MANAGER)` for `@nestjs/cache-manager` compatibility, or `@Inject('TRICACHE_SERVICE')` for direct access to TriCache's three-tier engine:

```typescript
import { Injectable, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { CacheStore } from '@nestjs/cache-manager';
import type { CacheService } from 'tricache';

@Injectable()
export class UsersService {
  constructor(
    @Inject(CACHE_MANAGER) private cacheManager: CacheStore,
    @Inject('TRICACHE_SERVICE') private triCache: CacheService,
  ) {}

  async getUser(id: string) {
    // Standard NestJS cache-manager API (millisecond TTL)
    const cached = await this.cacheManager.get(`user:${id}`);
    if (cached) return cached;

    // Or use TriCache's native SWR & thundering-herd prevention:
    return this.triCache.get(`user:${id}`, () => this.fetchFromDb(id), 300, { swr: 60 });
  }
}
```

### Declarative Method Decorators (`@Cacheable`, `@CacheEvict`)

Remove cache boilerplate from your NestJS services using declarative method decorators:

```typescript
import { Injectable } from '@nestjs/common';
import { Cacheable, CacheEvict } from 'tricache/nestjs';

@Injectable()
export class ProductsService {
  // Automatically caches result in TriCache (L1 -> L1.5 -> L2) with stampede coalescing
  @Cacheable({
    key: (id: string) => `product:${id}`,
    ttl: 300,
    swr: 60,
    tags: ['products'],
  })
  async findById(id: string) {
    return this.db.product.findUnique({ where: { id } });
  }

  // Automatically invalidates tags or keys after successful method execution
  @CacheEvict({ tags: ['products'] })
  async updateProduct(id: string, dto: UpdateProductDto) {
    return this.db.product.update({ where: { id }, data: dto });
  }
}
```

---

## 🏷️ Generational Tag Invalidation (`tagStrategy: 'generational'`)

Traditional tag-based caching stores key sets in Redis and performs $O(N)$ key deletions on `invalidateTag()`. For high-cardinality collections, this triggers blocking Redis spikes and cache stampedes.

With `tagStrategy: 'generational'`:
- **$O(1)$ Atomic Tag Invalidation:** `cache.invalidateTag('products')` atomically increments an integer version counter in Redis (`INCR tag_ver:products`) and updates local memory.
- **Atomic Multi-Field Hash Schema:** Entries in Redis are stored as a unified Hash `{ d: envelope, t: timestamp, tv: tagVersionsJson }` with an atomic `MULTI/EXEC` transaction.
- **Pipelined Batch Invalidation:** `cache.invalidateTags(['t1', 't2'])` pipelines multi-tag version increments in a single network round-trip.
- **Zero-Tear Compare-and-Delete:** Stale entries are pruned upon access using an atomic Lua script (`deleteIfSetBefore`) on Redis and L1 RAM, eliminating race conditions where concurrent revalidations write newer data.
- **Self-Healing Reconciliation:** In-memory tag versions are verified against Redis when `Date.now() - lastSyncedAt > tagVersionTtlMs` (default: 5 s), guaranteeing bounded staleness even if a backplane broadcast is dropped during a network partition.

```typescript
const cache = CacheService.create({
  tagStrategy: 'generational',
  tagVersionTtlMs: 5_000,
});

// Cache entry with tags
await cache.set('item:123', productData, 3600, undefined, { tags: ['catalog', 'electronics'] });

// Invalidate in O(1) time
await cache.invalidateTag('catalog');
```

---

## 🌊 Redis Streams Backplane (`backplaneMode: 'stream'`)

Standard Redis Pub/Sub operates on an *at-most-once* delivery model. If an instance experiences a transient network disconnect, container reschedule, or long GC pause, invalidation messages published during the disconnection are lost.

Setting `backplaneMode: 'stream'` switches the backplane to a durable append-only log in Redis using `XADD` and `XREAD`:

```typescript
const cache = CacheService.create({
  backplaneMode: 'stream',
  backplaneStreamMaxLen: 10_000, // Approximate MAXLEN trimming
  backplaneStreamBlockMs: 2_000,  // XREAD BLOCK timeout
});
```

### Architecture & Resilience
- **Cluster Single-Slot Routing:** Stream keys default to `tricache:stream:{<namespace>}`, ensuring multi-node Redis Clusters route all stream operations to a single slot without cross-slot errors.
- **Dedicated Long-Polling Consumer:** Runs on an isolated Redis client connection (`XREAD BLOCK`) so standard cache `GET`/`SET` pipelines are never blocked.
- **Zero-Drop Replay on Reconnect:** Tracks `_lastStreamId` to automatically replay all missed invalidations in order after short network drops or GC pauses without flushing L1.
- **Trim Gap Fallback:** If an instance was disconnected longer than the stream retention window, it detects the gap, increments `metrics().backplane.streamGaps`, safely flushes L1, and resets to `'$'`.
- **Instant Clean Teardown:** `cache.destroy()` immediately disconnects the dedicated client socket to interrupt blocking long-polls without stalling process shutdown.

---

## 🛡️ Read Safety (`cloneStrategy: 'structuredClone'`)

By default (`cloneStrategy: 'none'`), TriCache returns raw in-memory JS references from L1 hits for maximum throughput (~350 ns per hit). If application code mutates the returned object, the cached reference is directly modified.

Setting `cloneStrategy: 'structuredClone'` enables deep clone isolation:

```typescript
const cache = CacheService.create({
  cloneStrategy: 'structuredClone',
});

const user = await cache.get('user:1', () => db.fetchUser(1));
user.roles.push('admin'); // Mutating caller copy does NOT pollute cached L1 state
```

Supported types: plain objects, arrays, Dates, Maps, Sets, and TypedArrays. When `frozen: true` is also enabled, L1 entries remain frozen while callers receive fully mutable clones.

---

## ☁️ Serverless / ephemeral disk environments

On Lambda, Cloud Run, Fly.io, Railway, and similar platforms, the filesystem (`os.tmpdir()`) is container-scoped and is wiped on every cold start. Disk spill and cold-start snapshots are therefore useless and waste I/O budget.

TriCache auto-detects serverless runtimes at construction time (zero I/O — environment variable checks only) and automatically disables the disk tier:

| Runtime | Detection env var |
|---|---|
| AWS Lambda | `AWS_LAMBDA_FUNCTION_NAME` |
| Google Cloud Run | `K_SERVICE` |
| Google Cloud Functions | `FUNCTION_TARGET` |
| Azure Functions | `WEBSITE_INSTANCE_ID` |
| Fly.io | `FLY_APP_NAME` |
| Railway | `RAILWAY_ENVIRONMENT` |
| Vercel | `VERCEL` |

You can also control disk behaviour explicitly:

```typescript
// Force-disable disk tier (e.g., when running inside a Docker container with no writable tmpdir)
CacheService.create({ disableDisk: true });

// Force-enable disk tier even when a serverless env var is present (advanced override)
CacheService.create({ disableDisk: false });
```

When disk is disabled:
- The disk spill callback is a no-op.
- `disk.load()` / `disk.delete()` / `disk.clear()` are never called.
- `loadSnapshot()` and `writeSnapshot()` are skipped.
- The background disk janitor timer is not started.
- `metrics().disk.disabled` is `true`.

### 🚀 Remote Blob Storage Cold-Start Hydration (S3, Cloudflare R2, GCS, HTTP)

In modern container architectures (Kubernetes, AWS ECS/Fargate, Google Cloud Run, Fly.io), local filesystems are ephemeral and wiped across rolling deployments.

TriCache provides **Remote Snapshot Hydration** to persist L1 RAM snapshots to remote object storage and restore them in milliseconds during new pod/container spin-up:

```typescript
import { CacheService, createHttpSnapshotAdapter } from 'tricache';

// Zero-dependency HTTP adapter (Node 22 native fetch)
// Works directly with S3/R2 presigned URLs or internal storage webhooks
const httpAdapter = createHttpSnapshotAdapter({
  getUrl: process.env.SNAPSHOT_GET_PRESIGNED_URL!,
  putUrl: process.env.SNAPSHOT_PUT_PRESIGNED_URL!,
});

const cache = CacheService.create({
  disableDisk: true, // stateless container
  remoteSnapshot: {
    adapter: httpAdapter,
    maxAgeMs: 2 * 60 * 60 * 1000, // reject snapshots older than 2 hours
    saveOnShutdown: true,          // trigger async upload on SIGTERM/SIGINT
    intervalMs: 5 * 60 * 1000,     // background periodic upload every 5 minutes
  },
});

// Gate your Kubernetes readiness probe or HTTP listener until L1 RAM is warm!
await cache.ready();
app.listen(3000);
```

#### Custom Cloud SDK Adapter (AWS S3, Google Cloud Storage, Azure Blob)

To use your existing `@aws-sdk/client-s3` or `@google-cloud/storage` clients directly:

```typescript
import { CacheService, createCustomSnapshotAdapter } from 'tricache';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: 'us-east-1' });

const s3Adapter = createCustomSnapshotAdapter({
  async get() {
    try {
      const res = await s3.send(new GetObjectCommand({
        Bucket: 'my-cache-snapshots',
        Key: 'production-l1.snap',
      }));
      const ab = await res.Body?.transformToByteArray();
      return ab ? Buffer.from(ab) : null;
    } catch (e: any) {
      if (e.name === 'NoSuchKey') return null;
      throw e;
    }
  },
  async put(data: Buffer) {
    await s3.send(new PutObjectCommand({
      Bucket: 'my-cache-snapshots',
      Key: 'production-l1.snap',
      Body: data,
    }));
  },
});

const cache = CacheService.create({
  remoteSnapshot: { adapter: s3Adapter },
});
```

- **Encryption at rest**: When `encryptionKey` is configured, remote snapshots are automatically encrypted with AES-256-GCM before upload, keeping your remote storage compliant with SOC2/HIPAA.
- **Fail-safe**: If the remote blob is missing (first deploy) or corrupted, TriCache logs a warning, starts cold, and continues serving requests without interruption.

---

## 🔴 Redis Cluster and Sentinel

TriCache supports Redis Cluster (slot-based sharding) and Redis Sentinel (automatic primary failover) via ioredis built-in support.

### Redis Cluster

```typescript
CacheService.create({
  redisClusterNodes: [
    { host: 'redis-node-1.example.com', port: 6379 },
    { host: 'redis-node-2.example.com', port: 6379 },
    { host: 'redis-node-3.example.com', port: 6379 },
  ],
  redisTls: true,
  useShardedPubSub: true, // Redis 7+ sharded pub/sub (SPUBLISH / SSUBSCRIBE)
});
```

ioredis handles slot routing, moved/ask redirects, and re-queuing commands during slot migrations transparently. You can list any subset of cluster nodes — ioredis discovers the full topology automatically.

#### Sharded Pub/Sub (`useShardedPubSub`)

When `useShardedPubSub: true` is enabled on Redis Cluster (Redis 7+), invalidation messages are published via `SPUBLISH` and subscribed via `SSUBSCRIBE` bound directly to the `{<namespace>}` slot shard. This eliminates cluster-wide broadcast gossip, drastically reducing cluster bus CPU utilization under heavy invalidation load.

### Redis Sentinel

```typescript
CacheService.create({
  redisSentinel: {
    name: 'mymaster',
    sentinels: [
      { host: 'sentinel-1.example.com', port: 26379 },
      { host: 'sentinel-2.example.com', port: 26379 },
      { host: 'sentinel-3.example.com', port: 26379 },
    ],
  },
  redisTls: true,
});
```

ioredis monitors the current master via the Sentinel topology and transparently reconnects to a new primary after failover. The backplane subscriber is also constructed in the appropriate cluster/sentinel mode.

### Wire Protocol Compatibility (`redisProtocol: 2 | 3`)

TriCache uses `ioredis` v6, which connects using **RESP3** (`redisProtocol: 3`) by default for optimized structured parsing and streaming.

If your infrastructure routes Redis traffic through intermediate proxies that only understand RESP2 (such as **Twemproxy**, **Envoy Redis proxy filter**, or older AWS ElastiCache Serverless proxy configurations that reject the `HELLO 3` handshake), explicitly set `redisProtocol: 2`:

```typescript
CacheService.create({
  redisHost: 'envoy-redis-proxy.internal',
  redisProtocol: 2, // force RESP2 wire protocol
});
```

> `redisHost` / `redisPort` are ignored when `redisClusterNodes` or `redisSentinel` is set. All three topology modes support `redisTls` and `redisProtocol` (RESP2/RESP3).

---

## ⚡ WASM Bloom filter

A 100,000-bit filter with k=7 hash probes is used when it is large enough for the
configured `l1MaxEntries`; otherwise a right-sized pure-JS filter is instantiated
automatically (see `createBloomFilter`). For the default 100K-bit filter:

- At the default `l1MaxEntries: 2,000` — false-positive rate ≈ **0.00007%** (m=100,000, k=7)
- At its rated capacity (~10,400 entries) — false-positive rate ≈ **1%**
- When `l1MaxEntries` exceeds the WASM filter's ~10,400-entry capacity, a JS filter sized via the optimal formula (m = ⌈–n·ln p / (ln 2)²⌉, k = round(ln 2 · m / n) clamped to [4, 10]) is used instead — no capacity cliff.
- The filter rebuilds automatically when stale bits from deleted/expired entries accumulate

Mechanics:
- `mightContain(key) === false` → **guaranteed miss** — the Map lookup is skipped entirely
- `mightContain(key) === true` → probable hit — the Map is checked to confirm

The 562-byte WASM binary is inlined as Base64 — zero filesystem access at runtime. Falls back to a pure-JS implementation if `WebAssembly` is unavailable.

---

## 🔬 High-Performance Architecture & Memory Hygiene

TriCache is engineered for low-latency, high-throughput environments where garbage collection (GC) pauses and main-thread blocking must be minimized. The codebase employs several advanced V8 and hardware-aware optimizations:

### ⚡ Performance & Memory Hygiene
- **Zero-Allocation Hot Paths:** To eliminate object allocation thrashing on hot L1 reads, TriCache reuses a single, pre-allocated static `_hit` object literal in [src/smart-memory-cache.ts](src/smart-memory-cache.ts) to return cache hits synchronously.
- **Fast-Path Binary Operations (Uint32Array XOR):** The XOR obfuscation engine in [src/encryption.ts](src/encryption.ts) automatically detects if buffers are 4-byte-aligned. If so, it processes the operation using `Uint32Array` views, allowing the V8 JIT compiler to compile the loop into highly-optimized, 32-bit register-level CPU `XOR` instructions instead of a slow byte-by-byte traversal.
- **Pre-allocated Eviction Pools:** During L1 eviction, candidate selection avoids generating temporary object literals. The system samples candidates into a pre-allocated `_evictPool` array and mutates their fields in-place, eliminating GC pressure when the cache is under heavy write load.

### 🛡️ Production-First Ergonomics & Resiliency
- **Next.js HMR Resiliency:** Normal in-memory caches re-instantiate and wipe their state during Next.js Hot Module Replacement (HMR) reloads. TriCache binds its singleton instance to `globalThis` to preserve the L1 cache across hot-reload cycles in server environments.
- **Graceful Degradation & Fallbacks:**
  - **L2 Circuit Breaker:** Protects your app from cascading failures if Redis gets slow or goes down, automatically failing back to L1/disk and probing Redis health on a cooldown timer.
  - **Dynamic Bloom Filters:** Uses a WebAssembly Bloom filter for fast miss checks, but automatically falls back to a dynamically-sized, memory-optimized pure JS Bloom filter if the cache size exceeds the WebAssembly filter's hardcoded capacity limit.
  - **CPU-Efficient Count-Min Sketch:** Keeps access-frequency history across eviction boundaries in a tight `4 rows × 512 counters` `Uint16Array` (4 KB total). This fits entirely within the CPU's L1d cache, ensuring frequency updates are essentially free.

---

## 📊 Performance

Measured on a single Node.js thread (no `await` on synchronous paths):

**L1 SmartMemoryCache**

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `get` — hot hit (8K entries) | **2.81 M/s** | 356 ns | bloom → Map lookup → return cached value |
| `get` — cold miss | **7.14 M/s** | 140 ns | bloom gates → early return |
| `set` — tiny payload | 1.06 M/s | 944 ns | pack() + Map.set + bloom.add |
| `set` — small payload (< 512 B) | 574.1 K/s | 1.74 µs | pack() same unified path, larger payload |
| `set` — large payload (≥ 512 B) | 228.6 K/s | 4.37 µs | pack() larger payload |
| `set` — CRITICAL priority | 843.6 K/s | 1.19 µs | same set path; skipped in eviction sort |
| `delete` — exact key | **5.36 M/s** | 186 ns | Map.delete |
| `deletePattern` — glob wildcard | 18.7 K/s | 53.48 µs | O(n) Map scan |
| Count-Min Sketch estimate | **3.37 M/s** | 297 ns | 4 row lookups — called on every `get()` hit and `set()` |

**Iterator interface (L1 live entries, 500 entries)**

| Method | Throughput | Latency | Notes |
|---|---|---|---|
| `cache.keys()` | 26.6 K/s | 37.53 µs | no `[key,entry]` tuple allocation |
| `cache.values()` | 35.5 K/s | 28.19 µs | `yield*` delegation |
| `cache.entries()` | 24.0 K/s | 41.73 µs | `[strippedKey, value]` pairs |
| raw `Map` iteration (baseline) | 277.2 K/s | 3.61 µs | no expiry check, no generator overhead |

**CacheService (end-to-end)**

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `get` — L1 warm hit | **2.03 M/s** | 491 ns | inflight check → l1.get → return cached value |
| `get` — SWR stale serve | **1.78 M/s** | 562 ns | serves stale; revalidates async |
| `get` — miss + fetchFn | 13.7 K/s | 73 µs | Promise microtask + l1.set |
| `set` | 28.7 K/s | 34.86 µs | l1.set + disk.save (fire-and-forget) |
| `delete` — exact key | 7.3 K/s | 137.82 µs | l1.delete + disk.delete + backplane |
| `delete` — glob `*` | 687 K/s | 1.46 µs | l1.deletePattern O(n) + disk glob |

**Encryption** (IV pool, pre-allocated output buffers)

| Mode | Payload | Encrypt | Decrypt |
|---|---|---|---|
| AES-256-GCM | 64 B | 140.4 K/s / 7.12 µs | 155.5 K/s / 6.43 µs |
| AES-256-GCM | 512 B | 103.1 K/s / 9.70 µs | 142.9 K/s / 6.99 µs |
| AES-256-GCM | 4 KB | 58.4 K/s / 17.12 µs | 48.0 K/s / 20.84 µs |
| AES-128-GCM | 64 B | 148.8 K/s / 6.72 µs | 173.0 K/s / 5.78 µs |
| AES-128-GCM | 512 B | 135.7 K/s / 7.37 µs | 158.8 K/s / 6.30 µs |
| AES-128-GCM | 4 KB | 70.2 K/s / 14.24 µs | 53.2 K/s / 18.79 µs |
| AES-128-CTR | 64 B | 187.9 K/s / 5.32 µs | 196.9 K/s / 5.08 µs |
| AES-128-CTR | 512 B | 183.5 K/s / 5.45 µs | 185.6 K/s / 5.39 µs |
| AES-128-CTR | 4 KB | 78.4 K/s / 12.75 µs | 71.8 K/s / 13.93 µs |
| XOR _(obfuscation only)_ | 64 B | 2.43 M/s / 412 ns | 2.10 M/s / 476 ns |
| XOR _(obfuscation only)_ | 512 B | 665.5 K/s / 1.50 µs | 715.3 K/s / 1.40 µs |
| XOR _(obfuscation only)_ | 4 KB | 114.5 K/s / 8.73 µs | 77.6 K/s / 12.89 µs |

> AES and XOR string-path numbers shown (Redis L2). Buffer path (disk/snapshot) is 5–20% faster — no base64 overhead.  
> AES-128-GCM is 5–50% faster than AES-256-GCM depending on payload (gap widens at mid-range sizes on AES-NI hardware).  
> AES-128-CTR removes the GHASH MAC step: ~50% faster than AES-128-GCM at small payloads; use only when integrity is guaranteed by transport.  
> XOR numbers are for the buffer path (32-bit word-level XOR, 4 bytes/iteration). XOR dominates at small payloads (no cipher setup) and remains ~2× faster than AES at 4 KB.

See [BENCHMARKS.md](BENCHMARKS.md) for the full breakdown: bloom filter cost, serialization by payload size, eviction pressure, concurrency analysis, multi-tenancy isolation, and a realistic 80/15/5 read/miss/write workload.

---

## 🤝 Contributing

Contributions of all kinds are welcome! Please check out our [Contributing Guide](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md) for detailed instructions on development setup, testing, benchmarking, and PR submission.

1. Fork the repo and create a feature branch (`git checkout -b feat/my-feature`)
2. Run `pnpm lint`, `pnpm typecheck:all`, and `pnpm test` — all checks must pass
3. Run `pnpm bench` if you touch a hot path and include before/after numbers in your PR
4. Open your PR against `main`

> New to the codebase? Start with [src/cache-service.ts](src/cache-service.ts) for the public API and [src/smart-memory-cache.ts](src/smart-memory-cache.ts) for the L1 engine. See [CONTRIBUTING.md](CONTRIBUTING.md#codebase-architecture) for full architecture notes.

---

## 🛡️ Security

Found a vulnerability? **Please don't open a public issue.** Report it privately via [GitHub Security Advisories](https://github.com/Kareem411/TriCache/security/advisories/new) so it can be patched before disclosure.

For encryption key generation and rotation best practices, see the [Encryption](#-encryption) section.

---

## 📄 License

MIT
