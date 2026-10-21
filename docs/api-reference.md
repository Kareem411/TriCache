# API Reference

> **Comprehensive TypeScript Reference**: Method signatures, parameter types, configuration schema, and environment variables derived directly from the active engine types.

---

## 1. Lifecycle & Test Helpers

### `CacheService.preset(type, overrides?)`
Creates a pre-configured `CacheService` instance tuned for specific workload profiles (`'nextjs'`, `'microservice'`, `'serverless'`, `'enterprise-hardened'`).

```typescript
static preset(
  type: CachePresetType,
  overrides?: Partial<CacheOptions>
): CacheService
```

### `CacheService.create(options?)`
Returns the process-level singleton for the given namespace. Options are applied only on the first call per namespace. When options conflict on subsequent calls, a warning is logged by default (or an error is thrown if `strictSingleton: true`).

```typescript
static create(options?: CacheOptions): CacheService
```

### `CacheService.createAsync(optionsOrPromise)`
Asynchronous factory that awaits a promise resolving `CacheOptions` before returning the singleton. Ideal for initializing from cloud secret managers (AWS Secrets Manager, Vault).

```typescript
static createAsync(
  options: Promise<CacheOptions> | CacheOptions
): Promise<CacheService>
```

### `CacheService.reset(options?)`
Gracefully closes connections on the existing singleton and initializes a completely fresh instance. Indispensable for clean unit and integration test teardown.

```typescript
static reset(options?: CacheOptions): CacheService
```

### `cache.destroy()` / `cache.close()`
Gracefully terminates Redis sockets, pub/sub listeners, snapshot intervals, and disk-tier file descriptors.

```typescript
destroy(): Promise<void>
```

---

## 2. Ergonomics & Fetching

### `cache.wrap<T>(key, fetchFn, options?)`
Ergonomic read-through wrapper combining singleflight thundering-herd deduplication, SWR, probabilistic early expiration, and proactive background refresh.

```typescript
wrap<T>(
  cacheKey: string,
  fetchFn: () => Promise<T>,
  options?: WrapOptions
): Promise<T>
```

**`WrapOptions` Schema:**
```typescript
interface WrapOptions {
  ttl?: number;             // Hard TTL in seconds (default: 300)
  swr?: number;             // Stale-While-Revalidate window in seconds
  priority?: CachePriority; // LOW, NORMAL, HIGH, CRITICAL
  tags?: string[];          // Semantic tags for O(1) invalidation
  dependsOn?: string[];     // Key patterns this entry cascades on (e.g. ['user:*'])
  refreshAhead?: number;    // 0-1 fraction of TTL when background refresh triggers
  xfetchBeta?: number;      // XFetch probabilistic early refresh factor (0.5-2.0)
  notFoundTtl?: number;     // Negative caching TTL for null/undefined returns
}
```

### `cache.get<T>(key, fetchFn, ttlSeconds?, opts?)`
Core read-through query executing the L1 RAM $\rightarrow$ L1.5 Disk $\rightarrow$ L2 Redis tier cascade. Misses invoke `fetchFn()` under Singleflight deduplication.

```typescript
async get<T>(
  cacheKey: string,
  fetchFn: () => Promise<T>,
  ttlSeconds = 300,
  opts?: {
    priority?: CachePriority;
    swr?: number;
    refreshAhead?: number;
    xfetchBeta?: number;
    notFoundTtl?: number;
    tags?: string[];
  }
): Promise<T>
```

### `cache.set<T>(key, data, ttlSeconds?, priority?, opts?)`
Explicitly writes an entry across L1 RAM, spills to L1.5 disk (if enabled), and publishes to L2 Redis.

```typescript
async set<T>(
  cacheKey: string,
  data: T,
  ttlSeconds = 300,
  priority?: CachePriority,
  opts?: {
    tags?: string[];
    dependsOn?: string[];
  }
): Promise<void>
```

### `cache.getIfFresh<T>(key)`
Synchronous L1 RAM lookup. Returns the cached JS object if present and fresh, or `null` if absent, expired, or spilled to disk (0 nanoseconds async overhead).

```typescript
getIfFresh<T = unknown>(cacheKey: string): T | null
```

### `cache.peek<T>(key)`
Inspects a cached value across tiers without updating LRU/LFU frequency counters, resetting CMS decay, or triggering bloom filter state.

```typescript
async peek<T = unknown>(cacheKey: string): Promise<T | null>
```

### `cache.setIfAbsent<T>(key, value, ttlSeconds?, priority?)`
Atomic set-if-not-exists (`NX`) across L1, disk, and L2 Redis. Returns `true` if the key was set, `false` if already occupied.

```typescript
async setIfAbsent<T>(
  cacheKey: string,
  value: T,
  ttlSeconds = 300,
  priority?: CachePriority
): Promise<boolean>
```

### `cache.touch(key, newTtlSeconds)`
Updates the TTL of an existing entry across all active tiers without reading or re-serializing the underlying payload.

```typescript
async touch(cacheKey: string, newTtlSeconds: number): Promise<boolean>
```

---

## 3. Distributed Primitives & Batch Operations

### `cache.lock<T>(resourceKey, fn, options?)`
Distributed mutex with Redlock-style safety. Uses UUID ownership tokens, exponential backoff retries, and atomic Lua verification on release. Automatically falls back to an in-process mutex when Redis is disabled.

```typescript
async lock<T>(
  resourceKey: string,
  fn: () => Promise<T>,
  options?: LockOptions
): Promise<T>
```

**`LockOptions` Schema:**
```typescript
interface LockOptions {
  ttl?: number;                     // Lock lease duration in seconds (default: 30)
  acquireTimeout?: number;          // Max wait time in ms before aborting (default: 5000)
  retryInterval?: number;           // Polling interval in ms (default: 100)
  failClosedOnRedisError?: boolean; // Throws immediately on Redis errors instead of in-process fallback (prevents split-brain)
}
```

### `cache.increment(key, ttlSeconds?)`
Atomic distributed counter. Increments the Redis integer key, applies TTL on creation, and enforces `failClosed` rules during outages.

```typescript
async increment(cacheKey: string, ttlSeconds?: number): Promise<number>
```

### `cache.mget<T>(keys, fetchFn?, ttl?, priority?)`
Differential multi-tier batch retrieval. Cascades through L1 RAM, L2 Redis (pipelined `MULTI`), and L1.5 disk spill, invoking `fetchFn(missKeys)` **only for the true remainder of unfulfilled keys**.

```typescript
async mget<T>(
  keys: string[],
  fetchFn?: (missKeys: string[]) => Promise<Record<string, T> | Map<string, T>>,
  ttl?: number | ((key: string) => number),
  priority?: CachePriority
): Promise<(T | undefined)[]>
```

#### Parameters:
* `keys` (`string[]`): Array of keys to retrieve.
* `fetchFn` (`(missKeys: string[]) => Promise<Record<string, T> | Map<string, T>>`, optional): Origin query handler invoked only if there are unresolved misses after scanning L1, L2, and L1.5 disk tiers.
* `ttl` (`number | ((key: string) => number)`, optional, default: `300`): Cache lifetime in seconds for newly fetched values. Accepts a constant number or a per-key function enabling heterogeneous TTLs in a single batch call.
* `priority` (`CachePriority`, optional): Eviction priority (`LOW`, `NORMAL`, `HIGH`, `CRITICAL`) assigned to newly fetched entries during backfill.

#### Return Value:
* `Promise<(T | undefined)[]>`: Deterministic array whose elements correspond 1:1 with the input `keys` array (`results[i]` represents `keys[i]`). Missing keys that are not returned by `fetchFn` are populated as `undefined`.

#### Performance & Guarantees:
* **Zero I/O Warm Path**: Keys resident in L1 RAM return references immediately without string deserialization.
* **Pipelined L2 Batch**: L1 misses are fetched from Redis in a single network round-trip via `.multi().get(...)`.
* **Tombstone Protection**: L1.5 disk lookups check active in-memory deletion tombstones (`_pendingDiskDeletes`) and pattern tombstones to prevent resurrection of recently invalidated data.
* **Concurrent Backfill**: All newly fetched origin values are concurrently backfilled to L1 and L2 via `Promise.all` with TTL jitter.

### `cache.mset<T>(entries)`
Pipelined multi-key write across all tiers in a single network round-trip.

```typescript
async mset<T = unknown>(
  entries: Record<string, {
    value: T;
    ttl?: number;
    priority?: CachePriority;
    tags?: string[];
    dependsOn?: string[];
  }>
): Promise<void>
```

### `cache.mdel(keys)`
Pipelined multi-key deletion across L1 RAM, L1.5 disk, and L2 Redis.

```typescript
async mdel(keys: string[]): Promise<void>
```

### `cache.delete(key)`
Deletes a key from all local tiers and broadcasts an invalidation message across the cluster backplane.

```typescript
async delete(cacheKey: string): Promise<void>
```

### `cache.invalidateTag(tag, opts?)` & `cache.invalidateTags(tags, opts?)`
Invalidates all cache entries tagged with the specified identifier(s), glob wildcard pattern(s), or hierarchical namespace(s). Under `tagStrategy: 'generational'`, executes via atomic version increments.

* **Wildcard Tag Matching**: Use `*` (zero or more characters) or `?` (single character) in tag names (e.g. `cache.invalidateTag('org:123:*')` or `cache.invalidateTag('*:comments')`).
* **Parent-Child Tag Cascading**: Pass `{ cascade: true }` to invalidate a tag and all descendant namespaces (e.g. `cache.invalidateTag('org:123', { cascade: true })` invalidates `org:123` and `org:123:dept:456`).
* **Automatic Tag Expansion**: When `hierarchicalTags: true` is configured in `CacheOptions`, tags (e.g. `['org:123:dept:456']`) are automatically expanded into all ancestor namespaces (`['org', 'org:123', 'org:123:dept', 'org:123:dept:456']`).

```typescript
async invalidateTag(tag: string, opts?: InvalidateTagOptions): Promise<void>
async invalidateTags(tags: string[], opts?: InvalidateTagOptions): Promise<void>
```

### `cache.getTagVersion(tag)`
Returns the current generational version integer for a given tag.

```typescript
async getTagVersion(tag: string): Promise<number>
```

---

## 4. Inspection, Iteration & Diagnostics

### `cache.has(key)`
Synchronous check returning `true` if the key might exist in L1 RAM (evaluated in ~140 ns via the bloom filter).

```typescript
has(cacheKey: string): boolean
```

### `cache.ttl(key)`
Returns the remaining TTL in seconds for an active L1 entry, or `null` if expired/absent.

```typescript
ttl(cacheKey: string): number | null
```

### `cache.keys()`, `cache.values()`, `cache.entries()`
High-performance ES6 Generator iterators yielding non-expired L1 entries with zero tuple allocations.

```typescript
*keys(): Generator<string>
*values<T = unknown>(): Generator<T>
*entries<T = unknown>(): Generator<[string, T]>
```

### `cache.scan<T>(fn)`
Zero-allocation bulk scanner iterating over all live L1 entries. Passes `rawKey`, `value`, and namespace `offset` directly to prevent string slicing allocations.

```typescript
scan<T = unknown>(
  fn: (rawKey: string, value: T, offset: number) => void
): void
```

### `cache.hotKeys(n?)`
Returns the top $N$ most frequently accessed keys derived directly from the Count-Min Sketch access history.

```typescript
hotKeys(n = 10): Array<{ key: string; hits: number; sizeBytes: number }>
```

### `cache.getWTinyLfuStats()`
Returns real-time capacity and hit counters for the Window TinyLFU admission policy.

```typescript
getWTinyLfuStats(): WTinyLfuStats | undefined
```

---

## 5. Cache Management, Warmup & Snapshots

### `cache.ready()`
Returns a promise that resolves once the Redis backplane is established, cold-start snapshots have hydrated, and initial `warmKeys` have populated.

```typescript
ready(): Promise<void>
```

### `cache.warmFromL2(pattern, opts?)`
Pre-warms L1 RAM by scanning and streaming keys matching a Redis glob pattern (e.g. `'catalog:*'`).

```typescript
async warmFromL2(
  pattern: string,
  opts?: { priority?: CachePriority }
): Promise<number>
```

### `cache.drainToL2()`
Asynchronously flushes all dirty in-memory L1 entries to Redis.

```typescript
async drainToL2(): Promise<number>
```

### `cache.clear(prefix?)`
Evicts all entries across L1, disk, and L2 matching a prefix pattern (or the entire namespace if omitted).

```typescript
async clear(prefix?: string): Promise<void>
```

### `cache.rebalance()`
Re-evaluates and evicts entries exceeding per-category memory limits (`categoryLimits`).

```typescript
rebalance(): number
```

### `cache.flushSnapshotOnShutdown(timeoutMs?)`
Flushes L1 RAM to local disk and uploads an encrypted snapshot to cloud storage (S3/R2) before container termination.

```typescript
async flushSnapshotOnShutdown(timeoutMs = 8000): Promise<boolean>
```

---

## 6. Internals, Security & Telemetry

### `cache.rotateEncryptionKey(newKeyBase64, newMode?)`
Rotates the active encryption key in-flight with zero downtime. Subsequent writes use the new key, while reads seamlessly fall back to `previousEncryptionKey`.

```typescript
async rotateEncryptionKey(
  newKeyBase64: string,
  newMode?: EncryptionMode
): Promise<void>
```

### `cache.health()`
Evaluates degradation, circuit breaker status, disk pressure, and Redis connectivity. Designed specifically for Kubernetes `/ready` probes.

```typescript
health(): CacheHealthStatus
```

### `cache.metrics()`
Returns an immutable snapshot of all counters, hit rates, memory sizes, and circuit breaker states.

```typescript
metrics(): CacheMetrics
```

### `cache.ping()`
Measures round-trip latency across all active tiers in milliseconds.

```typescript
async ping(): Promise<{ l1: number; disk: number; l2: number | null }>
```

### `CacheService.toPrometheusText(metrics, prefix?, instanceName?)`
Serializes runtime metrics into standard Prometheus exposition format.

```typescript
static toPrometheusText(
  m: CacheMetrics,
  prefix?: string,
  instanceName?: string
): string
```

### Operational Telemetry Callbacks
To guarantee zero GC allocation and avoid the listener leak hazards of `EventEmitter` under million-ops/sec load, `CacheService` exposes direct lifecycle callback hooks in `CacheOptions`:

* **`onHit: (key: string, tier: 'l1' | 'disk' | 'l2') => void`**: Invoked on every successful cache read.
* **`onMiss: (key: string) => void`**: Invoked when a key is exhausted across all tiers.
* **`onEviction: (key: string, reason: EvictionReason) => void`**: Invoked when an L1 entry is evicted (`'capacity'`, `'category'`, or `'rebalance'`).
* **`onMetrics: (metrics: CacheMetrics) => void`**: Periodic snapshot emission (controlled by `metricsIntervalMs`).

### Failure Handling & Error Modes
TriCache is architected to prioritize service availability through graceful local degradation:

* **Lock Acquisition Failure**: `cache.lock()` throws standard `Error` (`Failed to acquire lock for resource "<key>" within <ms>ms`) if the mutex cannot be acquired within the `acquireTimeout` deadline.
* **L2 Circuit Breaker**: When Redis connectivity fails or commands time out (`redisCommandTimeoutMs`), the circuit breaker transitions from `closed` to `open`. All reads and writes seamlessly degrade to local L1 RAM and L1.5 disk without throwing exceptions to application callers.
* **Rate-Limiter Failure Mode**: If Redis fails during `cache.increment()`, it returns `0` (fail-open) by default to prevent blocking end-users. Set `failClosed: true` to instead re-throw the underlying network error.
* **At-Rest Key Validation**: If an invalid encryption key length is provided, TriCache logs a warning and stores data unencrypted by default. Set `strictKeyValidation: true` to force the constructor to throw immediately.
* **Singleton Conflicts**: If multiple modules call `CacheService.create()` with conflicting options, TriCache warns once and preserves the existing singleton. Set `strictSingleton: true` to force conflicting initializations to throw.

---

## 7. Configuration Schema (`CacheOptions`)

Complete schema of options passed to `CacheService.create(options)`:

| Option | Type | Default | Description |
|:---|:---|:---|:---|
| **L1 (Memory)** | | | |
| `l1MaxBytes` | `number` | `200 MB` | Maximum heap allocated to L1 RAM |
| `l1MaxEntries` | `number` | `2000` | Maximum item count in L1 |
| `l1EvictionWatermark` | `number` | `0.9` (90%) | Proactive eviction threshold fraction |
| `l1AdmissionPolicy` | `'wtinylfu' \| 'adaptive'` | `'wtinylfu'` | Cache admission algorithm |
| `categoryLimits` | `Record<string, CategoryLimit>` | `{}` | Per-prefix capacity limits |
| `cloneStrategy` | `'none' \| 'structuredClone'` | `'none'` | Read safety: deep-clone values on return |
| `frozen` | `boolean` | `false` | `Object.freeze()` on L1 hit in dev mode |
| **L1.5 (Disk Tier)** | | | |
| `disableDisk` | `boolean` | auto | Disables disk tier (auto-detected in serverless) |
| `diskCacheDir` | `string` | `/dev/shm` / tmp | Filesystem path for off-heap disk files |
| `diskMaxBytes` | `number` | `500 MB` | Total disk quota before pruning |
| `diskLatencyWatchdog` | `boolean` | `true` | Graduated latency watchdog comparing disk vs Redis |
| `failReadinessOnDegraded` | `boolean` | `false` | Return `healthy: false` when degraded (for `/ready`) |
| **L2 (Redis / Valkey)** | | | |
| `redisHost` | `string` | `'127.0.0.1'` | Redis host (falls back to `REDIS_HOST`) |
| `redisPort` | `number` | `6379` | Redis port |
| `redisTls` | `boolean` | `true` in prod | Enables TLS connection |
| `redisProtocol` | `2 \| 3` | `3` (RESP3) | Redis wire protocol version |
| `redisClusterNodes` | `Array<{host, port}>` | `undefined` | Redis Cluster node endpoints |
| `redisSentinel` | `{name, sentinels}` | `undefined` | Redis Sentinel configuration |
| `useShardedPubSub` | `boolean` | `false` | Redis 7+ shard-bound pub/sub routing |
| `redisClient` | `IRedisDriver` | `undefined` | Pluggable `@redis/client` or custom driver |
| `backplaneMode` | `'pubsub' \| 'stream'` | `'pubsub'` | Cluster invalidation transport |
| **Security & Workers** | | | |
| `encryptionKey` | `string` | `undefined` | 32-byte base64 AES-256 key |
| `encryptionMode` | `'aes-256-gcm' \| 'aes-128-gcm' \| 'aes-128-ctr' \| 'xor'` | `'aes-256-gcm'` | Cryptographic cipher |
| `previousEncryptionKey` | `string` | `undefined` | Fallback key for zero-downtime key rotation |
| `workerThreads` | `boolean` | `false` | Offloads crypto & compression to worker pool |
| `workerThresholdBytes`| `number` | `131072` (128KB)| Payload size threshold for worker delegation |
| `compression` | `'zstd' \| 'lz4' \| 'brotli' \| 'gzip' \| 'none'`| `'zstd'` | Transparent payload compression (Zstandard via WebAssembly, LZ4, Brotli, Gzip) |
| `compressionThresholdBytes`| `number` | `1024` (1 KB) | Minimum byte size threshold before compression is applied |
| `customCompressor` | `CustomCompressor` | `undefined` | Pluggable custom compressor engine (`{ name, compress, decompress }`) |
| **Fleet Resilience** | | | |
| `namespace` | `string` | `''` | Cluster tenant key prefix |
| `tagStrategy` | `'set' \| 'generational'` | `'generational'` | $O(1)$ generational tag versioning |
| `hierarchicalTags` | `boolean` | `false` | Automatically expand tags into ancestor namespaces (e.g. `'org:1:dept:2'` $\rightarrow$ `'org'`, `'org:1'`, `'org:1:dept'`) |
| `tagHierarchyDelimiter` | `string` | `':'` | Separator used for splitting hierarchical tags |
| `ttlJitterFactor` | `number` | `0.0` | Randomize TTL by $\pm \text{factor} \times \text{ttl}$ |
| `adaptiveTtl` | `boolean` | `false` | Autonomous p95 fetch latency TTL tuning |
| `autoPipeline` | `boolean` | `false` | Zero-latency microtask Redis command batching |
| `maxPipelineBatchSize` | `number` | `100` | Immediate flush batch size threshold |
| `awaitInvalidationBackplane` | `boolean` | `false` | Await backplane broadcast on mutations (`set`, `delete`, `clear`, `invalidateTag`) |
| `lockFailClosed` | `boolean` | `false` | Fails closed (throws) on Redis errors during `cache.lock()` (prevents split-brain) |
| `enableIpc` | `boolean` | `false` | Enables local IPC bridge for `tricache top` |
| `ipcSocketPath` | `string` | `undefined` | Custom Unix domain socket or Windows named pipe |
| `crossRegion` | `CrossRegionRelayOptions` | `undefined` | Multi-cluster cross-region invalidation relay |
| `remoteSnapshot` | `RemoteSnapshotOptions` | `undefined` | S3 / Cloudflare R2 snapshot persistence |

---

## 8. Environment Variables

The TriCache engine honors the following environment variables across all environments:

| Environment Variable | Target System | Description |
|:---|:---|:---|
| `REDIS_HOST` | Redis L2 Connection | Default Redis server hostname when `redisHost` option is not passed. |
| `CACHE_ENCRYPTION_KEY` | At-Rest Security | Default base64-encoded 32-byte AES-256-GCM encryption key. |
| `NODE_ENV` | Environment Detection | When `!== 'production'`, Redis and TLS default to disabled for zero-config local dev. |
| `AWS_ACCESS_KEY_ID` | Cloud Snapshot | AWS IAM credential for SigV4 S3 snapshot hydration. |
| `AWS_SECRET_ACCESS_KEY` | Cloud Snapshot | AWS IAM secret key for SigV4 S3 snapshot hydration. |
| `AWS_SESSION_TOKEN` | Cloud Snapshot | Optional temporary AWS STS token for IAM role-based authentication. |
| `DASHBOARD_PASSWORD` | Observability Web UI | Basic authentication password for the embedded SSE admin dashboard. |
| `MANAGEMENT_SECRET` | Cluster CLI & RPC | Bearer token authenticating remote CLI management commands. |
| `POD_NAME` / `HOSTNAME` | Fleet Diagnostics | Container identifier tagged in Prometheus metrics and cluster logs. |

---

## 9. HTTP & Framework Middlewares (`tricache/http`, `tricache/hono` & `tricache/edge`)

### `createExpressMiddleware(cache, options?)`
Creates an Express/Connect route middleware with deterministic query sorting, weak ETag calculation, and RFC 7232 `304 Not Modified` short-circuiting.

```typescript
import { createExpressMiddleware } from 'tricache/http';

app.get('/api/users', createExpressMiddleware(cache, {
  ttlSeconds: 300,
  headerWhitelist: ['accept-language'],
}), handler);
```

### `createFastifyPlugin(cache, options?)`
Creates an encapsulation-safe Fastify plugin (`[Symbol.for('skip-override')] = true`) intercepting requests early in `onRequest` and caching responses in `onSend`.

```typescript
import { createFastifyPlugin } from 'tricache/http';

await fastify.register(createFastifyPlugin(cache, { ttlSeconds: 120 }));
```

### `cacheMiddleware(options?)` (`tricache/hono`)
Creates Node Hono middleware on `CacheService` with Express-aligned ttl/tags/SWR, weak ETags, and RFC 7232 `304 Not Modified`. Non-2xx responses are not cached.

```typescript
import { cacheMiddleware } from 'tricache/hono';

app.get('/api/posts', cacheMiddleware({ ttl: 300, tags: ['posts'] }), (c) => {
  return c.json({ data: '...' });
});
```

### `createHonoEdgeMiddleware(edgeCache, options?)`
Creates a decoupled Hono edge middleware using pure Web Standards (`Request`, `Response`, `crypto.subtle`) with zero Node native dependencies.

```typescript
import { createHonoEdgeMiddleware } from 'tricache/edge';

app.get('/api/items', createHonoEdgeMiddleware(edgeCache, { ttlSeconds: 180 }), handler);
```

---

## 10. IPC Telemetry Bridge (`tricache/ipc`)

### `IpcTelemetryServer`
Lightweight, non-blocking IPC server running on Unix domain sockets or Windows Named Pipes that exposes metrics snapshots to external CLI monitors.

```typescript
import { IpcTelemetryServer } from 'tricache';

const server = new IpcTelemetryServer(cache);
await server.start();
// Automatically binds SIGINT / SIGTERM / exit cleanup hooks
await server.close();
```

### `IpcTelemetryClient`
Connects to a running TriCache process over IPC to retrieve live metrics or measure latency.

```typescript
import { IpcTelemetryClient } from 'tricache';

const client = new IpcTelemetryClient();
const metrics = await client.getMetrics();
const latencyMs = await client.ping();
```

### `resolveIpcSocketPath(id?)`
Resolves platform-agnostic socket/pipe paths:
* POSIX (`linux`, `darwin`): `/tmp/tricache-<id>.sock` (or `$TMPDIR/...`)
* Windows (`win32`): `\\.\pipe\tricache-<id>`

