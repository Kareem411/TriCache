# TriCache

[![CI](https://github.com/Kareem411/TriCache/actions/workflows/ci.yml/badge.svg)](https://github.com/Kareem411/TriCache/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-VitePress-blue.svg)](https://kareem411.github.io/TriCache/)
[![npm version](https://img.shields.io/npm/v/tricache.svg)](https://www.npmjs.com/package/tricache)
[![npm downloads](https://img.shields.io/npm/dm/tricache.svg)](https://www.npmjs.com/package/tricache)
[![Tests](https://img.shields.io/badge/tests-826%20passing-brightgreen)](tests)
[![Code Quality](https://img.shields.io/badge/oxlint-0%20warnings-brightgreen)](src)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js ≥ 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

> 🌐 **Documentation Site**: **[https://kareem411.github.io/TriCache/](https://kareem411.github.io/TriCache/)**  
> 📦 **npm Package**: **[`npm install tricache`](https://www.npmjs.com/package/tricache)**

**TriCache** is an enterprise three-tier caching engine for Node.js: **L1 RAM** $\rightarrow$ **L1.5 Off-Heap `/dev/shm`** $\rightarrow$ **L2 Redis/Valkey**. Warm in-memory reads run at **2.81 million ops/sec (356 ns/op)**. By absorbing 95%+ of queries locally in zero-GC POSIX shared memory with Singleflight stampede coalescing, TriCache slashes cloud Redis bills and latency without risking stale data.

---

## ⚡ 30-Second Quickstart

```bash
npm install tricache # or pnpm add tricache
```

```typescript
import { CacheService } from 'tricache';

// 1. One-line preset: W-TinyLFU, Redis Streams, /dev/shm off-heap spill, & SWR
const cache = CacheService.preset('nextjs', { redisHost: process.env.REDIS_HOST });

// 2. Get-or-fetch with thundering-herd coalescing & 60s background SWR
const user = await cache.get(
  `user:${userId}`,
  () => db.users.findById(userId),
  300,        // 5-minute TTL
  { swr: 60 } // Serve stale for 60s while refreshing in the background
);

// 3. Invalidate group entries in O(1) time across your entire cluster
await cache.invalidateTag('users');
```

---

## 🔬 Under the Hood (Architectural Core)

```
                           [Incoming Read Request]
                                      │
                                      ▼
             ┌──────────────────────────────────────────────────┐
             │       L1: Smart Memory (W-TinyLFU + CMS)         │  ~350 ns (2.81M ops/s)
             │   Window LRU (1%) + Segmented Main SLRU (99%)    │  Zero V8 allocation
             └────────────────────────┬─────────────────────────┘
                                      │ Miss / Eviction Spill
                                      ▼
             ┌──────────────────────────────────────────────────┐
             │    L1.5: Off-Heap /dev/shm & NVMe Spill Tier     │  ~20 µs (RAM speed)
             │   POSIX tmpfs bypasses V8 GC & cloud EBS IOPS    │  readOnlyRootFilesystem
             └────────────────────────┬─────────────────────────┘
                                      │ Miss
                                      ▼
             ┌──────────────────────────────────────────────────┐
             │       L2: Redis / Valkey Distributed Tier        │  ~1.2 ms (Network)
             │   AES-256-GCM AEAD at-rest + msgpackr records    │  Pipelined MGET/MSET
             └────────────────────────┬─────────────────────────┘
                                      │ Complete Cache Miss
                                      ▼
             ┌──────────────────────────────────────────────────┐
             │   Upstream Database / API (Singleflight Lock)    │  Exactly 1 execution
             │   Inflight Promise Map coalesces 10,000 callers  │  Zero stampedes
             └──────────────────────────────────────────────────┘
```

* **Window TinyLFU (W-TinyLFU)**: ~1% Window LRU absorbs recency bursts; 4-row Count-Min Sketch rejects table scans. [[Internals $\rightarrow$](https://kareem411.github.io/TriCache/architecture-internals)]
* **Off-Heap `/dev/shm` RAM Spill**: Targets Linux POSIX shared memory tmpfs ($\ge 256\text{MB}$ total, $\ge 128\text{MB}$ free), burning 0 cloud IOPS. [[SRE Guide $\rightarrow$](https://kareem411.github.io/TriCache/kubernetes-production-guide)]
* **Dynamic Latency Watchdog**: Graduated shedding (0% $\rightarrow$ 25% $\rightarrow$ 75% $\rightarrow$ 100%) with asymmetric Redis hysteresis (15ms cutoff, 10ms recovery floor).
* **Ephemeral Quotas & K8s Eviction Defense**: Chunked watermark pruning (80% $\rightarrow$ 60% in 500-entry batches) and proactive $<10\%$ space spill pauses.
* **Generational Tag Invalidation ($O(1)$)**: Version counters (`INCR tag_ver:<tag>`) eliminate blocking Redis `KEYS`/`SMEMBERS` scans.
* **Zero-Dependency Cloud Hydration (SigV4)**: Hydrates cold pods from S3/R2 in milliseconds via native Web Crypto. [[Cloud Guide $\rightarrow$](https://kareem411.github.io/TriCache/cold-start-cloud-hydration)]

---

## 🏆 Feature Comparison

| Dimension | `lru-cache` | `keyv` / `cache-manager` | `@neshca/cache-handler` | **TriCache** |
|:---|:---|:---|:---|:---|
| **Storage Hierarchy** | In-Memory only | Single Remote (Redis) | Memory + Redis | **Three-Tier (RAM $\rightarrow$ `/dev/shm` $\rightarrow$ Redis)** |
| **Warm Hit Latency** | ~300 ns | 1,200,000 ns (1.2 ms) | ~400 ns | **356 ns (2.81M ops/sec)** |
| **Thundering-Herd Defense**| ❌ No | ❌ External plugin | ❌ No | **✅ Native Singleflight Coalescing** |
| **Tag Invalidation** | ❌ None | $O(N)$ blocking scan | $O(N)$ Redis Set | **✅ $O(1)$ Generational Versions** |
| **Cluster Sync Backplane**| ❌ None | At-most-once Pub/Sub | Pub/Sub | **✅ Durable Redis Streams (`XADD`/`XREAD`)** |
| **Container Memory Safety**| Unbounded GC | N/A (Remote only) | Heap-bound | **✅ Off-heap tmpfs + 80% OOM Guard** |
| **Encryption at Rest** | ❌ None | ❌ None | ❌ None | **✅ AES-256-GCM / Web Crypto AEAD** |

---

## 🎯 Production Presets (`CacheService.preset`)

```typescript
// 1. Next.js 16 / 15 App Router (Optimized for React 19 RSC streams & generational tags)
const cache = CacheService.preset('nextjs', { redisHost: 'redis.internal' });

// 2. High-Throughput Microservice (Streams backplane, TTL jitter, circuit breakers)
const cache = CacheService.preset('microservice', { redisHost: 'redis.internal' });

// 3. Serverless (AWS Lambda / Cloud Run: memory-only, fast 1s timeouts, pubsub)
const cache = CacheService.preset('serverless', { redisHost: 'redis.internal' });

// 4. Enterprise Hardened (Generational tags, strict singletons, fail-closed rate limits, 80% OOM guard)
const cache = CacheService.preset('enterprise-hardened', { redisHost: 'redis.internal' });
```

---

## 🗄️ Turnkey Ecosystem Integrations

| Integration | Import Path | Description |
|:---|:---|:---|
| **Next.js 16 & 15** | `tricache/next` | Drop-in `cacheHandler` with RSC stream re-hydration and dynamic `softTags`. |
| **NestJS Module** | `tricache/nestjs` | Official `TriCacheModule.register()`, `@nestjs/cache-manager` store adapter, and `@Cacheable`. |
| **Prisma ORM** | `tricache/prisma` | `$extends` client extension with query hashing and auto-mutation tag eviction. |
| **Drizzle ORM** | `tricache/drizzle` | `withCache(query, opts)` query wrapper with SQL+parameters hashing and background SWR. |
| **Express & Fastify** | `tricache/http` | Route caching middleware with deterministic query sorting, weak ETag, and `304 Not Modified`. |
| **Koa** | `tricache/koa` | Official Koa middleware (`koaCache`) with the same GET/HEAD, ETag/`304`, ttl/swr/tags, and skipCache contract. |
| **Hono & Edge Isolates** | `tricache/edge` | Zero-Node-dependency implementation for Cloudflare Workers, Fastly Compute, Hono, and Vercel Edge. |
| **SSE Dashboard** | `tricache/dashboard` | Zero-dependency Server-Sent Events real-time admin dashboard. |
| **Live CLI Top** | `npx tricache top` | Real-time terminal ASCII monitor over Unix sockets and Windows named pipes. |

---

## 📚 Documentation & Deep Dives

* 📖 **[Documentation Portal](https://kareem411.github.io/TriCache/)** — Official VitePress guides, architecture, and API reference
* 🔬 **[Architecture & Mathematical Internals](docs/architecture-internals.md)** — W-TinyLFU, CMS, Bloom filters, SigV4 signer
* ☸️ **[Kubernetes SRE & Production Guide](docs/kubernetes-production-guide.md)** — `/dev/shm`, cgroups, eviction defense, readiness probes
* ☁️ **[Cold-Start Cloud Snapshot Hydration](docs/cold-start-cloud-hydration.md)** — S3, Cloudflare R2, readiness gates
* 📈 **[Prometheus /metrics Scraping Recipe](docs/metrics-recipe.md)** — Express / Fastify / Next.js endpoints, scrape config, and one-command local Grafana stack
* 💰 **[Cloud ROI Financial Simulation](bench/cloud-roi-simulation.ts)** — Deterministic Mulberry32 Zipfian benchmark (`pnpm bench:roi`)
* 📊 **[Full Benchmark Suite](BENCHMARKS.md)** — Throughput, serialization, concurrency analysis

---

## 📄 License

MIT © [Kareem](https://github.com/Kareem411)
