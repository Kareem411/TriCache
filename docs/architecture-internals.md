# TriCache — Deep Architecture & Systems Internals

> **Systems Engineering Reference**: Mathematical formulations, low-latency algorithms, hardware-aware optimizations, and cryptographic wire specifications.

---

## 1. Native Window TinyLFU (W-TinyLFU) Admission Engine

TriCache includes a native implementation of the state-of-the-art **Window TinyLFU** cache architecture popularized by Java's Caffeine:

![Native Window TinyLFU Admission Policy](/docs/Cache_admission_policy_diagram_20260910183710.jpeg)

::: details Text Specification & ASCII Flow
```
                           [Incoming Entry]
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │    Window Cache (LRU)     │  ~1% of Total Capacity
                    │  (Absorbs Burst Recency)  │
                    └─────────────┬─────────────┘
                                  │ Evicted from Window
                                  ▼
                         [TinyLFU Admission]
                      Freq(Candidate) > Freq(Victim)?
                                  │
                  ┌───────────────┴───────────────┐
                  │ YES                           │ NO
                  ▼                               ▼
       ┌──────────────────────┐             [Drop Candidate]
       │  Probationary SLRU   │  ~20% of Main
       └──────────┬───────────┘
                  │ On 2nd Hit
                  ▼
       ┌──────────────────────┐
       │    Protected SLRU    │  ~80% of Main
       └──────────────────────┘
```
:::

### Architectural Properties:
1. **Burst Recency Absorption**: Short-lived temporal spikes hit in the Window LRU (~1% capacity) without displacing long-resident items in the main cache.
2. **Frequency-Biased Admission**: When the Window overflows, its victim competes against the Probationary SLRU victim in a 4-row Count-Min Sketch. The entry with the higher historical frequency is admitted.
3. **Mathematical Scan Resistance**: Large sequential scans (e.g. table dumps or database crawls) are immediately dropped by the TinyLFU admission gate with **>90% rejection rates**, maintaining 100% hit retention for resident hot items.

---

## 2. Count-Min Sketch (CMS) Frequency Estimation

To remember entry access frequencies across eviction boundaries, TriCache uses a space-efficient Count-Min Sketch:
* **Dimensions**: 4 rows $\times$ 512 columns (`Uint16Array`), requiring exactly **4 KB of RAM** (fits entirely within CPU L1d cache).
* **Hashing**: 4 independent bit-mixes derived from a single 32-bit FNV-1a digest.
* **Periodic Halving Decay**: When total insertions cross `SKETCH_DECAY_THRESHOLD` (100,000), all counters are bit-shifted right (`>>= 1`), aging out old bursts and preventing stale keys from holding high frequency indefinitely.

```typescript [frequency-estimate.ts]
// Minimum-across-rows frequency estimate in ~300ns
estimate(key: string): number {
  const h  = this.fnv32(key);
  const h1 = (h  ^ (h  >>> 16)) >>> 0;
  const h2 = (Math.imul(h1, 0x45d9f3b)  ^ (h1 >>> 16)) >>> 0;
  const h3 = (Math.imul(h2, 0x7fb9b7a1) ^ (h2 >>> 16)) >>> 0;
  const h4 = (Math.imul(h3, 0x1b873593) ^ (h3 >>> 16)) >>> 0;
  const t  = this.table;
  return Math.min(
    t[h1 & SKETCH_MASK],
    t[SKETCH_WIDTH     + (h2 & SKETCH_MASK)],
    t[2 * SKETCH_WIDTH + (h3 & SKETCH_MASK)],
    t[3 * SKETCH_WIDTH + (h4 & SKETCH_MASK)],
  );
}
```

---

## 3. WebAssembly & Murmur3 Bloom Filters

TriCache defends against negative query penetration (e.g. 404 routes, bot crawlers) by placing a Bloom filter directly in front of the in-memory Map:
* **Guaranteed Miss Detection**: `mightContain(key) === false` guarantees the key is absent, skipping Map lookups entirely in **~140 nanoseconds**.
* **Inlined 562-Byte WebAssembly Binary**: Compiled without filesystem dependencies; decoded synchronously into WebAssembly instances.
* **Dynamic JS Fallback**: When $L_1$ entry ceiling exceeds the 10,400-entry capacity of the 100K-bit filter, TriCache automatically provisions an optimally sized pure-JS filter:
  $$m = \left\lceil \frac{-n \cdot \ln(p)}{(\ln 2)^2} \right\rceil, \quad k = \text{round}\left(\frac{m}{n} \cdot \ln 2\right)$$
* **MurmurHash3 Kirsch-Mitzenmacher**: Edge isolates use a double-hashing filter ($h_i(x) = h_1(x) + i \cdot h_2(x) \pmod m$) eliminating bit clustering.

---

## 4. Hardware-Aware V8 Optimizations & Memory Hygiene

### A. Zero-Allocation Hot Paths (Pre-allocated Pools)
During cache eviction, candidate sampling avoids creating temporary object literals. TriCache pre-allocates an eviction candidate pool (`_evictPool`) of 16 slots at construction and mutates their properties in-place, eliminating GC allocations during sustained write pressure.

### B. 32-Bit Register-Level CPU XOR Loops
The XOR cipher engine detects 4-byte buffer alignment. When aligned, it compiles the operation using `Uint32Array` views, allowing the V8 JIT compiler to execute 32-bit register-level `XOR` CPU instructions rather than byte-by-byte traversal:
```typescript [xor-word-path.ts]
// 32-bit word-level fast path (4 bytes per iteration)
const u32Data = new Uint32Array(buf.buffer, buf.byteOffset, words);
const u32Key  = new Uint32Array(keyBuf.buffer, keyBuf.byteOffset, keyWords);
for (let i = 0; i < words; i++) {
  u32Data[i] ^= u32Key[i % keyWords];
}
```

### C. `msgpackr` 2.1.0 Record Compression & DoS Defense
* **Record Structure Compression (`useRecords: true`)**: Replaces repeated JSON keys with compact binary type IDs, reducing serialized footprints by **~45%**.
* **DoS Memory Amplification Defense**: Rejects malformed `array32` or `map32` headers declaring lengths beyond buffer boundaries, eliminating $32,000,000\times$ allocation amplification attacks.

---

## 5. Wire Envelopes & Cryptographic Storage

All entries written to Redis ($L_2$) and the disk tier ($L_{1.5}$) use self-describing magic prefixes:

| Prefix / Magic Header | Mode | Description |
|---|---|---|
| `enc:v1:<base64>` | AES-256-GCM | Authenticated 32-byte AEAD envelope with 12-byte IV and 16-byte MAC tag |
| `a128:v1:<base64>` | AES-128-GCM | Authenticated 16-byte AEAD envelope (~15% faster on non-AES-NI hardware) |
| `ctr:v1:<base64>` | AES-128-CTR | Unauthenticated stream cipher (fastest, requires transport-level integrity) |
| `cmp:v1:<data>` | Compressed | Brotli or Gzip compressed payload |
| `ecp:v1:<data>` | Encrypted + Compressed | Compressed before encryption |
| `TRIC1ENC\|...` | Disk Tier V2/V3 | Binary disk envelope with CRC validation and owner-only (0o600) permissions |

---

## 6. Zero-Dependency AWS SigV4 Snapshot Signer

For stateless Kubernetes pods and Edge workers, TriCache implements a native **AWS SigV4 Request Signer** built entirely on Web Crypto (`crypto.subtle`) and `fetch`:
* **Zero SDK Overhead**: Eliminates the 30MB `@aws-sdk/client-s3` dependency.
* **HMAC Key Derivation**:
  $$\text{kDate} = \text{HMAC}(\text{"AWS4"} + \text{SecretKey}, \text{DateStamp})$$
  $$\text{kRegion} = \text{HMAC}(\text{kDate}, \text{Region})$$
  $$\text{kService} = \text{HMAC}(\text{kRegion}, \text{"s3"})$$
  $$\text{kSigning} = \text{HMAC}(\text{kService}, \text{"aws4\_request"})$$
* **Storage Compatibility**: Fully tested with AWS S3, Cloudflare R2, MinIO, and Google Cloud Storage S3-compatible endpoints.

---

## 7. Zero-Downtime Key Rotation & Ciphers

TriCache supports at-rest cryptographic isolation across Redis and disk tiers with live zero-downtime key rotation:

```typescript
// 1. Initial configuration with primary key and previous key fallback
const cache = CacheService.create({
  encryptionKey: process.env.NEW_KEY,
  previousEncryptionKey: process.env.OLD_KEY,
  strictKeyValidation: true, // Throws if key length is invalid (fail-closed)
});

// 2. Or trigger live rotation on active instances without restarts:
await cache.rotateEncryptionKey(newKeyBase64, 'aes-256-gcm');
```

### Supported Cryptographic Modes:
* **`aes-256-gcm` (Default)**: 32-byte key. Authenticated AEAD encryption with 12-byte IV and 16-byte authentication tag.
* **`aes-128-gcm`**: 16-byte key. ~15% faster on architectures without dedicated AES-NI acceleration.
* **`aes-128-ctr`**: 16-byte key. High-throughput stream cipher without MAC calculation (use when transport layer guarantees integrity).
* **`xor`**: 32-bit register-level obfuscation. Intended exclusively for development or non-sensitive data isolation.

---

## 8. Worker Thread Offloading & Event-Loop Preservation

Under high write concurrency, encrypting or compressing multi-megabyte payloads on the main JavaScript thread can cause V8 event-loop stalls, degrading HTTP API latency:

```typescript
const cache = CacheService.create({
  workerThreads: true,
  workerThresholdBytes: 131072, // 128 KB
  workerPoolSize: 4,            // Dedicates worker pool to crypto/compression
});
```

* **Threshold Delegation**: Payloads smaller than `workerThresholdBytes` are processed synchronously to avoid IPC messaging overhead.
* **Offloaded Heavy Loads**: Large payloads are transferred as `ArrayBuffer` instances to worker threads, executed off-heap, and returned with 0ms event-loop lag.

---

## 9. Read Safety: `cloneStrategy: 'structuredClone'` vs `'none'`

JavaScript in-memory caches that return direct object references are vulnerable to **reference pollution**: if application code mutates a returned object (e.g. `user.roles.push('admin')`), the cached entry in L1 is silently corrupted.

TriCache provides two explicit operational strategies:

```typescript
const cache = CacheService.create({
  cloneStrategy: 'structuredClone', // or 'none'
  frozen: process.env.NODE_ENV !== 'production', // Dev-mode deep freeze
});
```

* **`cloneStrategy: 'none'` (Default)**: Returns live in-memory references. Achieves maximum throughput (**2.81M ops/s / 356 ns**). Ideal for immutable domain data, primitive values, and React Server Component stream buffers.
* **`cloneStrategy: 'structuredClone'`**: Deep-clones objects using native V8 `structuredClone()` on L1 hits and L2 promotions. Guarantees 100% reference immutability at the cost of ~1.2µs per clone.
* **`frozen: true`**: When enabled in development, recursively freezes returned objects with `Object.freeze()`, immediately throwing a `TypeError` if caller code attempts to mutate cached references.

---

## 10. Autonomous Adaptive TTL & XFetch Early Expiration

Setting static cache TTLs across hundreds of database queries often leads to either over-caching stale data or under-caching slow queries:

```typescript
const cache = CacheService.create({
  adaptiveTtl: true,
  adaptiveTtlMultiplier: 20, // p95Ms * 20 = adapted TTL
  adaptiveTtlMin: 10,        // 10s floor
  adaptiveTtlMax: 86400,     // 24h ceiling
});
```

* **p95 Latency Ring Buffers**: TriCache maintains a 32-sample rolling ring buffer per key. Queries that take 2,000ms to compute are autonomously cached longer (e.g. 40s), while fast 2ms queries receive shorter TTLs.
* **XFetch Probabilistic Early Expiration**: Prevents cache stampedes by recomputing entries ahead of time with increasing probability as expiration approaches:
  $$\Delta \cdot \beta \cdot \ln(\text{rand}()) < t - t_{\text{expiry}}$$

---

## 11. Dual-Constrained Autonomous L1 Memory Sizing

When running in containerized environments (Kubernetes, AWS ECS, GCP Cloud Run), sizing L1 cache based solely on cgroup limits can trigger V8 heap OOM crashes if `--max-old-space-size` is smaller than container memory.

TriCache implements a dual-constrained sizing formula combining Linux cgroup v1/v2 limit detection with V8 runtime statistics:

$$\text{Target L1} = \max\left(16\text{ MB}, \min\left(\text{cgroupLimit} \times 0.40, \text{v8HeapLimit} \times 0.50, 512\text{ MB}\right)\right)$$

### Key Invariants:
* **Distroless Permission Trap Defense**: Wrapped inside safe `try/catch` defaulting to `Infinity` on `EACCES` or missing files in hardened non-root containers.
* **Heap Headroom Protection**: Caps L1 at 50% of `v8.getHeapStatistics().heap_size_limit`, preventing garbage collection thrashing.
* **Container Headroom Protection**: Caps L1 at 40% of cgroup capacity to leave ample room for OS page cache, native threads, and network buffers.

---

## 12. Zero-Latency Microtask Redis Auto-Pipelining

Traditional auto-batchers use timer intervals (`setTimeout(flush, 1)`) which introduce artificial latency penalties to high-throughput services.

TriCache implements zero-latency microtask pipelining via `queueMicrotask`:

```typescript
const cache = CacheService.create({
  autoPipeline: true,
  maxPipelineBatchSize: 100, // Immediate flush threshold
});
```

* **Tick Boundary Coalescing**: All concurrent operations initiated in the same synchronous JavaScript turn are batched into a single Redis pipeline call before I/O returns to the libuv poll phase.
* **Zero Timer Delay**: Microtasks fire immediately after synchronous execution, incurring **0.00ms artificial delay**.
* **High-Load Flushes**: If the queue fills to `maxPipelineBatchSize` before the tick ends, it flushes immediately.

---

## 13. Priority-Aware Partitioned Disk Tiering

To protect high-value entries from being evicted by high-volume transient data, TriCache uses priority-partitioned SQLite storage:

```typescript
// Critical entry protected from early eviction
await cache.set('auth:master-token', token, 86400, CachePriority.CRITICAL);

// Low-priority scraping query subject to aggressive pruning
await cache.set('feed:rss', feed, 300, CachePriority.LOW);
```

* **Composite Index**: Backed by `CREATE INDEX IF NOT EXISTS idx_priority_access ON meta (priority ASC, last_accessed_at ASC);`
* **Watermark Pruning**: When disk usage exceeds high watermarks, TriCache evicts `LOW` and `NORMAL` entries first based on LRU access time, preserving `HIGH` and `CRITICAL` entries.

---

## 14. Asymmetric Key Envelope Encryption (`TRICENV1`)

For zero-trust multi-cloud deployments and compliance with SOC2/PCI-DSS, TriCache provides asymmetric envelope encryption (`EnvelopeEncryption`) for cold-start and remote snapshots:

```typescript
import { EnvelopeEncryption } from 'tricache';

const envelope = new EnvelopeEncryption({
  publicKey: rsaPublicKeyPem, // For encrypting ephemeral DEKs
  privateKey: rsaPrivateKeyPem, // For decrypting DEKs on hydration
});
```

### Binary Header Specification (`TRICENV1`):
```
┌──────────────┬──────────────┬──────────────────┬──────────────┬──────────────┬──────────────┐
│ Magic Header │ Key Len (BE) │ Encrypted DEK    │ GCM IV       │ Auth Tag     │ Ciphertext   │
│ 8 bytes      │ 4 bytes (u32)│ Variable length  │ 12 bytes     │ 16 bytes     │ N bytes      │
│ "TRICENV1"   │ e.g. 256/512 │ (RSA-OAEP 256)   │ (random)     │ (AES-GCM)    │ (Payload)    │
└──────────────┴──────────────┴──────────────────┴──────────────┴──────────────┴──────────────┘
```

* **Tamper Rejection**: Any alteration to the header, IV, tag, or encrypted DEK fails authentication before memory allocation.
* **KMS Extensibility**: Supports custom `kmsWrapKey` and `kmsUnwrapKey` hooks for direct integration with AWS KMS, Google Cloud KMS, or HashiCorp Vault.

---

## 15. Differential Multi-Tier Waterfall Resolution (`cache.mget`)

Most caching systems implement batch lookups as naive loops over single-key `get()` calls, or limit batching to a single remote tier (`MGET` in Redis). TriCache implements a **differential waterfall resolution engine** that cascades through heterogeneous local and remote tiers, querying downstream tiers and origin databases **only for the differential remainder of unresolved keys**.

```
                   keys: [k1, k2, k3, k4, k5]
                               │
            ┌──────────────────▼──────────────────┐
            │   Tier 1: In-Memory L1 Scan (RAM)   │ ── Warm hits (0 I/O) ──> [k1]
            └──────────────────┬──────────────────┘
                               │ Misses: [k2, k3, k4, k5]
            ┌──────────────────▼──────────────────┐
            │  Tier 2: Redis Pipelined MULTI/GET  │ ── Remote hits ────────> [k2, k4]
            │     (Single Network Round-Trip)     │    (Promoted to L1)
            └──────────────────┬──────────────────┘
                               │ Misses: [k3, k5]
            ┌──────────────────▼──────────────────┐
            │ Tier 1.5: Off-Heap /dev/shm & NVMe  │ ── Disk spill hits ────> [k3]
            │   (Tombstone & Canary Protected)    │    (Promoted to L1)
            └──────────────────┬──────────────────┘
                               │ Misses: [k5]
            ┌──────────────────▼──────────────────┐
            │   Tier 3: fetchFn(missKeys) Origin  │ ── Origin hit ─────────> [k5]
            │   (Only True Remainder Passed to DB)│    (Backfilled to L1/L2)
            └──────────────────┬──────────────────┘
                               │
            ┌──────────────────▼──────────────────┐
            │   Deterministic Ordered Results     │
            │      [val1, val2, val3, val4, val5] │
            └─────────────────────────────────────┘
```

### Cascading Execution Lifecycle:
1. **Zero-Overhead L1 Scan**:
   Keys are evaluated against resident V8 memory in a single synchronous pass. Warm hits return references directly, bypassing string serialization and network I/O.
2. **Pipelined L2 Batching**:
   Any keys missing from L1 are batched into a single Redis `client.multi().get(...)` pipeline. Hits are decrypted, deserialized, promoted into L1 with jittered TTL, and recorded to the latency watchdog.
3. **Off-Heap Disk Spill (Tier 1.5)**:
   For remaining unfulfilled keys, TriCache checks SQLite `/dev/shm` or NVMe storage. To prevent resurrection races, this lookup is guarded by:
   - Synchronous delete tombstones (`_pendingDiskDeletes`)
   - Wildcard pattern tombstones (`_patternTombstones`)
   - Hardware canary latency checks via the `LatencyWatchdog`
4. **Selective Origin Batch Execution (`fetchFn`)**:
   Origin systems (PostgreSQL, Aurora, REST APIs) are invoked **only** with the true remainder (`missKeys`). For example, in a batch of 50 keys where 45 are warm across L1/L2, `fetchFn` receives an array of exactly 5 keys.
   - `fetchFn` may return either a `Record<string, T>` or a `Map<string, T>`.
5. **Deterministic Order & Concurrent Backfill**:
   The returned array `(T | undefined)[]` strictly preserves the original index ordering (`result[i]` corresponds to `keys[i]`). Newly fetched values are concurrently backfilled across tiers using `Promise.all` with optional dynamic per-key TTLs `(key: string) => number`.



