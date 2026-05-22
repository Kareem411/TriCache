# tricache

**Three-tier Node.js cache with adaptive eviction, disk spill, Redis/Valkey L2, AES-256-GCM at-rest encryption, WASM Bloom filter, Stale-While-Revalidate, and thundering-herd prevention.**

```
Request
  │
  ▼
L1 — SmartMemoryCache   (in-process RAM, 200 MB, adaptive LFU/LRU, always active)
  │ miss
  ▼
L1.5 — DiskTier         (NVMe spill, 500 MB, 2–100 µs, evicted L1 entries)
  │ miss
  ▼
L2 — Redis / Valkey     (distributed, production-only by default)
  │ miss
  ▼
fetchFn()               (your database / API call)
```

---

## Features

| Feature | Detail |
|---|---|
| **Adaptive eviction** | LFU × LRU × priority score; category-aware limits prevent any prefix from monopolising RAM |
| **WASM Bloom filter** | O(k) guaranteed-miss detection — 562-byte binary, inlined as Base64, JS fallback |
| **msgpackr compression** | Entries ≥ 512 bytes are compressed; smaller entries stored as JSON |
| **Stale-While-Revalidate** | Serve stale data instantly, revalidate in background |
| **Thundering-herd prevention** | Inflight Promise registry — only one DB call per key at a time |
| **Cold-start snapshot** | L1 persisted to disk on `SIGTERM`/`SIGINT`, reloaded on next startup |
| **AES-256-GCM encryption** | L2 (Redis) values and disk files encrypted at rest |
| **Distributed counter** | `cache.increment()` backed by Redis `INCR` for distributed rate limiting |
| **Pluggable logger** | Bring your own `pino`, `winston`, etc. |
| **ESM + CJS** | Dual-format build via tsup |

---

## Install

```bash
npm install tricache
# or
pnpm add tricache
```

> **Peer dependency**: `ioredis` is a regular dependency — no separate install needed.

---

## Quick start

```typescript
import { CacheService, CachePriority } from 'tricache';

// Create (or retrieve) the process-level singleton
const cache = CacheService.create({
  redisHost: 'my-redis.example.com',   // omit to disable L2
});

// Get-or-fetch (5-minute TTL)
const user = await cache.get(
  `user:${userId}`,
  () => db.users.findById(userId),
  300,
);

// Explicit set
await cache.set(`user:${userId}`, user, 300);

// Delete exact key
await cache.delete(`user:${userId}`);

// Delete by pattern (glob)
await cache.delete(`user:${userId}:*`);

// Stale-While-Revalidate: serve stale for up to 30 extra seconds
const dashboard = await cache.get(
  `dashboard:${orgId}`,
  () => analytics.buildDashboard(orgId),
  300,
  { swr: 30 },
);

// Distributed counter (rate limiting)
const count = await cache.increment(`ratelimit:${ip}`, 60 /* TTL seconds */);
```

---

## Configuration

All options are optional — sensible defaults apply.

```typescript
CacheService.create({
  // ── Logger ────────────────────────────────────────────────────────────
  logger: pinoLogger,               // default: minimal console logger

  // ── L1 (in-memory) ───────────────────────────────────────────────────
  l1MaxBytes:   200 * 1024 * 1024,  // 200 MB total RAM cap
  l1MaxEntries: 2_000,              // max entries in L1
  categoryLimits: {
    // per-prefix limits (prefix = first segment of your cache key)
    'user:':      { maxEntries: 500,  maxSizeBytes: 50 * 1024 * 1024 },
    'analytics:': { maxEntries: 100,  maxSizeBytes: 20 * 1024 * 1024 },
    'default':    { maxEntries: 1000, maxSizeBytes: 100 * 1024 * 1024 },
  },

  // ── L1.5 (disk spill) ────────────────────────────────────────────────
  diskCacheDir:      '/tmp/my-app-cache',  // default: os.tmpdir()/tricache-disk
  diskMaxBytes:      500 * 1024 * 1024,   // 500 MB
  diskEntryMaxBytes: 10  * 1024 * 1024,   // 10 MB per entry

  // ── L2 (Redis / Valkey) ──────────────────────────────────────────────
  redisHost:    'my-redis.example.com',   // or set REDIS_HOST env var
  redisPort:    6379,
  redisTls:     true,                     // default true in production
  disableRedis: false,                    // default true in development

  // ── Encryption ───────────────────────────────────────────────────────
  // base64-encoded 32-byte AES-256-GCM key (or set CACHE_ENCRYPTION_KEY env var)
  // generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  encryptionKey: process.env.CACHE_ENCRYPTION_KEY,

  // ── Cold-start snapshot ──────────────────────────────────────────────
  snapshotPath:     '/tmp/my-app-cache-snapshot.msgpack',
  snapshotMaxAgeMs: 2 * 60 * 60 * 1000,  // 2 hours
  forbiddenSnapshotPrefixes: ['auth:', 'session:', 'mfa:', 'rate_limit:'],
});
```

### Environment variables

| Variable | Purpose |
|---|---|
| `REDIS_HOST` | Redis/Valkey hostname (used when `redisHost` option is not set) |
| `CACHE_ENCRYPTION_KEY` | Base64-encoded 32-byte AES-256-GCM key |
| `NODE_ENV` | When `!== 'production'`, L2 Redis is disabled by default |

---

## API reference

### `CacheService.create(options?)` → `CacheService`
Returns the process-level singleton. Options are only applied on the first call.

### `CacheService.reset(options?)` → `CacheService`
Destroy the existing singleton and create a fresh one (useful in tests).

### `cache.get<T>(key, fetchFn, ttlSeconds?, opts?)` → `Promise<T>`
Get from cache or call `fetchFn` on miss.
- `opts.priority` — `CachePriority.LOW | NORMAL | HIGH | CRITICAL`
- `opts.swr` — Stale-While-Revalidate grace seconds

### `cache.set<T>(key, data, ttlSeconds?, priority?)` → `Promise<void>`
Explicitly write to L1 (+ L2 in production).

### `cache.delete(key)` → `Promise<void>`
Delete an exact key or a glob pattern (e.g. `user:abc:*`).

### `cache.increment(key, ttlSeconds?)` → `Promise<number>`
Redis `INCR` for distributed counters. Returns `0` when Redis is disabled.

### `cache.stats()` → `{ l1, disk }`
Current cache statistics.

### `cache.writeSnapshot()` / `cache.loadSnapshot()`
Manual snapshot control (normally handled automatically on `SIGTERM`/`SIGINT`).

### `cache.destroy()` → `Promise<void>`
Close Redis connection and stop the cleanup timer.

---

## Priority levels

```typescript
import { CachePriority } from 'tricache';

CachePriority.LOW      // analytics, reports — evicted first
CachePriority.NORMAL   // general data
CachePriority.HIGH     // profiles, config — evicted last
CachePriority.CRITICAL // never evicted while valid (auth tokens, active sessions)
```

When not specified, priority is inferred from the key prefix:
- `auth:`, `session:` → `CRITICAL`
- `user:`, `org:`, `profile:` → `HIGH`
- `analytics:`, `report:`, `stats:` → `LOW`
- everything else → `NORMAL`

---

## Pluggable logger

```typescript
import pino from 'pino';
import { CacheService } from 'tricache';

const logger = pino();

const cache = CacheService.create({
  logger: {
    debug: (msg, meta) => logger.debug(meta ?? {}, msg),
    info:  (msg, meta) => logger.info(meta  ?? {}, msg),
    warn:  (msg, meta) => logger.warn(meta  ?? {}, msg),
    error: (msg, meta, err) => logger.error({ ...(meta ?? {}), err }, msg),
  },
});
```

---

## Encryption

AES-256-GCM encryption for L2 (Redis) values and disk files:

```bash
# Generate a key
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```typescript
CacheService.create({ encryptionKey: '<base64-32-bytes>' });
// or
process.env.CACHE_ENCRYPTION_KEY = '<base64-32-bytes>';
```

Encrypted Redis format: `enc:v1:<base64(IV[12] | AuthTag[16] | Ciphertext[N])>`  
Disk/snapshot format: `MAGIC[8] | IV[12] | AuthTag[16] | Ciphertext[N]`

Legacy plaintext values are read transparently during migration.

---

## How the WASM Bloom filter works

A 100,000-bit filter with 7 hash probes gives a ~0.01% false-positive rate at 2,000 entries.

- `mightContain(key) === false` → **guaranteed miss** — the Map lookup is skipped entirely
- `mightContain(key) === true` → probable hit — the Map lookup is performed to confirm

The 562-byte WASM binary is inlined as Base64 — no file-system access at runtime. Falls back to a pure-JS implementation if `WebAssembly` is unavailable.

---

## License

MIT
