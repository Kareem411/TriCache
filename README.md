# TriCache

[![CI](https://github.com/Kareem411/TriCache/actions/workflows/ci.yml/badge.svg)](https://github.com/Kareem411/TriCache/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-VitePress-blue.svg)](https://kareem411.github.io/TriCache/)
[![npm version](https://img.shields.io/npm/v/tricache.svg)](https://www.npmjs.com/package/tricache)
[![npm downloads](https://img.shields.io/npm/dm/tricache.svg)](https://www.npmjs.com/package/tricache)
[![Tests](https://img.shields.io/badge/tests-980%20passing-brightgreen)](tests)
[![Code Quality](https://img.shields.io/badge/oxlint-0%20warnings-brightgreen)](src)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js ≥ 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

> 🌐 **Documentation Site**: **[https://kareem411.github.io/TriCache/](https://kareem411.github.io/TriCache/)**  
> 📦 **npm Package**: **[`npm install tricache`](https://www.npmjs.com/package/tricache)**

**TriCache** is a three-tier caching engine for Node.js: **L1 RAM** $\rightarrow$ **L1.5 disk or `/dev/shm` spill** $\rightarrow$ **L2 Redis/Valkey**. It combines bounded local storage, per-process singleflight, configurable stale-while-revalidate, and distributed invalidation. Performance and savings depend on your workload; [benchmark your deployment](BENCHMARKS.md).

---

## ⚡ 30-Second Quickstart

```bash
npm install tricache # or pnpm add tricache
```

```typescript
import { CacheService } from 'tricache';

// 1. One-line preset: W-TinyLFU, Redis Streams, /dev/shm off-heap spill, & SWR
const cache = CacheService.preset('nextjs', { redisHost: process.env.REDIS_HOST });
await cache.ready();

// 2. Get-or-fetch with thundering-herd coalescing & 60s background SWR
const user = await cache.get(
  `user:${userId}`,
  () => db.users.findById(userId),
  300,        // 5-minute TTL
  { swr: 60, tags: ['users'] } // Serve stale for 60s while refreshing in the background
);

// 3. Bump a concrete tag generation and publish invalidation to peers
await cache.invalidateTag('users');
```

---

## 🔬 Under the Hood (Architectural Core)

```
                           [Incoming Read Request]
                                      │
                                      ▼
             ┌──────────────────────────────────────────────────┐
             │       L1: Smart Memory (W-TinyLFU + CMS)         │  Bounded RAM
             │   Window LRU (1%) + Segmented Main SLRU (99%)    │  Packed values
             └────────────────────────┬─────────────────────────┘
                                      │ Miss / Eviction Spill
                                      ▼
             ┌──────────────────────────────────────────────────┐
             │    L1.5: Off-Heap /dev/shm & NVMe Spill Tier     │  Bounded I/O
             │   tmpfs counts toward container memory usage   │  Writable mount needed
             └────────────────────────┬─────────────────────────┘
                                      │ Miss
                                      ▼
             ┌──────────────────────────────────────────────────┐
             │       L2: Redis / Valkey Distributed Tier        │  ~1.2 ms (Network)
             │   Optional AES-GCM + expiry/tag metadata        │  Pipelined commands
             └────────────────────────┬─────────────────────────┘
                                      │ Complete Cache Miss
                                      ▼
             ┌──────────────────────────────────────────────────┐
             │   Upstream Database / API (Singleflight)         │  Per process/key
             │   Inflight Promise Map coalesces concurrent work│  Not a fleet-wide lock
             └──────────────────────────────────────────────────┘
```

* **Window TinyLFU (W-TinyLFU)**: ~1% Window LRU absorbs recency bursts; 4-row Count-Min Sketch rejects table scans. [[Internals $\rightarrow$](https://kareem411.github.io/TriCache/architecture-internals)]
* **WebAssembly Zstandard Compression**: Out-of-the-box `zstd` WASM engine compresses payloads $>1$ KB by ~95% with automatic Brotli fallback and optional LZ4.
* **Off-Heap `/dev/shm` RAM Spill**: Targets Linux POSIX shared memory tmpfs ($\ge 256\text{MB}$ total, $\ge 128\text{MB}$ free), burning 0 cloud IOPS. [[SRE Guide $\rightarrow$](https://kareem411.github.io/TriCache/kubernetes-production-guide)]
* **Dynamic Latency Watchdog**: Graduated shedding (0% $\rightarrow$ 25% $\rightarrow$ 75% $\rightarrow$ 100%) with asymmetric Redis hysteresis (15ms cutoff, 10ms recovery floor).
* **Ephemeral Quotas & K8s Eviction Defense**: Chunked watermark pruning (80% $\rightarrow$ 60% in 500-entry batches) and proactive $<10\%$ space spill pauses.
* **Wildcard & Hierarchical Tag Invalidation**: Concrete generation bumps are $O(1)$; wildcard and hierarchy resolution scan matching tag metadata.
* **Differential Multi-Tier Waterfall Batching**: Cascading `cache.mget` resolves L1 $\rightarrow$ L2 $\rightarrow$ Disk $\rightarrow$ DB miss fetch with zero $N+1$ queries.
* **Zero-Dependency Cloud Hydration (SigV4)**: Hydrates cold pods from S3/R2 in milliseconds via native Web Crypto. [[Cloud Guide $\rightarrow$](https://kareem411.github.io/TriCache/cold-start-cloud-hydration)]

---

## 🏆 Feature Overview

| Feature | Behavior |
|:---|:---|
| **Storage hierarchy** | RAM → eligible disk/tmpfs spill → Redis/Valkey |
| **Singleflight** | Coalesces concurrent work per process and key |
| **Tag invalidation** | Concrete generation bumps; metadata scans for patterns/cascades |
| **Backplane** | Pub/Sub or retained-event Redis Streams replay |
| **Compression** | Zstandard with fallback; optional Brotli, gzip, LZ4, or custom compressor |
| **Batch reads** | Resolves cached keys and fetches only remaining misses |
| **Resource controls** | Packed-data limits, bounded disk I/O, and cgroup pressure guards |
| **Encryption** | Optional AES-GCM for Node and Web Crypto edge storage |

---

## 🎯 Production Presets (`CacheService.preset`)

```typescript
// 1. Next.js 16 App Router (React 19 RSC streams & generational tags)
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
| **Next.js 16** | `tricache/next` | Native Cache Components `cacheHandlers` with bounded RSC streams, timing preservation, and soft-tag expiry. |
| **NestJS 10–12** | `tricache/nestjs` | `TriCacheModule`, millisecond TTL facade, Keyv 5/cache-manager 7 adapter, and `@Cacheable`. |
| **Prisma ORM** | `tricache/prisma` | `$extends` client extension with query hashing and auto-mutation tag eviction. |
| **Drizzle ORM** | `tricache/drizzle` | `withCache(query, opts)` query wrapper with SQL+parameters hashing and background SWR. |
| **Express & Fastify** | `tricache/http` | Route caching middleware with deterministic query sorting, weak ETag, and `304 Not Modified`. |
| **Node Hono** | `tricache/hono` | Response caching with TTL/tags, privacy guards, and `304 Not Modified`. |
| **Edge Isolates & Hono** | `tricache/edge` | Zero-Node-dependency implementation for Cloudflare Workers, Fastly Compute, Hono, and Vercel Edge. |
| **SSE Dashboard** | `tricache/dashboard` | Zero-dependency Server-Sent Events real-time admin dashboard. |
| **Live CLI Top** | `npx tricache top` | Real-time terminal ASCII monitor over Unix sockets and Windows named pipes. |

### Safety and consistency

- HTTP middleware bypasses credentialed requests by default and excludes private, cookie-setting, partial, and unkeyed `Vary` responses. Response refreshes run on live requests; use `cache.get()`/`wrap()` for data-level SWR.
- Dashboard access should be authenticated and private. It defaults to `readOnly: true`; administrative writes require explicit opt-in.
- Redis Streams provide replay only while events are retained. A detected gap flushes local state. `awaitInvalidationBackplane: true` confirms publication, not peer acknowledgments or exactly-once delivery.
- Redis promotions preserve remaining TTL where supported. Custom drivers without atomic expiry reads use fallback TTLs; edge legacy JSON without expiry metadata is read without local promotion.
- `/dev/shm` reduces disk I/O but still consumes container memory. Encryption and cache configuration do not by themselves establish regulatory compliance.

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
