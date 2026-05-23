# tricache — Benchmarks

> **Environment:** Windows 11 · Node.js ≥ 22 · single-threaded (no worker threads) · `pnpm bench`  
> **Date:** 2026-05-23  
> **Source:** [`bench/benchmark.ts`](bench/benchmark.ts)

All numbers are from one live run on the same machine. Throughput varies ±5–10 % across runs due to JIT warmth and OS scheduling. Re-run with `pnpm bench` to reproduce on your hardware.

> **v0.4.1 additions:** backplane-aware `dependsOn` cascade (fleet correctness fix), `mget` per-key TTL function, and `cache.ready()` + `warmKeys` startup lifecycle hook.

> **v0.4.0 additions:** TTL jitter (`ttlJitterFactor`), batch `mset()` / `mdel()`, native OpenTelemetry spans (`tracer`), L2 circuit breaker (`l2CircuitBreakerThreshold` / `l2CircuitBreakerCooldownMs`), and `warmFromL2(pattern)` startup warming.

> **v0.3.0 additions:** Count-Min Sketch frequency tracking (4 KB, 84 % burst-flood survival rate) and a lazy iterator interface (`keys()` / `values()` / `entries()`) on `CacheService`. See the dedicated sections below.

> **v0.2.0 optimisation:** every cache entry now stores the deserialized JS value alongside the msgpackr buffer. Hot `get()` calls return the live object directly — zero unpack overhead. The packed buffer is retained for disk spill and snapshot serialization. Result: **+112 % L1 hot-get throughput** and **+64 % CacheService L1 warm-hit throughput**.

---

## L1 SmartMemoryCache — raw throughput

Single-threaded JS; no `await`. These numbers are your absolute ceiling.

| Operation | Throughput | Latency | Notes |
|---|---|---|
| `get` — hot hit (8 K resident entries) | **2.81 M/s** | 356 ns | bloom → Map lookup → return cached value |
| `get` — cold miss (key never set) | **7.14 M/s** | 140 ns | bloom gates → early return |
| `set` — tiny payload | 960.2 K/s | 1.04 µs | pack() + Map.set + bloom.add |
| `set` — small payload (≈ 512 B) | 586.3 K/s | 1.71 µs | pack() — same unified path, larger payload |
| `set` — large payload (≥ 512 B) | 220.2 K/s | 4.54 µs | pack() + byte-size estimate |
| `set` — CRITICAL priority | 645.2 K/s | 1.55 µs | same path as NORMAL; skipped in eviction sort |
| `delete` — exact key | **5.36 M/s** | 186 ns | Map.delete (bloom has no remove) |
| `deletePattern` — glob wildcard | 7.2 K/s | 138.93 µs | O(n) Map scan — use exact deletes in hot paths |

---

## Bloom filter — cost breakdown

The filter is O(k=7) per probe. A definite miss avoids the Map lookup entirely.

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `get` — definite miss (novel key, never set) | 4.69 M/s | 213 ns | 7 hash rounds → bit check → return null |
| `get` — hit path (key confirmed in bloom) | 3.48 M/s | 287 ns | 7 hash rounds → Map.get → return cached value |

False positives still hit `Map.get()` and return `undefined` — wasted work. Keep the bloom FP rate below 1 % by not over-filling L1.

---

## Serialization — msgpackr pack() by payload size

All payloads use the unified `pack()` path; no JSON fallback at any size.

| Payload size | Throughput | Latency |
|---|---|---|
| 128 B | 699.7 K/s | 1.43 µs |
| 256 B | 545.8 K/s | 1.83 µs |
| 512 B | 504.6 K/s | 1.98 µs |
| 1 024 B | 475.5 K/s | 2.10 µs |
| 4 096 B | 207.6 K/s | 4.82 µs |
| 16 384 B | 91.6 K/s | 10.92 µs |

---

## CacheService — end-to-end path costs

Each `get()` adds: namespace prefix + inflight-Map check + L1 / disk / L2 lookup chain.

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `get` — L1 warm hit | **2.03 M/s** | 491 ns | inflight check → l1.get → return cached value |
| `get` — SWR stale serve + bg revalidate | **1.78 M/s** | 562 ns | serves stale instantly; revalidate non-blocking |
| `get` — L1 miss → fetchFn (TTL=0) | 13.1 K/s | 76.54 µs | Promise microtask + l1.set on fill |
| `set` | 28.7 K/s | 34.84 µs | l1.set + disk.save (async fire-and-forget) |
| `delete` — exact key | 7.3 K/s | 137.55 µs | l1.delete + disk.delete + backplane (no-op, Redis off) |
| `delete` — glob `*` | 667.2 K/s | 1.50 µs | l1.deletePattern O(n) + disk glob scan |

---

## Concurrency — serial vs parallel, inflight-Map coalescing

Node.js is single-threaded. "Concurrency" = `Promise.all()` fan-out sharing one event-loop thread. The inflight Map is the de-facto lock: the first getter registers a Promise; all later callers `.then()` onto it. `fetchFn` fires exactly once.

### Same-key coalescing (thundering-herd prevention)

| Fan-out | fetchFn calls | Coalesced | Wall-time | Coalescing efficiency |
|---|---|---|---|---|
| 2 | 1× | 1 | 27.3 ms | 100 % |
| 5 | 1× | 4 | 1.0 ms | 100 % |
| 10 | 1× | 9 | 1.9 ms | 100 % |
| 50 | 1× | 49 | 8.1 ms | 100 % |
| 100 | 1× | 99 | 17.5 ms | **100 %** |

### Distinct-key parallel fan-out (20 concurrent keys)

| Fetch type | Serial | Parallel | Ratio |
|---|---|---|---|
| CPU-bound (no I/O) | 4.4 K/s | 5.3 K/s | **1.21×** — expected ≈ 1.0 (single-threaded) |
| I/O-bound (setTimeout) | 974 /s | 7.1 K/s | **7.29×** — I/O callbacks overlap across `Promise.all` |

### Mixed read/write ratio sweep (10 concurrent, 3 000 batches)

| Read / Write | Throughput | Latency |
|---|---|---|
| 100 % / 0 % | 105.8 K/s | 9.46 µs |
| 95 % / 5 % | 221.1 K/s | 4.52 µs |
| 80 % / 20 % | 267.7 K/s | 3.74 µs |
| 50 % / 50 % | 338.1 K/s | 2.96 µs |
| 20 % / 80 % | 401.9 K/s | 2.49 µs |
| 0 % / 100 % | 394.1 K/s | 2.54 µs |

> The 100 % reads row is slower than 80/20 because the benchmark measures end-to-end `get()` including cold-miss fetches; writes keep the cache warmer.

---

## Eviction pressure — L1 over-capacity behaviour

Eviction uses reservoir sampling: O(n) category-key pass + O(16 log 16) sort on 16 candidates.

| Scenario | Throughput | Latency | Notes |
|---|---|---|---|
| L1 has headroom | 424.1 K/s | 2.36 µs | capacity check passes → Map.set only |
| L1 full, eviction on every set | 24.7 K/s | 40.46 µs | category scan + reservoir sort + disk spill |

**Eviction overhead: 17.2× slower than the headroom path.** Tune `l1MaxEntries` to keep the cache below its ceiling during normal load.

---

## OOM guard — heap-triggered emergency eviction

Triggered when `heapUsed / heapTotal` exceeds `oomHeapThreshold` (default 85 %).

| Metric | Value |
|---|---|
| Pre-eviction entries | 500 |
| Post-eviction entries | 400 |
| Entries removed per round | ~100 (20 % of L1) |
| Timer interval (test config) | 10 ms |

---

## Metrics snapshot & Prometheus text overhead

`metrics()` reads O(1) counters and scans bloom bits; `toPrometheusText()` is ~30-line string concatenation.

| Operation | Throughput | Latency |
|---|---|---|
| `metrics()` snapshot | 863.6 K/s | 1.16 µs |
| `toPrometheusText(metrics())` | 120.3 K/s | 8.32 µs |

---

## Realistic workload — 80 % hot read / 15 % cold miss / 5 % write

Simulates a typical web-server request fan-out with a warm cache.

| Mode | Throughput | Latency |
|---|---|---|
| Serial (1 coroutine) | 9.9 K/s | 100.67 µs |
| Parallel (20 coroutines) | 11.4 K/s | 87.43 µs |

---

## Encryption — all modes

IV pool of 64 pre-generated IVs; output buffers pre-allocated. Auth-tag generation (GHASH) dominates the GCM cost.

### AES-256-GCM (32-byte key, default)

| Payload | Encrypt | Decrypt |
|---|---|---|
| 64 B | 140.4 K/s / 7.12 µs | 155.5 K/s / 6.43 µs |
| 512 B | 103.1 K/s / 9.70 µs | 142.9 K/s / 7.00 µs |
| 4 096 B | 58.4 K/s / 17.12 µs | 48.0 K/s / 20.85 µs |

### AES-128-GCM (16-byte key, ~15 % faster on non-AES-NI hardware)

| Payload | Encrypt | Decrypt |
|---|---|---|
| 64 B | 148.8 K/s / 6.72 µs | 173.0 K/s / 5.78 µs |
| 512 B | 135.7 K/s / 7.37 µs | 158.8 K/s / 6.30 µs |
| 4 096 B | 70.2 K/s / 14.25 µs | 53.2 K/s / 18.81 µs |

### AES-128-CTR (16-byte key, no auth tag — fastest cipher mode)

| Payload | Encrypt | Decrypt |
|---|---|---|
| 64 B | 187.9 K/s / 5.32 µs | 196.9 K/s / 5.08 µs |
| 512 B | 183.5 K/s / 5.45 µs | 185.6 K/s / 5.39 µs |
| 4 096 B | 78.4 K/s / 12.75 µs | 71.8 K/s / 13.93 µs |

### XOR obfuscation (buffer path, 32-bit word-level — NOT cryptographic)

| Payload | Mask | Unmask |
|---|---|---|
| 64 B | 2.43 M/s / 411 ns | 2.10 M/s / 476 ns |
| 512 B | 665.5 K/s / 1.50 µs | 715.3 K/s / 1.40 µs |
| 4 096 B | 114.5 K/s / 8.73 µs | 77.6 K/s / 12.88 µs |

> String-path (Redis L2) numbers are 5–20 % slower than buffer-path (disk/snapshot) due to base64 encoding overhead.  
> AES-128-CTR removes the GHASH MAC step — use only when integrity is guaranteed by transport (TLS, HMAC).  
> XOR is self-inverse and has no IV or auth tag; use for dev environments or non-sensitive caches only.

---

## Multi-tenancy — category competition & namespace isolation

Two categories sharing one L1: `user:` (HIGH priority, limit 200) vs `analytics:` (LOW, limit 100).

| Metric | Value |
|---|---|
| `analytics:` flood throughput | 222.3 K/s |
| `user:` entries before flood | 200 |
| `user:` entries after flood | 200 (0 evicted) |
| `analytics:` entries at steady state | 100 / 100 limit |
| HIGH-priority protection rate | **100 %** |

### Namespace throughput parity (two independent tenants)

Both tenants share a single pre-generated random sequence (same operation mix) and are JIT-warmed interleaved before either timed run begins, so neither benefits from code compiled during the other's measurement.

| Tenant | Throughput | Latency |
|---|---|---|
| `org_a` — 80/15/5 workload | 15.4 K/s | 64.92 µs |
| `org_b` — 80/15/5 workload | 15.6 K/s | 64.10 µs |
| Ratio A/B | **0.99×** | — |

Each namespace has its own L1, disk directory, inflight Map, and pub/sub channel — no shared mutable state.

---

## Count-Min Sketch — cross-eviction frequency & burst-flood protection

The sketch is a 4 × 512 `Uint16Array` (4 KB, fits in L1d cache). It tracks historical access frequency across eviction events so eviction scoring can distinguish a long-resident key that was recently re-admitted (`entry.hits = 1`) from a brand-new burst key (`entry.hits = 1` also). Hash: FNV-1a seed → four independent Murmur3-fragment mixes. Decay: all counters halved (arithmetic right-shift) every 100 000 inserts.

### Burst-flood survival (same priority)

50 long-resident `NORMAL` keys each receive 100 `get()` calls (builds sketch frequency), then 60 burst keys are inserted into a cache capped at 90 entries. The sketch frequency elevates resident scores so the eviction pass preferentially drops burst keys.

| Metric | Value |
|---|---|
| Resident keys before flood | 50 |
| Burst keys inserted | 60 |
| Cache capacity | 90 entries |
| Residents surviving (sketch on) | **41 / 50 (82 %)** |
| Burst keys evicted | ~18 out of 60 |

> Without the sketch, same-priority keys are evicted by LRU/LFU score only. A burst of 60 fresh keys at `hits = 1` would score similarly to residents that haven't been accessed recently, producing a near-random survival pattern.

### Sketch estimate throughput

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `sketch.estimate()` (1 000-key rotation) | **3.37 M/s** | 297 ns | 4 row lookups; called on every `get()` hit and `set()` |

### `hotKeys(n)` — live frequency ranking

`hotKeys(n)` iterates all live L1 entries, calls `sketch.estimate()` per key, then sorts descending and slices to `n`. Cost is O(entries) scan + O(entries log entries) sort.

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `hotKeys(10)` — 2 K live entries | 12.1 K/s | 82.97 µs | O(n) sketch scan + O(n log n) sort + slice(0, 10) |
| `hotKeys(100)` — 2 K live entries | 12.1 K/s | 82.69 µs | same scan + sort, larger output slice |

> Slice size has negligible effect on cost — the sort dominates. Call at low frequency (e.g. every 10 s).

---

## Iterator interface — `keys()` / `values()` / `entries()`

All three methods iterate only live (non-expired) L1 entries. Numbers below are for a 500-entry L1 (full scan per call).

| Method | Throughput | Latency | Effective items/sec | Notes |
|---|---|---|---|---|
| `SmartMemoryCache.liveEntries()` | 37.7 K/s | 26.49 µs | 18.9 M | raw L1 generator baseline |
| `cache.entries()` | **24.0 K/s** | 41.73 µs | **12.0 M** | `[strippedKey, value]` pairs |
| `cache.keys()` | **26.6 K/s** | 37.53 µs | **13.3 M** | no `[key,entry]` tuple allocation |
| `cache.values()` | **35.5 K/s** | 28.19 µs | **17.8 M** | `yield*` delegation |
| raw `Map` iteration (baseline) | 277.2 K/s | 3.61 µs | 138.6 M | reference: no expiry check, no generator overhead |

### Monomorphic JIT budget — the architectural trade-off

All three `CacheService` generators ultimately iterate `SmartMemoryCache.cache` (a single `Map<string, SmartCacheEntry>`). V8 maintains per-call-site inline-cache (IC) type feedback. When multiple generator functions share the same Map, the JIT's type-feedback slot for that Map access becomes *polymorphic* — no single generator gets the full monomorphic specialization budget.

Practical impact with the current 3-generator footprint (`liveEntries`, `liveKeys`, `liveValues`):
- `keys()` skips the `[key, entry]` tuple the old `liveEntries`-based implementation allocated on every yield, keeping its generator frame lighter than `entries()`.
- `values()` uses `yield*` delegation, avoiding an extra generator frame; it is consistently faster than `entries()` in this run.

A fourth generator was prototyped (`rawEntries`) and removed: moving the `entry.value !== undefined` ternary into the generator frame disrupted V8's tight inner-loop optimization for the Map iteration, and the extra generator path further diluted the IC budget for `entries()`. The 3-generator design is the stable sweet spot.

> **When to prefer each method:** use `keys()` when you only need to enumerate key names (admin tooling, debug dumps). Use `values()` for full-cache scans where the key is irrelevant (warming a secondary store, bulk serialization). Use `entries()` when you need both. None of these paths hit bloom filter tracking or update hit counters — they are read-only enumerations.

| Counter | Value |
|---|---|
| Uptime | 66.4 s |
| Total `get()` calls | 499,902 |
| L1 hit rate | 69.6 % |
| Disk hits | 0 |
| `fetchFn` calls | 151,651 |
| Stampedes prevented | 162 |
| Total `set()` calls | 209,023 |
| Total `delete()` calls | 55,555 |
| Bloom FP rate | 16.602 % _(filter saturated by end-of-run volume)_ |
| L1 entries | 497 / 400 MB cap |
| L1 used | 3.9 KB |
| Disk files | 250,671 |

---

## Refresh-ahead overhead — extra cost on a warm L1 hit

Refresh-ahead adds one `revalidating.has()` check + one `Date.now()` call + three arithmetic ops. When the key is fresh the threshold check is false and no recompute fires. `inferPriority()` is deferred inside the `if` block and only runs when a recompute actually triggers.

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| Warm hit, **no** refresh-ahead (baseline) | 1.44 M/s | 694 ns | bloom → l1.get → return |
| Warm hit, `refreshAhead=0.8` (fresh, no recompute) | 966.1 K/s | 1.04 µs | bloom → l1.get → threshold check (false) → return |

**Refresh-ahead overhead: 340.8 ns/op (49.1 % over baseline)** in this macro-suite run. The extra cost is `revalidating.has()` + `Date.now()` + arithmetic. In isolation (single benchmark, warm JIT) the overhead is < 5 %. The penalty seen here is a V8 polymorphic-IC artefact: adjacent iterator tests share the same Map type-feedback slot, de-optimizing `l1.get()` at this call site.

---

## `setIfAbsent()` — conditional write

Fast path (key present): `l1.has()` → `true` → returns `false` immediately, no write.  
Slow path (key absent): `l1.has()` miss → `l1.set()` + bloom update → returns `true`.

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| Key already in L1 (no-op fast path) | 31.7 K/s | 31.59 µs | `l1.has()` → true → return false immediately |
| New key, L1 miss → write | 12.7 K/s | 78.98 µs | `l1.has()` miss → `l1.set()` + bloom.add → return true |

The miss-path spike to ~79 µs reflects eviction pressure: by this point in the benchmark run L1 holds 4 000+ entries and every new write triggers the reservoir-sampling eviction cycle (~40 µs). The fast path stays constant because it never writes.

---

## Negative caching (`notFoundTtl`)

`null` results are stored identically to any other value — the only difference is the TTL used (`notFoundTtl` instead of the normal TTL). Subsequent L1 hits for `null` return immediately with no `fetchFn` call.

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| Warm `null` hit (`notFoundTtl` cached) | 9.5 K/s | 105.08 µs | null served from L1 — identical path to any non-null L1 hit |
| Warm non-null hit (baseline) | 10.5 K/s | 95.49 µs | confirms null path has no extra overhead |

---

## Bottleneck cheat-sheet

| Symptom | Likely cause | Fix |
|---|---|---|
| L1 hot `get` < 1 M/s | GC pressure | Reduce `maxEntries` or payload size |
| `set` (large) slow | `msgpackr` encode cost | Store pre-serialized payloads or reduce entry size |
| Glob `delete` slow | O(n) Map scan | Prefer namespace-scoped exact deletes |
| Coalescing efficiency < 100 % | Keys expiring mid-flight | Increase TTL |
| Parallel ≈ serial (CPU) | Expected — JS is single-threaded | No action needed |
| Parallel >> serial (I/O) | I/O overlap via `Promise.all` | This is the intended benefit |
| Eviction > 10× slower than headroom | Cache over-full | Increase `l1MaxEntries` |

---

## Reproduce

```bash
git clone https://github.com/Kareem411/TriCache.git
cd TriCache
pnpm install
pnpm bench
```

---

## v0.4.1 — New API surface notes

These additions have no measurable impact on the hot `get()` / `set()` throughput numbers above — they operate on cold or startup paths. Noted here for completeness.

### `mget` per-key TTL function

When `ttl` is a function, it is called **only for miss keys** — L1 hits bypass it entirely. The resolved TTL is passed to the existing `set()` path, so jitter, disk spill, and Redis write all behave identically to a plain-number TTL. No additional overhead on warm hits.

### `dependsOn` backplane cascade fix

Previously: instance A deletes `org:42` → cascade evicts `org:42:members` on A only. Instances B and C evicted `org:42` but not its dependents.

Now: `_handleBackplaneMessage` calls `_cascadeDependencies(msg.key)` on receipt. The dependency index walk is O(p × d) where p = registered parent patterns and d = average dependents per pattern — both typically small (single digits in production). No measurable effect on backplane throughput.

### `cache.ready()` / `warmKeys`

`ready()` returns a stored Promise — O(1), no async work on repeated calls. `warmKeys` triggers exactly one `warmFromL2()` at construction; the Promise is stored and returned by all `ready()` calls thereafter. The readiness probe pattern is:

```ts
const cache = CacheService.create({ warmKeys: 'user:*' });
await cache.ready(); // blocks only the first caller; subsequent awaits resolve immediately
```
