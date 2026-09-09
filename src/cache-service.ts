/**
 * CacheService — three-tier cache with stampede prevention and SWR.
 *
 * Architecture:
 *   L1  → SmartMemoryCache  (in-process RAM, always active, adaptive eviction)
 *   L1.5→ DiskTier          (NVMe overflow, evicted L1 entries, 2–100 µs)
 *   L2  → Redis / Valkey    (distributed, production-only by default, survives restarts)
 *   DB  → your fetchFunction (cache miss path)
 *
 * Key features:
 *   - Thundering-herd / cache-stampede prevention (inflight Promise registry)
 *   - Stale-While-Revalidate (serve stale instantly + revalidate in background)
 *   - AES-256-GCM encryption for L2 and disk data at rest
 *   - Cold-start snapshot: L1 is persisted to disk on SIGTERM and restored on startup
 *   - Process-level singleton (globalThis) survives hot reloads in frameworks like Next.js
 *   - Periodic cleanup of expired entries every 5 minutes
 */

import { Redis as RedisClient, Cluster as RedisCluster } from 'ioredis';
import { CacheCodec } from './codec.js';
import type { RemoteSnapshotOptions } from './remote-snapshot.js';
import type { CrossRegionRelayOptions, CrossRegionInvalidationEvent } from './cross-region.js';
import crypto from 'crypto';
import os    from 'os';
import { WorkerPool } from './worker-pool.js';
import v8    from 'node:v8';
import fs    from 'fs';
import path  from 'path';


import {
  CachePriority,
  CategoryLimit,
  SmartCacheEntry,
  DiskCacheEntry,
  CacheOptions,
  CacheMetrics,
  CachePingResult,
  ILogger,
  ICacheTracer,
  ICacheSpan,
  ICacheSpanLink,
  consoleLogger,
  WrapOptions,
  LockOptions,
  ICacheMeter,
  ICacheCounter,
  IRedisDriver,
} from './types';
import { CacheEncryption, type EncryptionMode } from './encryption';
import { SmartMemoryCache }  from './smart-memory-cache';
import { DiskTier }          from './disk-tier';
import {
  compressBuffer,
  decompressBuffer,
  PREFIX_COMPRESSED,
  PREFIX_ENC_COMPRESSED,
  type CompressionAlgorithm,
} from './compression';

// ─── Lua scripts ─────────────────────────────────────────────────────────────

const LUA_COMPARE_AND_DELETE = `
local currentTs = redis.call('HGET', KEYS[1], 't')
if currentTs and currentTs == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

// ─── Snapshot constants ───────────────────────────────────────────────────────

const SNAPSHOT_VERSION         = 1;
const DEFAULT_SNAPSHOT_MAX_AGE = 2 * 60 * 60 * 1000; // 2 hours
/** ttl 0 ("indefinite", per the NestJS store contract) maps to a 1-year expiry. */
const INDEFINITE_TTL_SECONDS   = 31_536_000;
const SNAPSHOT_MAX_FILE_BYTES  = 220 * 1024 * 1024;   // 220 MB guard

// ─── Default category limits ──────────────────────────────────────────────────

const DEFAULT_CATEGORY_LIMITS: Record<string, CategoryLimit> = {
  'default': { maxEntries: 500,  maxSizeBytes: 50 * 1024 * 1024 },
};

// ─── Default forbidden prefixes ───────────────────────────────────────────────

const DEFAULT_FORBIDDEN_PREFIXES = ['auth:', 'session:', 'mfa:', 'rate_limit:'] as const;

// ─── Default counter TTL ──────────────────────────────────────────────────────
const DEFAULT_COUNTER_TTL_SECONDS = 60;

// ─── Glob regex cache (bounded LRU, max 256 compiled patterns) ───────────────
const GLOB_REGEX_CACHE_MAX = 256;
const globRegexCache = new Map<string, RegExp>();

function getGlobRegex(pattern: string): RegExp {
  let re = globRegexCache.get(pattern);
  if (re) {
    globRegexCache.delete(pattern);
    globRegexCache.set(pattern, re);
    return re;
  }

  // Escape special regex characters except '*', then collapse multiple consecutive '*' into '.*'
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*+/g, '.*');

  re = new RegExp('^' + escaped + '$');

  if (globRegexCache.size >= GLOB_REGEX_CACHE_MAX) {
    const oldestKey = globRegexCache.keys().next().value;
    if (oldestKey !== undefined) globRegexCache.delete(oldestKey);
  }
  globRegexCache.set(pattern, re);
  return re;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Circuit breaker — three-state (CLOSED → OPEN → HALF_OPEN) for L2 Redis
// ─────────────────────────────────────────────────────────────────────────────

const enum CBState { CLOSED, OPEN, HALF_OPEN }

class L2CircuitBreaker {
  private state      = CBState.CLOSED;
  private failures   = 0;
  private openedAt   = 0;
  /** True while the single permitted HALF_OPEN probe is in flight. */
  private probing    = false;
  constructor(
    private readonly threshold:  number,
    private readonly cooldownMs: number,
  ) {}

  /**
   * Call before each Redis attempt. Returns false when the circuit is open.
   * In HALF_OPEN, only ONE probe is permitted at a time — concurrent callers
   * arriving while a probe is outstanding are rejected (return false) so a
   * recovering Redis node is not stampeded.
   */
  isAllowed(): boolean {
    if (this.state === CBState.CLOSED)    return true;
    if (this.state === CBState.HALF_OPEN) {
      if (this.probing) return false; // a probe is already in flight
      this.probing = true;
      return true;                    // this caller is the one permitted probe
    }
    // OPEN: check if cooldown elapsed
    if (Date.now() - this.openedAt >= this.cooldownMs) {
      this.state   = CBState.HALF_OPEN;
      this.probing = true;
      return true; // probe
    }
    return false;
  }

  /** Call on Redis success. */
  onSuccess(): void {
    this.failures = 0;
    this.probing  = false;
    this.state    = CBState.CLOSED;
  }

  /** Call on Redis failure. */
  onFailure(): void {
    this.failures++;
    this.probing = false;
    if (this.state === CBState.HALF_OPEN || this.failures >= this.threshold) {
      this.state    = CBState.OPEN;
      this.openedAt = Date.now();
      this.failures = 0;
    }
  }

  get isOpen(): boolean { return this.state === CBState.OPEN; }
  get currentState(): 'closed' | 'open' | 'half_open' {
    return this.state === CBState.CLOSED ? 'closed'
         : this.state === CBState.OPEN   ? 'open'
         :                                 'half_open';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Priority inference — override by passing priority explicitly to get()
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively freezes an object and all its nested properties.
 * Used only when `CacheOptions.frozen` is true (dev/test mode).
 * Already-frozen objects are skipped to avoid redundant traversal.
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const v of Object.values(obj as object)) deepFreeze(v);
  return obj;
}

// ─── Adaptive TTL latency tracker ────────────────────────────────────────────

/**
 * Lightweight per-key fetch-latency ring buffer.
 *
 * Each key gets a `Float64Array` of `samples` slots written in round-robin
 * order.  A separate `{ head, count }` object tracks the write pointer and
 * how many slots have been filled so far.  Once a key has ≥ 5 samples the
 * p95 percentile can be read back with `.p95(key)`.
 *
 * Total memory per key: 8 × samples bytes (Float64Array) + one small object.
 * With defaults (32 samples, 5 000 keys): ~1.3 MB worst-case.
 *
 * Key eviction: the internal Map preserves insertion order.  When `maxKeys`
 * is reached the oldest-inserted key is removed before the new one is added —
 * no extra LRU bookkeeping required.
 */
/** Per-key metadata stored alongside each ring buffer. */
interface LatencyMeta {
  head:  number;   // ring-buffer write pointer
  count: number;   // filled slots (≤ samples)
  p95:   number;   // cached p95 value (valid when !dirty && count ≥ 5)
  dirty: boolean;  // true when a new sample was written since last p95 computation
}

class LatencyTracker {
  private readonly samples: number;
  private readonly maxKeys: number;
  private readonly bufs    = new Map<string, Float64Array>();
  private readonly meta    = new Map<string, LatencyMeta>();
  /** Shared sort buffer — safe to reuse because JS is single-threaded. */
  private readonly scratch: Float64Array;

  constructor(samples: number, maxKeys: number) {
    this.samples = samples;
    this.maxKeys = maxKeys;
    this.scratch = new Float64Array(samples);
  }

  record(key: string, deltaMs: number): void {
    let buf = this.bufs.get(key);
    let m   = this.meta.get(key);
    if (buf === undefined) {
      if (this.bufs.size >= this.maxKeys) {
        // Evict oldest key (Map insertion order)
        const oldest = this.bufs.keys().next().value as string;
        this.bufs.delete(oldest);
        this.meta.delete(oldest);
      }
      buf = new Float64Array(this.samples);
      m   = { head: 0, count: 0, p95: 0, dirty: false };
      this.bufs.set(key, buf);
      this.meta.set(key, m);
    }
    buf[m!.head] = deltaMs;
    m!.head  = (m!.head + 1) % this.samples;
    if (m!.count < this.samples) m!.count++;
    m!.dirty = true; // new sample → cached p95 is stale
  }

  /**
   * Recomputes the p95 for the given key into `m.p95` and clears `m.dirty`.
   * Uses the shared scratch buffer — no heap allocation.
   */
  private _computeP95(buf: Float64Array, m: LatencyMeta): void {
    const n = m.count;
    this.scratch.set(buf.subarray(0, n));
    const view = this.scratch.subarray(0, n);
    view.sort(); // TypedArray numeric sort — no comparator needed
    m.p95   = view[Math.ceil(n * 0.95) - 1];
    m.dirty = false;
  }

  /**
   * Returns the p95 fetch latency for `key` in milliseconds, or `null` when
   * fewer than 5 samples have been collected (not enough data yet).
   * Uses a dirty-flag cache — sort only runs when a new sample was recorded.
   */
  p95(key: string): number | null {
    const buf = this.bufs.get(key);
    const m   = this.meta.get(key);
    if (!buf || !m || m.count < 5) return null;
    if (m.dirty) this._computeP95(buf, m);
    return m.p95;
  }

  get trackedKeys(): number { return this.bufs.size; }

  /**
   * Top-20 slowest keys by p95, sorted descending.
   * Keys with < 5 samples are excluded (not enough data for a reliable p95).
   *
   * Only dirty keys (those with new samples since the last call) pay the sort
   * cost. Keys whose p95 is already cached are O(1) reads — so repeated
   * metrics() calls with no intervening fetches are essentially free.
   */
  snapshot(
    prefixLen: number,
    multiplierSec: number,
    minMs: number,
    maxMs: number,
  ): Array<{ key: string; p95Ms: number; adaptedTtlSec: number }> {
    const out: Array<{ key: string; p95Ms: number; adaptedTtlSec: number }> = [];
    for (const [key, buf] of this.bufs) {
      const m = this.meta.get(key)!;
      if (m.count < 5) continue;
      if (m.dirty) this._computeP95(buf, m); // sort only when new sample arrived
      const p95       = m.p95;
      const adaptedMs = Math.max(minMs, Math.min(maxMs, Math.round(p95 * multiplierSec * 1_000)));
      out.push({
        key:           prefixLen > 0 ? key.slice(prefixLen) : key,
        p95Ms:         Math.round(p95),
        adaptedTtlSec: Math.round(adaptedMs / 1_000),
      });
    }
    return out.sort((a, b) => b.p95Ms - a.p95Ms).slice(0, 20);
  }
}

function inferPriority(cacheKey: string): CachePriority {
  if (cacheKey.includes('auth:') || cacheKey.includes('session:'))                                   return CachePriority.CRITICAL;
  if (cacheKey.includes('user:') || cacheKey.includes('org:') || cacheKey.includes('profile:'))      return CachePriority.HIGH;
  if (cacheKey.includes('analytics:') || cacheKey.includes('report:') || cacheKey.includes('stats:')) return CachePriority.LOW;
  return CachePriority.NORMAL;
}

// ─────────────────────────────────────────────────────────────────────────────
//  CacheService
// ─────────────────────────────────────────────────────────────────────────────

// globalThis key — allows reuse across hot reloads (Next.js, ts-node watch, etc.)
const GLOBAL_KEY = '__tricache_instance__';

// ── Union type for single-node, Cluster, Sentinel, and pluggable Redis drivers ──
type AnyRedisClient = RedisClient | RedisCluster | IRedisDriver | any;

// ── Serverless environment detection ─────────────────────────────────────────
/**
 * Returns the name of the detected serverless/ephemeral-filesystem runtime,
 * or `null` when running in a regular persistent-disk environment.
 *
 * Detection is entirely env-var based — zero I/O, zero network, sub-microsecond.
 */
function detectServerlessRuntime(): string | null {
  if (process.env['AWS_LAMBDA_FUNCTION_NAME'])    return 'AWS Lambda';
  if (process.env['K_SERVICE'])                   return 'Google Cloud Run';
  if (process.env['FUNCTION_TARGET'])             return 'Google Cloud Functions';
  if (process.env['WEBSITE_INSTANCE_ID'])         return 'Azure Functions';
  if (process.env['FLY_APP_NAME'])                return 'Fly.io';
  if (process.env['RAILWAY_ENVIRONMENT'])         return 'Railway';
  if (process.env['VERCEL'])                      return 'Vercel';
  return null;
}

/**
 * Centralized static process termination bus.
 * Prevents MaxListenersExceededWarning by attaching at most ONE SIGTERM and ONE SIGINT
 * listener to process, broadcasting to all active CacheService instances.
 * Automatically detaches listeners when the instance count reaches 0, preventing
 * event loop / test runner hangs.
 */
export class ProcessTerminationBus {
  private static readonly instances = new Set<CacheService>();
  private static registered = false;
  private static sigtermHandler: (() => void) | null = null;
  private static sigintHandler: (() => void) | null = null;

  public static register(instance: CacheService): void {
    this.instances.add(instance);
    if (!this.registered) {
      this.registered = true;
      this.sigtermHandler = () => {
        for (const inst of this.instances) {
          try { inst._triggerShutdown(); } catch { /* ok */ }
        }
      };
      this.sigintHandler = () => {
        for (const inst of this.instances) {
          try { inst._triggerShutdown(); } catch { /* ok */ }
        }
      };
      process.on('SIGTERM', this.sigtermHandler);
      process.on('SIGINT',  this.sigintHandler);
    }
  }

  public static unregister(instance: CacheService): void {
    this.instances.delete(instance);
    if (this.instances.size === 0 && this.registered) {
      if (this.sigtermHandler) process.removeListener('SIGTERM', this.sigtermHandler);
      if (this.sigintHandler)  process.removeListener('SIGINT',  this.sigintHandler);
      this.sigtermHandler = null;
      this.sigintHandler = null;
      this.registered = false;
    }
  }

  /** For testing diagnostics and assertions */
  public static get size(): number {
    return this.instances.size;
  }

  public static get isRegistered(): boolean {
    return this.registered;
  }
}

export class CacheService {
  private readonly logger:     ILogger;
  private readonly enc:        CacheEncryption;
  private readonly codec:      CacheCodec;
  private readonly l1:         SmartMemoryCache;
  private readonly disk:       DiskTier;
  /** When true, all disk-tier and snapshot operations are skipped. */
  private _diskDisabled = false;
  /** Worker pool for off-main-thread AES-GCM (null when workerThreads is false or unavailable). */
  private _workerPool: WorkerPool | null = null;
  private readonly opts: {
    namespace: string;
    logger: ILogger; l1MaxBytes: number; l1MaxEntries: number;
    categoryLimits: Record<string, CategoryLimit>;
    forbiddenSnapshotPrefixes: readonly string[];
    diskCacheDir: string; diskMaxBytes: number; diskEntryMaxBytes: number;
    redisHost: string; redisPort: number; redisTls: boolean; disableRedis: boolean;
    encryptionKey: string | undefined; encryptionMode: 'aes-256-gcm' | 'aes-128-gcm' | 'aes-128-ctr' | 'xor' | undefined; snapshotPath: string; snapshotMaxAgeMs: number;
    invalidationBackplane: boolean;
    oomProtection: boolean; oomHeapThreshold: number;
    oomCheckIntervalMs: number; oomEvictPercent: number;
    onMetrics: ((m: CacheMetrics) => void) | undefined;
    metricsIntervalMs: number;
    staleIfError: number;
    l2WriteMode: 'read-write' | 'read-only';
    instanceName: string;
    l1EvictionWatermark: number;
    ttlJitterFactor: number;
    tracer: ICacheTracer | undefined;
    meter: ICacheMeter | undefined;
    notFoundTtl: number;
    warmKeys: string | undefined;
    onHit: ((key: string, tier: 'l1' | 'disk' | 'l2') => void) | undefined;
    onMiss: ((key: string) => void) | undefined;
    frozen: boolean;
    adaptiveTtl: boolean;
    adaptiveTtlMinMs: number;
    adaptiveTtlMaxMs: number;
    adaptiveTtlMultiplier: number;
    workerThreads: boolean;
    workerThresholdBytes: number;
    workerPoolSize: number;
    backplaneMaxStalenessMs: number;
    disableDisk: boolean;
    redisClusterNodes: Array<{ host: string; port: number }> | undefined;
    redisSentinel: { name: string; sentinels: Array<{ host: string; port: number }> } | undefined;
    redisProtocol: 2 | 3 | undefined;
    useShardedPubSub: boolean;
    compression: CompressionAlgorithm;
    compressionThresholdBytes: number;
    strictSingleton: boolean;
    failClosed: boolean;
    tagStrategy: 'set' | 'generational';
    tagVersionTtlMs: number;
    cloneStrategy: 'none' | 'structuredClone';
    backplaneMode: 'pubsub' | 'stream';
    backplaneStreamMaxLen: number;
    backplaneStreamBlockMs: number;
    backplaneStreamKey?: string;
    serializeToJSON: boolean;
    remoteSnapshot: RemoteSnapshotOptions | undefined;
    crossRegion: CrossRegionRelayOptions | undefined;
    redisClient?: IRedisDriver | any;
    redisSubClient?: IRedisDriver | any;
  };
  /** Pre-computed once — opts.namespace never changes after construction. */
  private readonly _namespace:      string;
  /** Pre-computed once — disableRedis and redisHost never change after construction. */
  private readonly _redisDisabled:  boolean;
  private readonly inflight    = new Map<string, Promise<unknown>>();
  private readonly revalidating = new Set<string>();
  private readonly _l1Counters = new Map<string, { value: number; expiresAt: number }>();
  /** tag → Set of namespaced cache keys; maintained in-process for O(1) invalidateTag() */
  private readonly tagIndex    = new Map<string, Set<string>>();
  /** tag → { version, lastSyncedAt } for generational tag invalidation (bounded to 10,000 entries) */
  private readonly tagVersions = new Map<string, { version: number; lastSyncedAt: number }>();
  /**
   * Dependency index: source glob pattern → Set of namespaced dependent keys.
   * When an exact-key delete matches a registered pattern, all dependents are cascaded.
   */
  private readonly dependencyIndex = new Map<string, Set<string>>();
  private redis:               AnyRedisClient | null = null;
  private redisConnecting:     Promise<AnyRedisClient> | null = null;
  private readonly cb:         L2CircuitBreaker;
  /** In-process mutex lock map for single-process environments or Redis outages. */
  private _localLocks = new Map<string, Promise<void>>();
  /** Active OpenTelemetry monotonic counters. */
  private _otelMetrics: Partial<Record<string, ICacheCounter>> = {};
  private snapshotLoaded       = false;
  private _readyPromise:       Promise<void> = Promise.resolve();
  private cleanupInterval:     ReturnType<typeof setInterval> | null = null;
  private diskJanitorInterval: ReturnType<typeof setInterval> | null = null;
  private oomInterval:         ReturnType<typeof setInterval> | null = null;
  private metricsInterval:     ReturnType<typeof setInterval> | null = null;
  private remoteSnapshotInterval: ReturnType<typeof setInterval> | null = null;
  private _shutdownHandler:    (() => void) | null = null;
  private latencyTracker: LatencyTracker | null = null;
  private readonly instanceId:       string;
  private readonly backplaneChannel: string;
  private readonly backplaneStreamKey: string;
  private subClient:           AnyRedisClient | null = null;
  private streamClient:        AnyRedisClient | null = null;
  private _lastStreamId = '$';
  private _destroyed = false;
  /** Timestamp (Date.now()) when the backplane subscriber last lost its connection. */
  private _subDisconnectedAt:  number | null = null;
  /** Deduplication ring buffer for incoming and outgoing cross-region invalidations (loop prevention) */
  private readonly _seenCrossRegionEvents = new Map<string, number>();
  private counters = {
    gets:             0,
    l1Hits:           0,
    diskHits:         0,
    l2Hits:           0,
    fetches:          0,
    stampedes:        0,
    sets:             0,
    deletes:          0,
    swrRevalidations: 0,
    invSent:          0,
    invReceived:      0,
    invSkipped:       0,
    streamEntriesReceived: 0,
    streamReplays:    0,
    streamGaps:       0,
    oomEvictions:     0,
    oomLastAt:        null as number | null,
    /** Times `increment()` hit a Redis error (fail-open by default, or fail-closed re-throw). */
    counterErrors:    0,
    /** Times a later `create(ns)` call passed options differing from the live singleton. */
    singletonDivergences: 0,
    startedAt:        Date.now(),
    bloomChecks:      0,
    bloomFalsePositives: 0,
    remoteSnapshotUploads:    0,
    remoteSnapshotDownloads:  0,
    remoteSnapshotErrors:     0,
    remoteSnapshotLastUploadedAt:   null as number | null,
    remoteSnapshotLastDownloadedAt: null as number | null,
    crossRegionSent:          0,
    crossRegionReceived:      0,
    crossRegionDeduplicated:  0,
    crossRegionErrors:        0,
  };

  /** One-time guard so the in-process increment() fallback warning fires only once. */
  private _incrementFallbackWarned = false;

  // ── Constructor (use CacheService.create() for the recommended singleton) ──

  constructor(options: CacheOptions = {}) {
    const logger = options.logger ?? consoleLogger;
    this.logger  = logger;

    // Resolve namespace: trim whitespace, default to empty string
    const ns = options.namespace?.trim() ?? '';

    // Resolve encryption key: option > env var
    const encKeyRaw = options.encryptionKey ?? process.env.CACHE_ENCRYPTION_KEY;
    this.enc = new CacheEncryption(
      encKeyRaw,
      logger,
      options.encryptionMode,
      options.previousEncryptionKey,
      options.previousEncryptionMode,
      { strictKeyValidation: options.strictKeyValidation ?? false },
    );

    // When a namespace is active, scope the forbidden prefixes so that
    // auth/session keys like `org_abc:auth:token` are still protected.
    const rawForbidden = options.forbiddenSnapshotPrefixes ?? [...DEFAULT_FORBIDDEN_PREFIXES];
    const forbiddenPrefixes = ns
      ? rawForbidden.map(p => `${ns}:${p}`)
      : rawForbidden;

    // Normalised options with defaults
    this.opts = {
      namespace:                ns,
      logger,
      l1MaxBytes:               options.l1MaxBytes   ?? 200 * 1024 * 1024,
      l1MaxEntries:             options.l1MaxEntries ?? 2_000,
      categoryLimits:           { ...DEFAULT_CATEGORY_LIMITS, ...options.categoryLimits },
      forbiddenSnapshotPrefixes: forbiddenPrefixes,
      // Namespace-isolated defaults: separate dir / snapshot per namespace so
      // two instances with different namespaces never share cache files.
      diskCacheDir:             options.diskCacheDir ?? path.join(
        os.tmpdir(), ns ? `tricache-disk-${ns}` : 'tricache-disk'),
      diskMaxBytes:             options.diskMaxBytes    ?? 500 * 1024 * 1024,
      diskEntryMaxBytes:        options.diskEntryMaxBytes ?? 10 * 1024 * 1024,
      redisHost:                options.redisHost  ?? process.env.REDIS_HOST ?? '',
      redisPort:                options.redisPort  ?? 6379,
      redisTls:                 options.redisTls   ?? (process.env.NODE_ENV === 'production'),
      disableRedis:            options.disableRedis ?? (() => {
        // Auto-disable L2 only when the caller passed NO connectivity config at
        // all (and we're outside production). An explicitly provided host /
        // cluster / sentinel must enable Redis regardless of NODE_ENV — the old
        // env-only check silently ignored a configured redisHost in dev/staging.
        // The REDIS_HOST env fallback does NOT count as explicit: CI exports it
        // globally and unit tests rely on L2 staying off unless asked for.
        const explicitConfig = Boolean(
          options.redisClient || options.redisHost || options.redisClusterNodes?.length || options.redisSentinel,
        );
        return !explicitConfig && process.env.NODE_ENV !== 'production';
      })(),
      encryptionKey:            encKeyRaw,
      encryptionMode:           options.encryptionMode,
      snapshotPath:             options.snapshotPath ?? path.join(
        os.tmpdir(), ns ? `tricache-snapshot-${ns}.msgpack` : 'tricache-snapshot.msgpack'),
      snapshotMaxAgeMs:         options.snapshotMaxAgeMs ?? DEFAULT_SNAPSHOT_MAX_AGE,
      invalidationBackplane:    options.invalidationBackplane ?? true,
      oomProtection:            options.oomProtection      ?? true,
      oomHeapThreshold:         options.oomHeapThreshold   ?? 0.85,
      oomCheckIntervalMs:       options.oomCheckIntervalMs ?? 10_000,
      oomEvictPercent:          options.oomEvictPercent    ?? 0.20,
      onMetrics:                options.onMetrics,
      metricsIntervalMs:        options.metricsIntervalMs  ?? 60_000,
      staleIfError:             options.staleIfError       ?? 0,
      l2WriteMode:              options.l2WriteMode        ?? 'read-write',
      instanceName:             options.instanceName       ?? '',
      l1EvictionWatermark:      Math.min(Math.max(options.l1EvictionWatermark ?? 0.9, 0), 1),
      ttlJitterFactor:          Math.min(Math.max(options.ttlJitterFactor ?? 0, 0), 1),
      tracer:                   options.tracer,
      meter:                    options.meter,
      notFoundTtl:              options.notFoundTtl ?? 0,
      warmKeys:                 options.warmKeys,
      onHit:                    options.onHit,
      onMiss:                   options.onMiss,
      frozen:                   options.frozen ?? false,
      adaptiveTtl:              options.adaptiveTtl ?? false,
      adaptiveTtlMinMs:         (options.adaptiveTtlMin ?? 10)     * 1_000,
      adaptiveTtlMaxMs:         (options.adaptiveTtlMax ?? 86_400) * 1_000,
      adaptiveTtlMultiplier:    options.adaptiveTtlMultiplier ?? 20,
      workerThreads:            options.workerThreads       ?? false,
      workerThresholdBytes:     options.workerThresholdBytes ?? 131_072, // 128 KB
      workerPoolSize:           options.workerPoolSize       ?? 0,       // 0 = auto (min(4, cpus))
      backplaneMaxStalenessMs:  options.backplaneMaxStalenessMs ?? 5_000,
      disableDisk:              options.disableDisk ?? false,
      redisClusterNodes:        options.redisClusterNodes,
      redisSentinel:            options.redisSentinel,
      redisProtocol:            options.redisProtocol,
      useShardedPubSub:         options.useShardedPubSub ?? false,
      compression:              options.compression ?? 'none',
      compressionThresholdBytes: options.compressionThresholdBytes ?? 1024,
      strictSingleton:          options.strictSingleton ?? false,
      failClosed:               options.failClosed ?? false,
      tagStrategy:              options.tagStrategy ?? 'set',
      tagVersionTtlMs:          options.tagVersionTtlMs ?? 5_000,
      cloneStrategy:            options.cloneStrategy ?? 'none',
      backplaneMode:            options.backplaneMode ?? 'pubsub',
      backplaneStreamMaxLen:    options.backplaneStreamMaxLen ?? 10_000,
      backplaneStreamBlockMs:   options.backplaneStreamBlockMs ?? 2_000,
      backplaneStreamKey:       options.backplaneStreamKey,
      serializeToJSON:          options.serializeToJSON ?? true,
      remoteSnapshot:           options.remoteSnapshot,
      crossRegion:              options.crossRegion,
      redisClient:              options.redisClient,
      redisSubClient:           options.redisSubClient,
    };

    this.codec = new CacheCodec({
      useToJSON:  this.opts.serializeToJSON,
      useRecords: true,
      moreTypes:  true,
    });

    // Circuit breaker for L2 Redis
    const cbThreshold  = options.l2CircuitBreakerThreshold  ?? 5;
    const cbCooldownMs = options.l2CircuitBreakerCooldownMs ?? 30_000;
    this.cb = new L2CircuitBreaker(cbThreshold, cbCooldownMs);

    // Adaptive TTL latency tracker (only allocated when the feature is enabled)
    if (this.opts.adaptiveTtl) {
      const samples = options.adaptiveTtlSamples ?? 32;
      const maxKeys = options.adaptiveTtlMaxKeys ?? 5_000;
      this.latencyTracker = new LatencyTracker(samples, maxKeys);
    }

    // ── Fix 3: Serverless / ephemeral-disk detection ──────────────────────────
    // Resolve disk-disabled flag: explicit option wins; else auto-detect runtime.
    let diskDisabled = this.opts.disableDisk;
    if (options.disableDisk === undefined) {
      const serverless = detectServerlessRuntime();
      if (serverless !== null) {
        diskDisabled = true;
        logger.warn('tricache: disk tier auto-disabled (ephemeral filesystem detected)', {
          runtime: serverless,
          hint:    'Set disableDisk: false to override, or disableDisk: true to silence this warning',
        });
      }
    } else if (diskDisabled) {
      logger.info('tricache: disk tier explicitly disabled (disableDisk: true)');
    }
    this._diskDisabled = diskDisabled;

    // L1.5 disk tier (always constructed for metrics shape; ops are no-ops when disabled)
    this.disk = new DiskTier({
      dir:               this.opts.diskCacheDir,
      maxBytes:          this.opts.diskMaxBytes,
      entryMaxBytes:     this.opts.diskEntryMaxBytes,
      forbiddenPrefixes: forbiddenPrefixes,
      encryption:       this.enc.isEnabled ? this.enc : null,
      compression:      this.opts.compression,
      compressionThresholdBytes: this.opts.compressionThresholdBytes,
      logger,
      codec:            this.codec,
    });

    this._namespace     = ns;
    // disableRedis takes unconditional precedence; otherwise, L2 is active when
    // at least one of host / cluster nodes / sentinel is configured.
    this._redisDisabled = this.opts.disableRedis
      || (!this.opts.redisClient && !this.opts.redisHost && !this.opts.redisClusterNodes?.length && !this.opts.redisSentinel);

    // L1 in-memory cache
    this.l1 = new SmartMemoryCache({
      maxBytes:   this.opts.l1MaxBytes,
      maxEntries: this.opts.l1MaxEntries,
      categories: this.opts.categoryLimits,
      evictionWatermark: this.opts.l1EvictionWatermark,
      codec:      this.codec,
      diskSpill: (key: string, entry: SmartCacheEntry) => {
        if (this._diskDisabled) return; // Fix 3: skip spill in serverless environments
        // Defer disk.save() entirely to the next event-loop tick so the synchronous
        // preamble inside save() (SHA-256 keyToPath + msgpackr pack) does not block
        // the l1.set() → smartEvict → diskSpill call chain.  Mirrors what the
        // backplane handler already does for remote invalidations.
        setImmediate(() => { void this.disk.save(key, entry as unknown as DiskCacheEntry); });
      },
      onEviction: options.onEviction,
      logger,
    });

    // Load snapshot once per process
    if (!this.snapshotLoaded) {
      this.snapshotLoaded = true;
      if (!this._diskDisabled) this.loadSnapshot(); // Fix 3: skip in ephemeral environments
    }

    // Graceful shutdown: persist L1 to disk via centralized ProcessTerminationBus.
    // The library must NEVER call process.exit() — that decision belongs to the host application.
    this._shutdownHandler = () => {
      this._triggerShutdown();
    };
    ProcessTerminationBus.register(this);

    // ── Fix 1: Worker thread pool for off-main-thread AES-GCM & Compression ──
    if (this.opts.workerThreads) {
      try {
        const encRef = this.enc.toWorkerInit();
        this._workerPool = new WorkerPool({
          keyBase64:     encRef.keyBase64,
          mode:          encRef.mode as never,
          prevKeyBase64: encRef.prevKeyBase64,
          prevMode:      encRef.prevMode as never,
          compression:   this.opts.compression,
          compressionThresholdBytes: this.opts.compressionThresholdBytes,
          size:          this.opts.workerPoolSize || undefined,
        });
        if (this._workerPool.isAvailable) {
          logger.info('tricache: worker-thread encryption pool active', {
            threshold: `${this.opts.workerThresholdBytes / 1024} KB`,
          });
        } else {
          this._workerPool = null;
          logger.warn('tricache: worker-thread pool requested but unavailable; using main-thread crypto');
        }
      } catch {
        this._workerPool = null;
        logger.warn('tricache: worker-thread pool init failed; using main-thread crypto');
      }
    }

    // Periodic L1 cleanup (5 min): expires stale entries and rebalances frequency counters.
    // Disk cleanup is handled entirely by the janitor below — purgeExpired() is NOT called
    // here to avoid a synchronous O(fileCount) event-loop stall at scale.
    this.cleanupInterval = setInterval(() => {
      const cleaned = this.l1.cleanup();
      if (cleaned > 0) this.logger.debug('Periodic L1 cleanup', { cleaned });
    }, 5 * 60 * 1000);
    if (this.cleanupInterval.unref) this.cleanupInterval.unref(); // don't block process exit

    // Disk janitor (Fix 3: skip when disk is disabled)
    if (!this._diskDisabled) {
      this.diskJanitorInterval = setInterval(() => {
        const purged = this.disk.purgeNextBucket();
        if (purged > 0) this.logger.debug('Disk janitor tick', { purged });
      }, 30_000);
      if (this.diskJanitorInterval.unref) this.diskJanitorInterval.unref();
    }

    // OOM protection: evict coldest L1 entries when heap pressure rises
    if (this.opts.oomProtection) {
      this.oomInterval = setInterval(() => {
        const heap = v8.getHeapStatistics();
        const used = heap.used_heap_size / heap.heap_size_limit;
        if (used >= this.opts.oomHeapThreshold) {
          const evicted = this.l1.evictPercentage(this.opts.oomEvictPercent);
          this.counters.oomEvictions++;
          this.counters.oomLastAt = Date.now();
          this.logger.warn('tricache OOM guard: emergency L1 eviction', {
            heapUsedPct: Math.round(used * 100),
            threshold:   Math.round(this.opts.oomHeapThreshold * 100),
            evicted,
          });
        }
      }, this.opts.oomCheckIntervalMs);
      if (this.oomInterval.unref) this.oomInterval.unref();
    }

    // Metrics callback
    if (this.opts.onMetrics && this.opts.metricsIntervalMs > 0) {
      this.metricsInterval = setInterval(() => {
        try { this.opts.onMetrics!(this.metrics()); } catch { /* never crash process */ }
      }, this.opts.metricsIntervalMs);
      if (this.metricsInterval.unref) this.metricsInterval.unref();
    }

    // Periodic remote snapshot upload (if configured)
    if (this.opts.remoteSnapshot?.intervalMs && this.opts.remoteSnapshot.intervalMs > 0) {
      this.remoteSnapshotInterval = setInterval(() => {
        void this.writeRemoteSnapshot();
      }, this.opts.remoteSnapshot.intervalMs);
      if (this.remoteSnapshotInterval.unref) this.remoteSnapshotInterval.unref();
    }

    // Backplane: assign instance ID + channel + streamKey, then subscribe
    this.instanceId         = crypto.randomBytes(8).toString('hex');
    this.backplaneChannel   = `tricache:inv${ns ? ':' + ns : ''}`;
    this.backplaneStreamKey = options.backplaneStreamKey ?? `tricache:stream:{${ns || 'default'}}`;
    this.initBackplane();

    // Auto-warm from remote snapshot or L2 if configured; ready() waits for completion.
    const startupPromises: Promise<void>[] = [];
    if (this.opts.remoteSnapshot) {
      startupPromises.push(this.loadRemoteSnapshot().then(() => undefined));
    }
    if (this.opts.warmKeys) {
      startupPromises.push(this.warmFromL2(this.opts.warmKeys).then(() => undefined));
    }
    if (startupPromises.length > 0) {
      this._readyPromise = Promise.all(startupPromises).then(() => undefined);
    }

    // Native OpenTelemetry metrics integration
    if (this.opts.meter) {
      this._initOtelMetrics(this.opts.meter);
      const otel = this._otelMetrics;
      const nsAttr = this._namespace ? { namespace: this._namespace } : undefined;
      const targetCounters = this.counters;

      this.counters = new Proxy(targetCounters, {
        set(target, prop, value, receiver) {
          const oldVal = (target as any)[prop];
          const ok = Reflect.set(target, prop, value, receiver);
          if (typeof prop === 'string' && typeof value === 'number' && typeof oldVal === 'number') {
            const diff = value - oldVal;
            if (diff > 0 && otel[prop]) {
              otel[prop]!.add(diff, nsAttr);
            }
          }
          return ok;
        },
      });
    }
  }

  // ── Singleton factory ─────────────────────────────────────────────────────

  /**
   * Get (or create) the process-level singleton CacheService instance.
   *
   * Options are only applied on first call — subsequent calls return the
   * existing instance regardless of options passed. When the new options differ
   * from what the existing singleton was built with, this is a silent no-op by
   * default; set `strictSingleton: true` to throw instead, or watch the
   * `singletonDivergences` metric for detection.
   *
   * When `namespace` is set the singleton is keyed by namespace, so two calls
   * with different namespaces return independent instances.
   */
  static create(options?: CacheOptions): CacheService {
    const g   = globalThis as Record<string, unknown>;
    const key = CacheService.globalKey(options);
    if (!g[key]) {
      g[key] = new CacheService(options);
      return g[key] as CacheService;
    }

    // Singleton already exists for this namespace — detect & surface divergence.
    const existing = g[key] as CacheService;
    const diff = CacheService.optionsDiff(options ?? {}, existing.options);
    if (diff.length > 0) {
      existing.bumpSingletonDivergence();
      const msg = `tricache: singleton already initialised for namespace '${existing.options.namespace || '(default)'}' — ignoring divergent options: ${diff.join(', ')}`;
      if (existing.options.strictSingleton) {
        throw new Error(`strictSingleton: ${msg}`);
      }
      (existing.options.logger ?? consoleLogger).warn(msg, { divergentOptions: diff });
    }
    return existing;
  }

  /**
   * Keys that, if set differently on a later `create()` call, represent a
   * meaningful configuration divergence worth flagging (security/correctness
   * relevant — not cosmetic, e.g. log level).
   */
  private static readonly DIVERGENT_KEYS: Array<keyof CacheOptions> = [
    'redisHost', 'redisPort', 'redisTls', 'disableRedis',
    'redisClusterNodes', 'redisSentinel', 'encryptionKey', 'encryptionMode',
    'l1MaxBytes', 'l1MaxEntries', 'namespace', 'frozen', 'adaptiveTtl',
    'l2WriteMode', 'instanceName', 'invalidationBackplane',
  ];

  /** Returns the names of options that differ between `a` and the live `b`. */
  private static optionsDiff(a: CacheOptions, b: CacheOptions): string[] {
    const out: string[] = [];
    for (const k of CacheService.DIVERGENT_KEYS) {
      const av = a[k];
      const bv = (b as Record<string, unknown>)[k as string];
      // Treat undefined (not passed) as "no opinion" — only flag explicit conflicts.
      if (av === undefined) continue;
      const same =
        JSON.stringify(av) === JSON.stringify(bv) ||
        (k === 'encryptionKey' && av === bv);
      if (!same) out.push(String(k));
    }
    return out;
  }

  /** Increment the singleton-divergence counter (surfaced in `metrics()`). */
  bumpSingletonDivergence(): void {
    this.counters.singletonDivergences++;
  }

  /** Read-only view of the options the singleton was constructed with. */
  get options(): CacheOptions {
    const o = this.opts;
    return {
      namespace:           o.namespace,
      logger:              o.logger,
      l1MaxBytes:          o.l1MaxBytes,
      l1MaxEntries:        o.l1MaxEntries,
      redisHost:           o.redisHost,
      redisPort:           o.redisPort,
      redisTls:            o.redisTls,
      disableRedis:        this._redisDisabled,
      redisClusterNodes:   o.redisClusterNodes,
      redisSentinel:       o.redisSentinel,
      // Never surface key material through diagnostics — a JSON.stringify of
      // this object previously leaked the raw encryption key.
      encryptionKey:       o.encryptionKey ? '[REDACTED]' : undefined,
      encryptionMode:      o.encryptionMode,
      l2WriteMode:         o.l2WriteMode,
      instanceName:        o.instanceName,
      frozen:              o.frozen,
      adaptiveTtl:         o.adaptiveTtl,
      invalidationBackplane: o.invalidationBackplane,
      strictSingleton:     o.strictSingleton,
      remoteSnapshot:      o.remoteSnapshot,
      crossRegion:         o.crossRegion,
    } as CacheOptions;
  }

  /**
   * Async factory — accepts a Promise that resolves to CacheOptions.
   * Useful when config is fetched from a secret store at startup.
   *
   * @example
   * const cache = await CacheService.createAsync(fetchSecrets());
   */
  static async createAsync(options: Promise<CacheOptions> | CacheOptions): Promise<CacheService> {
    const resolved = await options;
    return CacheService.create(resolved);
  }

  /** Replace the singleton (useful in tests). */
  static reset(options?: CacheOptions): CacheService {
    const g   = globalThis as Record<string, unknown>;
    const key = CacheService.globalKey(options);
    const existing = g[key] as CacheService | undefined;
    if (existing) existing.destroy();
    g[key] = new CacheService(options);
    return g[key] as CacheService;
  }

  /** Derive the globalThis key for a given set of options. */
  private static globalKey(options?: CacheOptions): string {
    const ns = options?.namespace?.trim() ?? '';
    return ns ? `__tricache_${ns}__` : GLOBAL_KEY;
  }

  // ── Redis connection ──────────────────────────────────────────────────────

  /**
   * Prepend the configured namespace to a raw cache key.
   * Returns the key unchanged when namespace is empty.
   *
   * This is the only place the namespace prefix is applied — callers always
   * receive and provide un-prefixed keys in the public API.
   */
  private nk(key: string): string {
    return this._namespace ? `${this._namespace}:${key}` : key;
  }

  /** Strip the instance namespace prefix from a namespaced key (inverse of `nk`). */
  private unnk(key: string): string {
    return this._namespace ? key.slice(this._namespace.length + 1) : key;
  }

  /** Apply TTL jitter: multiply ttlMs by (1 ± jitterFactor). */
  private _jitterTtl(ttlMs: number): number {
    const j = this.opts.ttlJitterFactor;
    if (j === 0) return ttlMs;
    const rand = (crypto.randomInt(0, 100_000) / 50_000) - 1; // uniform [-1.0, +1.0)
    return Math.round(ttlMs * (1 + rand * j));
  }

  /** Shared no-op span for the common case where no tracer is configured.
   *  Using a singleton avoids allocating a fresh object literal on every get/set/delete call. */
  private static readonly _nullSpan: ICacheSpan = {
    setAttribute() { return this; },
    setStatus()    { return this; },
    recordException() { return this; },
    end()          {},
  };

  /** Start an OTEL-compatible span if a tracer is configured. Returns a no-op span otherwise. */
  private _startSpan(name: string, links?: ICacheSpanLink[]): ICacheSpan {
    if (this.opts.tracer) {
      const span = this.opts.tracer.startSpan(name, links?.length ? { links } : undefined);
      if (this.opts.namespace) {
        span.setAttribute('cache.namespace', this.opts.namespace);
      }
      return span;
    }
    return CacheService._nullSpan;
  }

  private createDedicatedRedisClient(): AnyRedisClient {
    if (this.opts.redisSubClient) {
      return this.opts.redisSubClient;
    }
    if (this.opts.redisClient && typeof this.opts.redisClient.duplicate === 'function') {
      return this.opts.redisClient.duplicate();
    }
    if (this.opts.redisClusterNodes?.length) {
      return new RedisCluster(this.opts.redisClusterNodes, {
        redisOptions: {
          tls:                  this.opts.redisTls ? {} : undefined,
          connectTimeout:       10_000,
          maxRetriesPerRequest: null as unknown as number,
          ...(this.opts.redisProtocol && { protocol: this.opts.redisProtocol }),
        },
      });
    } else if (this.opts.redisSentinel) {
      return new RedisClient({
        sentinels:            this.opts.redisSentinel.sentinels,
        name:                 this.opts.redisSentinel.name,
        tls:                  this.opts.redisTls ? {} : undefined,
        connectTimeout:       10_000,
        lazyConnect:          true,
        maxRetriesPerRequest: null as unknown as number,
        enableAutoPipelining: false,
        retryStrategy:        (times: number) => Math.min(times * 50, 2_000),
        ...(this.opts.redisProtocol && { protocol: this.opts.redisProtocol }),
      });
    } else {
      return new RedisClient({
        host:                 this.opts.redisHost,
        port:                 this.opts.redisPort,
        tls:                  this.opts.redisTls ? {} : undefined,
        connectTimeout:       10_000,
        lazyConnect:          true,
        maxRetriesPerRequest: null as unknown as number,
        enableAutoPipelining: false,
        family:               4,
        retryStrategy:        (times: number) => Math.min(times * 50, 2_000),
        ...(this.opts.redisProtocol && { protocol: this.opts.redisProtocol }),
      });
    }
  }

  private initBackplane(): void {
    if (!this.opts.invalidationBackplane || this._redisDisabled) return;

    if (this.opts.backplaneMode === 'stream') {
      if (this.streamClient) return;
      void this._startStreamConsumer();
      return;
    }

    if (this.subClient) return;

    const sub = this.createDedicatedRedisClient();

    sub.on('error', (e: Error) => {
      this._checkAndLogResp3Hint(e);
      this.logger.debug('Backplane subscriber error', { error: e.message });
    });

    // ── Staleness fence — track disconnect time ──────────────────────
    sub.on('close', () => {
      if (this._subDisconnectedAt === null) {
        this._subDisconnectedAt = Date.now();
        this.logger.debug('Backplane: subscriber disconnected', { at: this._subDisconnectedAt });
      }
    });

    sub.on('ready', () => {
      if (this._subDisconnectedAt !== null && this.opts.backplaneMaxStalenessMs > 0) {
        const gapMs = Date.now() - this._subDisconnectedAt;
        if (gapMs > this.opts.backplaneMaxStalenessMs) {
          const evicted = this.l1.evictSetBefore(this._subDisconnectedAt);
          this.logger.warn('Backplane: reconnect after gap — flushed potentially stale L1 entries', {
            gapMs, evicted,
            hint: 'Increase backplaneMaxStalenessMs or set to 0 to disable the fence',
          });
        }
        this._subDisconnectedAt = null;
      }
    });

    const isClusterSharded = Boolean(this.opts.useShardedPubSub && this.opts.redisClusterNodes?.length);

    if (isClusterSharded) {
      sub.on('smessage', (_channel: string, message: string) => {
        this._handleBackplaneMessage(message);
      });
      (sub as unknown as { ssubscribe: (c: string) => Promise<unknown> })
        .ssubscribe(this.backplaneChannel)
        .then(() => this.logger.info('Backplane: sharded subscribed', {
          channel: this.backplaneChannel, instanceId: this.instanceId,
        }))
        .catch((err: Error) => this.logger.warn('Backplane: sharded subscribe failed', {
          error: err.message,
        }));
    } else {
      sub.on('message', (_channel: string, message: string) => {
        this._handleBackplaneMessage(message);
      });
      sub.subscribe(this.backplaneChannel)
        .then(() => this.logger.info('Backplane: subscribed', {
          channel: this.backplaneChannel, instanceId: this.instanceId,
        }))
        .catch((err: Error) => this.logger.warn('Backplane: subscribe failed', {
          error: err.message,
        }));
    }

    this.subClient = sub;
  }

  private async _startStreamConsumer(): Promise<void> {
    const sub = this.streamClient ?? this.createDedicatedRedisClient();
    this.streamClient = sub;

    if (typeof (sub as any).on === 'function') {
      sub.on('error', (e: Error) =>
        this.logger.debug('Backplane stream consumer error', { error: e.message }));

      sub.on('close', () => {
        if (this._subDisconnectedAt === null) {
          this._subDisconnectedAt = Date.now();
          this.logger.debug('Backplane stream: consumer disconnected', { at: this._subDisconnectedAt });
        }
      });

      sub.on('ready', () => {
        if (this._subDisconnectedAt !== null) {
          this.logger.debug('Backplane stream: consumer reconnected, resuming stream read', { lastId: this._lastStreamId });
          this._subDisconnectedAt = null;
        }
      });
    }

    // Continuous async worker loop
    const runLoop = async () => {
      while (!this._destroyed && !this._redisDisabled) {
        try {
          const res = await (sub as any).xread(
            'BLOCK', this.opts.backplaneStreamBlockMs,
            'STREAMS', this.backplaneStreamKey, this._lastStreamId,
          ) as Array<[string, Array<[string, string[]]>]> | null;

          if (this._destroyed) break;

          if (res && res.length > 0) {
            for (const [, entries] of res) {
              if (entries.length > 0) {
                if (this._lastStreamId !== '$') {
                  this.counters.streamReplays++;
                }

                for (const [id, fields] of entries) {
                  this._lastStreamId = id;
                  this.counters.streamEntriesReceived++;
                  this._processStreamEntry(fields);
                }
              }
            }
          } else {
            // Idle timeout without messages — yield briefly before next long-poll
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        } catch (err) {
          if (this._destroyed) break;
          const msg = (err as Error).message ?? '';
          if (msg.includes('NOGROUP') || msg.includes('smaller than') || msg.includes('trimmed')) {
            this.counters.streamGaps++;
            this.l1.clear();
            this._lastStreamId = '$';
          }
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
    };

    void runLoop();
  }

  /**
   * Validate + apply one XREAD stream entry. `fields` is the flat ioredis
   * shape [name, value, name, value, …]. Mirrors the schema rules of the
   * pubsub path (`_handleBackplaneMessage`): op must be a known operation,
   * key/src must be non-empty strings, tagVersion must parse to a finite
   * number. Invalid entries are logged and dropped — never applied.
   */
  /** @internal Exposed for testing. */
  _processStreamEntry(fields: string[]): void {
    let op = '';
    let key = '';
    let src = '';
    let tagVersionRaw: string | undefined;

    for (let i = 0; i + 1 < fields.length; i += 2) {
      const f = fields[i];
      const v = fields[i + 1];
      if (f === 'op') op = v;
      else if (f === 'key') key = v;
      else if (f === 'src') src = v;
      else if (f === 'tagVersion') tagVersionRaw = v;
    }

    const validOp = op === 'del' || op === 'del-glob' || op === 'tag_incr';
    if (!validOp || typeof key !== 'string' || !key || typeof src !== 'string') {
      this.logger.warn('Backplane: rejected invalid stream entry', {
        op: String(op).slice(0, 40),
        key: typeof key === 'string' ? key.slice(0, 100).replace(/[\r\n\t]/g, ' ') : String(key),
      });
      return;
    }

    // parseInt('12abc34') → NaN — reject instead of poisoning the version map.
    let tagVersion: number | undefined;
    if (tagVersionRaw !== undefined) {
      const parsed = parseInt(tagVersionRaw, 10);
      if (!Number.isFinite(parsed)) {
        this.logger.warn('Backplane: rejected stream entry with non-numeric tagVersion', { key });
        return;
      }
      tagVersion = parsed;
    }

    if (src === this.instanceId) {
      this.counters.invSkipped++;
      return;
    }

    this.counters.invReceived++;
    this._applyInvalidationEvent(op, key, tagVersion);
  }

  private _applyInvalidationEvent(op: string, key: string, tagVersion?: number): void {
    if (op === 'del') {
      this.l1.delete(key);
      setImmediate(() => { if (!this._diskDisabled) this.disk.delete(key); });
      this._cascadeDependencies(key);
    } else if (op === 'del-glob') {
      this.l1.deletePattern(key);
    } else if (op === 'tag_incr') {
      const tag = key;
      const ver = typeof tagVersion === 'number' ? tagVersion : ((this.tagVersions.get(tag)?.version ?? 0) + 1);
      this._setLocalTagVersion(tag, ver, Date.now());
    }
    this.logger.debug('Backplane: invalidation applied', { op, key: key.slice(0, 60) });
  }

  /** @internal Exposed for testing. Applies a raw backplane JSON message to local state. */
  _handleBackplaneMessage(message: string): void {
    try {
      const msg = JSON.parse(message);
      if (
        !msg ||
        typeof msg !== 'object' ||
        Array.isArray(msg) ||
        typeof msg.src !== 'string' ||
        typeof msg.key !== 'string' ||
        (msg.op !== 'del' && msg.op !== 'del-glob' && msg.op !== 'tag_incr')
      ) {
        this.logger.warn('Backplane: rejected invalid pubsub message format', {
          raw: typeof message === 'string' ? message.slice(0, 100).replace(/[\r\n\t]/g, ' ') : String(message),
        });
        return;
      }
      if (msg.src === this.instanceId) {
        this.counters.invSkipped++;
        return; // own message — our L1 is already current
      }
      this.counters.invReceived++;
      this._applyInvalidationEvent(msg.op, msg.key, typeof msg.tagVersion === 'number' ? msg.tagVersion : undefined);
    } catch {
      this.logger.warn('Backplane: malformed message JSON parse failed');
    }
  }

  private async publishInvalidation(
    op: 'del' | 'del-glob' | 'tag_incr',
    key: string,
    tagVersion?: number,
    isCrossRegionRelay = false,
    isExplicitInvalidation = false,
  ): Promise<void> {
    if (!isCrossRegionRelay && this.opts.crossRegion) {
      const shouldBroadcast = isExplicitInvalidation || Boolean(this.opts.crossRegion.broadcastOnSet);
      if (shouldBroadcast) {
        void this._broadcastCrossRegion(op, key, tagVersion);
      }
    }
    if (!this.opts.invalidationBackplane || this._redisDisabled) return;
    try {
      const client = await this.getRedis();

      if (this.opts.backplaneMode === 'stream') {
        const args: string[] = [
          this.backplaneStreamKey,
          'MAXLEN', '~', String(this.opts.backplaneStreamMaxLen),
          '*',
          'op', op,
          'key', key,
          'src', this.instanceId,
        ];
        if (typeof tagVersion === 'number') {
          args.push('tagVersion', String(tagVersion));
        }
        await (client as any).xadd(...args);
        this.counters.invSent++;
        return;
      }

      const payload = JSON.stringify({ op, key, src: this.instanceId, tagVersion });
      const isClusterSharded = Boolean(this.opts.useShardedPubSub && this.opts.redisClusterNodes?.length);
      if (isClusterSharded && typeof (client as unknown as { spublish?: unknown }).spublish === 'function') {
        await (client as unknown as { spublish: (c: string, m: string) => Promise<unknown> }).spublish(
          this.backplaneChannel,
          payload,
        );
      } else {
        await client.publish(
          this.backplaneChannel,
          payload,
        );
      }
      this.counters.invSent++;
    } catch { /* non-critical — never block the caller */ }
  }

  private _markCrossRegionEventSeen(id: string): void {
    const maxDedup = this.opts.crossRegion?.dedupCacheSize ?? 10_000;
    if (this._seenCrossRegionEvents.size >= maxDedup) {
      const oldestKey = this._seenCrossRegionEvents.keys().next().value;
      if (oldestKey !== undefined) this._seenCrossRegionEvents.delete(oldestKey);
    }
    this._seenCrossRegionEvents.set(id, Date.now());
  }

  private _isCrossRegionEventSeen(id: string): boolean {
    return this._seenCrossRegionEvents.has(id);
  }

  private async _broadcastCrossRegion(
    op: 'del' | 'del-glob' | 'tag_incr',
    key: string,
    tagVersion?: number,
  ): Promise<void> {
    const cr = this.opts.crossRegion;
    if (!cr) return;
    try {
      const eventId = crypto.randomUUID();
      this._markCrossRegionEventSeen(eventId);
      const event: CrossRegionInvalidationEvent = {
        id: eventId,
        originRegion: cr.currentRegion,
        originInstanceId: this.instanceId,
        op,
        key,
        tagVersion,
        timestamp: Date.now(),
        namespace: this._namespace || undefined,
      };
      this.counters.crossRegionSent++;
      await cr.relay.broadcast(event);
      this.logger.debug('Cross-region invalidation broadcast', { op, key, region: cr.currentRegion });
    } catch (err) {
      this.counters.crossRegionSent = Math.max(0, this.counters.crossRegionSent - 1);
      this.counters.crossRegionErrors++;
      this.logger.warn('Cross-region invalidation broadcast failed', { error: (err as Error).message });
    }
  }

  /**
   * Receives an invalidation event from another region (e.g. via HTTP webhook or broker subscriber).
   * Validates origin, deduplicates to prevent loops, applies locally to L1/disk,
   * and fans out to the local Redis backplane so all regional peers invalidate as well.
   *
   * Returns true if the event was accepted and applied, or false if ignored/deduplicated.
   */
  async receiveCrossRegionInvalidation(event: CrossRegionInvalidationEvent): Promise<boolean> {
    const cr = this.opts.crossRegion;
    if (!cr) return false;

    // Reject malformed event
    if (!event || typeof event !== 'object' || !event.id || !event.originRegion || !event.op || !event.key) {
      this.counters.crossRegionErrors++;
      this.logger.warn('Cross-region: rejected invalid event payload', { event });
      return false;
    }

    // Ignore events originating from our own region (prevents echo loops)
    if (event.originRegion === cr.currentRegion) {
      this.counters.crossRegionDeduplicated++;
      return false;
    }

    // Ignore duplicate event IDs (already processed)
    if (this._isCrossRegionEventSeen(event.id)) {
      this.counters.crossRegionDeduplicated++;
      return false;
    }
    this._markCrossRegionEventSeen(event.id);

    // If namespaces don't match, ignore
    if (event.namespace !== undefined && event.namespace !== (this._namespace || undefined)) {
      return false;
    }

    this.counters.crossRegionReceived++;

    // 1. Apply to local L1 and disk
    this._applyInvalidationEvent(event.op, event.key, event.tagVersion);

    // 2. Propagate to local Redis backplane so other instances in THIS region also invalidate,
    // passing isCrossRegionRelay = true to prevent re-broadcasting cross-region
    void this.publishInvalidation(event.op, event.key, event.tagVersion, true);

    this.logger.info('Cross-region invalidation applied', {
      op: event.op,
      key: event.key,
      originRegion: event.originRegion,
    });
    return true;
  }

  private _setLocalTagVersion(tag: string, version: number, now = Date.now()): void {
    const existing = this.tagVersions.get(tag)?.version ?? 0;
    const finalVersion = Math.max(existing, version);
    if (this.tagVersions.size >= 10_000 && !this.tagVersions.has(tag)) {
      const oldestKey = this.tagVersions.keys().next().value;
      if (oldestKey !== undefined) this.tagVersions.delete(oldestKey);
    }
    this.tagVersions.set(tag, { version: finalVersion, lastSyncedAt: now });
  }

  private async _getTagVersion(tag: string): Promise<number> {
    const now = Date.now();
    const local = this.tagVersions.get(tag);
    if (local && (now - local.lastSyncedAt < this.opts.tagVersionTtlMs)) {
      return local.version;
    }
    if (!this._redisDisabled) {
      try {
        const client = await this.getRedis();
        const raw = await client.get(this.nk(`tag_ver:${tag}`));
        const version = raw ? parseInt(raw, 10) : 0;
        this._setLocalTagVersion(tag, version, now);
        return version;
      } catch {
        /* fallback to local */
      }
    }
    return local?.version ?? 0;
  }

  private _deleteIfStale(k: string, setAtMs: number): void {
    this.l1.deleteIfSetBefore(k, setAtMs);
    if (!this._diskDisabled) this.disk.delete(k);
    if (!this._redisDisabled && this.opts.l2WriteMode === 'read-write') {
      void this.getRedis().then(client => {
        return client.eval(LUA_COMPARE_AND_DELETE, 1, k, String(setAtMs));
      }).catch(() => {});
    }
  }

  /**
   * Serialize payload for L2 Redis storage applying compression and encryption as configured.
   * Offloads to worker thread if pool is active and payload exceeds threshold.
   */
  private async _serializeAndEncrypt(serialized: string): Promise<string> {
    const isCompressed = this.opts.compression && this.opts.compression !== 'none' && serialized.length > this.opts.compressionThresholdBytes;
    if (this._workerPool && (this.enc.isEnabled || isCompressed) && serialized.length > this.opts.workerThresholdBytes) {
      return this._workerPool.encrypt(serialized);
    }
    if (isCompressed) {
      const compressed = compressBuffer(Buffer.from(serialized, 'utf8'), this.opts.compression);
      if (this.enc.isEnabled) {
        const encrypted = this.enc.encryptBuffer(compressed);
        return PREFIX_ENC_COMPRESSED + encrypted.toString('base64');
      }
      return PREFIX_COMPRESSED + compressed.toString('base64');
    }
    return this.enc.isEnabled ? this.enc.encrypt(serialized) : serialized;
  }

  /**
   * Deserialize raw L2 Redis entry applying decryption and decompression as needed.
   * Offloads to worker thread if pool is active and payload exceeds threshold.
   */
  private async _decryptAndDeserialize<T>(raw: string): Promise<T> {
    let plain: string;
    if (this._workerPool && raw.length > this.opts.workerThresholdBytes) {
      plain = await this._workerPool.decrypt(raw);
    } else if (raw.startsWith(PREFIX_ENC_COMPRESSED)) {
      const encBuf = Buffer.from(raw.slice(PREFIX_ENC_COMPRESSED.length), 'base64');
      const decBuf = this.enc.decryptBuffer(encBuf);
      const decompressed = decompressBuffer(decBuf, this.opts.compression !== 'none' ? this.opts.compression : 'brotli');
      plain = decompressed.toString('utf8');
    } else if (raw.startsWith(PREFIX_COMPRESSED)) {
      const cmpBuf = Buffer.from(raw.slice(PREFIX_COMPRESSED.length), 'base64');
      const decompressed = decompressBuffer(cmpBuf, this.opts.compression !== 'none' ? this.opts.compression : 'brotli');
      plain = decompressed.toString('utf8');
    } else if (raw.startsWith('enc:v1:') || this.enc.isEnabled) {
      plain = this.enc.decrypt(raw);
    } else {
      plain = raw;
    }
    return JSON.parse(plain) as T;
  }

  /**
   * Scan all keys matching `pattern` across single-node or Cluster clients.
   * For Cluster, iterates every master node independently (SCAN is node-local).
   */
  private async _scanKeys(client: AnyRedisClient, pattern: string): Promise<string[]> {
    const keys: string[] = [];
    if (client instanceof RedisCluster) {
      const masters = client.nodes('master');
      await Promise.all(masters.map((node: RedisClient) =>
        new Promise<void>((resolve, reject) => {
          const stream = node.scanStream({ match: pattern, count: 100 });
          stream.on('data',  (chunk: string[]) => keys.push(...chunk));
          stream.on('end',   resolve);
          stream.on('error', reject);
        }),
      ));
    } else if (typeof (client as any).scanStream === 'function') {
      await new Promise<void>((resolve, reject) => {
        const stream = (client as any).scanStream({ match: pattern, count: 100 });
        stream.on('data',  (chunk: string[]) => keys.push(...chunk));
        stream.on('end',   resolve);
        stream.on('error', reject);
      });
    } else if (typeof (client as any).scanIterator === 'function') {
      for await (const key of (client as any).scanIterator({ MATCH: pattern, COUNT: 100 })) {
        keys.push(key);
      }
    } else if (typeof (client as any).scan === 'function') {
      let cursor = '0';
      do {
        const res = await (client as any).scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = String(res[0]);
        const chunk = res[1] as string[];
        if (chunk?.length) keys.push(...chunk);
      } while (cursor !== '0');
    }
    return keys;
  }

  private _checkAndLogResp3Hint(err: Error): void {
    const msg = err?.message || '';
    if (
      !this.opts.redisProtocol &&
      (msg.includes('unknown command') ||
       msg.includes('HELLO') ||
       msg.includes('protocol error') ||
       msg.includes('ProtocolError') ||
       msg.includes('Connection is closed'))
    ) {
      this.logger.warn(
        'Redis connection/protocol error detected. If your Redis endpoint or proxy (e.g. Twemproxy, Envoy, older ElastiCache) does not support RESP3, set redisProtocol: 2 in CacheOptions to force RESP2 compatibility.',
        { hint: 'redisProtocol: 2', originalError: msg },
      );
    }
  }

  private async getRedis(): Promise<AnyRedisClient> {
    if (!this.cb.isAllowed()) throw new Error('tricache: L2 circuit breaker is open');
    if (this.redis) return this.redis;
    if (this.redisConnecting) return this.redisConnecting;

    if (this.opts.redisClient) {
      const client = this.opts.redisClient;
      if (typeof client.connect === 'function' && client.isOpen === false) {
        await client.connect();
      }
      this.cb.onSuccess();
      this.redis = client;
      return client;
    }

    this.redisConnecting = (async () => {
      try {
        // ── Fix 4: Cluster / Sentinel / single-node connection factory ──────
        let client: AnyRedisClient;

        if (this.opts.redisClusterNodes?.length) {
          // Redis Cluster — ioredis handles slot routing and multi-node pooling.
          client = new RedisCluster(this.opts.redisClusterNodes, {
            redisOptions: {
              tls:                  this.opts.redisTls ? {} : undefined,
              connectTimeout:       10_000,
              maxRetriesPerRequest: 3,
              keepAlive:            30_000,
              ...(this.opts.redisProtocol && { protocol: this.opts.redisProtocol }),
            },
            enableAutoPipelining: true,
            retryDelayOnClusterDown: 200,
            retryDelayOnFailover:    1_000,
          });
          client.on('connect',      () => this.logger.info('Redis Cluster connected'));
          client.on('error',        (e: Error) => {
            this._checkAndLogResp3Hint(e);
            this.logger.error('Redis Cluster error', {}, e);
          });
          client.on('reconnecting', () => this.logger.debug('Redis Cluster reconnecting'));
        } else if (this.opts.redisSentinel) {
          // Redis Sentinel — ioredis monitors master via sentinel topology.
          client = new RedisClient({
            sentinels:             this.opts.redisSentinel.sentinels,
            name:                  this.opts.redisSentinel.name,
            tls:                   this.opts.redisTls ? {} : undefined,
            connectTimeout:        10_000,
            lazyConnect:           false,
            maxRetriesPerRequest:  3,
            enableAutoPipelining:  true,
            keepAlive:             30_000,
            retryStrategy: (times: number) => Math.min(times * 50, 2_000),
            ...(this.opts.redisProtocol && { protocol: this.opts.redisProtocol }),
          });
          client.on('connect',      () => this.logger.info('Redis Sentinel connected', { name: this.opts.redisSentinel!.name }));
          client.on('error',        (e: Error) => {
            this._checkAndLogResp3Hint(e);
            this.logger.error('Redis Sentinel error', { name: this.opts.redisSentinel!.name }, e);
          });
          client.on('reconnecting', () => this.logger.debug('Redis Sentinel reconnecting'));
        } else {
          // Single-node (original path)
          client = new RedisClient({
            host:                  this.opts.redisHost,
            port:                  this.opts.redisPort,
            tls:                   this.opts.redisTls ? {} : undefined,
            connectTimeout:        10_000,
            lazyConnect:           false,
            maxRetriesPerRequest:  3,
            enableAutoPipelining:  true,
            keepAlive:             30_000,
            family:                4,
            retryStrategy: (times: number) => Math.min(times * 50, 2_000),
            ...(this.opts.redisProtocol && { protocol: this.opts.redisProtocol }),
          });
          client.on('connect',      () => this.logger.info('Redis connected', { host: this.opts.redisHost }));
          client.on('error',        (e: Error) => {
            this._checkAndLogResp3Hint(e);
            this.logger.error('Redis error', { host: this.opts.redisHost }, e);
          });
          client.on('reconnecting', () => this.logger.debug('Redis reconnecting'));
        }

        await new Promise<void>((resolve, reject) => {
          client.once('ready', resolve);
          client.once('error', (e: Error) => {
            this._checkAndLogResp3Hint(e);
            reject(e);
          });
          setTimeout(() => reject(new Error('Redis connection timeout')), 15_000);
        });

        this.cb.onSuccess();
        this.redis = client;
        this.redisConnecting = null;
        return client;
      } catch (err) {
        this.cb.onFailure();
        this.redisConnecting = null; // allow retry on next call — fixes the cached-rejection bug
        this._checkAndLogResp3Hint(err as Error);
        throw err;
      }
    })();

    return this.redisConnecting;
  }

  // ── Snapshot (cold-start persistence) ────────────────────────────────────

  /**
   * Writes the cold-start snapshot to disk.
   * NOTE: fs.writeFileSync is INTENTIONAL here: this method is invoked during SIGTERM/SIGINT
   * process termination hooks where asynchronous I/O would risk the Node.js event loop dying or
   * process.exit() being called before the snapshot is physically written to disk.
   */
  writeSnapshot(altPath?: string): void {
    try {
      const entries = this.l1.exportEntries(this.opts.forbiddenSnapshotPrefixes);
      if (entries.length === 0) return;

      const payload = { version: SNAPSHOT_VERSION, writtenAt: Date.now(), entries };
      const packed  = this.codec.encode(payload);
      const final   = this.enc.isEnabled ? this.enc.encryptBuffer(packed) : packed;
      const dest    = altPath ?? this.opts.snapshotPath;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, final, { mode: 0o600 });
      this.logger.info('Cache snapshot written', {
        path: dest, entries: entries.length,
        sizeKB: Math.round(final.length / 1024), encrypted: this.enc.isEnabled,
      });
    } catch (err) {
      this.logger.warn('Cache snapshot write failed', { error: (err as Error).message });
    }
  }

  /**
   * Loads cold-start snapshot from disk into L1 memory.
   * NOTE: fs.readFileSync is INTENTIONAL here: this method is invoked synchronously inside the
   * CacheService constructor so that the cache is atomically populated before any subsequent
   * cache.get() or cache.set() operations run, eliminating cold-start race conditions.
   */
  loadSnapshot(): void {
    const snapshotPath = this.opts.snapshotPath;
    try {
      if (!fs.existsSync(snapshotPath)) return;

      const stat = fs.statSync(snapshotPath);
      if (stat.size > SNAPSHOT_MAX_FILE_BYTES) {
        this.logger.warn('Snapshot rejected: exceeds size limit', { sizeBytes: stat.size });
        fs.unlinkSync(snapshotPath);
        return;
      }

      const raw = fs.readFileSync(snapshotPath);
      fs.unlinkSync(snapshotPath); // delete immediately — don't leave cache data on disk

      let buf: Buffer;
      try { buf = this.enc.decryptBuffer(raw); } catch (e) {
        this.logger.warn('Snapshot rejected: decryption failed', { error: (e as Error).message });
        return;
      }

      const snapshot = this.codec.decode(buf) as {
        version?: number; writtenAt?: number;
        entries?: Array<{ key: string; entry: SmartCacheEntry }>;
      };

      if (!snapshot || snapshot.version !== SNAPSHOT_VERSION) {
        this.logger.warn('Snapshot rejected: version mismatch', { got: snapshot?.version });
        return;
      }

      const ageMs = Date.now() - (snapshot.writtenAt ?? 0);
      if (ageMs > this.opts.snapshotMaxAgeMs || ageMs < 0) {
        this.logger.warn('Snapshot rejected: too old', { ageMinutes: Math.round(ageMs / 60000) });
        return;
      }

      if (!Array.isArray(snapshot.entries)) {
        this.logger.warn('Snapshot rejected: entries is not an array');
        return;
      }

      const loaded = this.l1.importEntries(snapshot.entries, this.opts.forbiddenSnapshotPrefixes);
      this.logger.info('Cache snapshot loaded (L1 is warm)', {
        loaded, total: snapshot.entries.length,
        sizeKB: this.l1.getStats().sizeKB,
      });
    } catch (err) {
      this.logger.warn('Snapshot load failed — starting cold', { error: (err as Error).message });
      try { fs.unlinkSync(snapshotPath); } catch { /* ok */ }
    }
  }

  // ── Remote Snapshot (cold-start persistence for stateless containers) ───────

  /**
   * Persists the cold-start snapshot to remote blob storage (S3, GCS, R2, HTTP).
   * Can be awaited during graceful application shutdown (e.g. Kubernetes preStop or NestJS shutdown).
   * Returns true if a snapshot was successfully exported and written; false otherwise.
   */
  async writeRemoteSnapshot(): Promise<boolean> {
    if (!this.opts.remoteSnapshot) return false;
    try {
      const entries = this.l1.exportEntries(this.opts.forbiddenSnapshotPrefixes);
      if (entries.length === 0) return false;

      const payload = { version: SNAPSHOT_VERSION, writtenAt: Date.now(), entries };
      const packed  = this.codec.encode(payload);
      const final   = this.enc.isEnabled ? this.enc.encryptBuffer(packed) : packed;

      await this.opts.remoteSnapshot.adapter.put(final);
      this.counters.remoteSnapshotUploads++;
      this.counters.remoteSnapshotLastUploadedAt = Date.now();
      this.logger.info('Remote cache snapshot uploaded', {
        entries:   entries.length,
        sizeKB:    Math.round(final.length / 1024),
        encrypted: this.enc.isEnabled,
      });
      return true;
    } catch (err) {
      this.counters.remoteSnapshotErrors++;
      this.logger.warn('Remote cache snapshot upload failed', { error: (err as Error).message });
      return false;
    }
  }

  /**
   * Hydrates L1 memory from remote blob storage (S3, GCS, R2, HTTP).
   * Called automatically during startup (chained into `cache.ready()`).
   * Returns the number of entries successfully imported.
   */
  async loadRemoteSnapshot(): Promise<number> {
    if (!this.opts.remoteSnapshot) return 0;
    const maxAgeMs = this.opts.remoteSnapshot.maxAgeMs ?? this.opts.snapshotMaxAgeMs ?? DEFAULT_SNAPSHOT_MAX_AGE;
    try {
      const raw = await this.opts.remoteSnapshot.adapter.get();
      if (!raw || raw.length === 0) {
        this.logger.debug('Remote snapshot not found or empty — starting cold');
        return 0;
      }

      const rawBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      let buf: Buffer;
      try {
        buf = this.enc.decryptBuffer(rawBuf);
      } catch (e) {
        this.counters.remoteSnapshotErrors++;
        this.logger.warn('Remote snapshot rejected: decryption failed', { error: (e as Error).message });
        return 0;
      }

      const snapshot = this.codec.decode(buf) as {
        version?: number;
        writtenAt?: number;
        entries?: Array<{ key: string; entry: SmartCacheEntry }>;
      };

      if (!snapshot || snapshot.version !== SNAPSHOT_VERSION) {
        this.counters.remoteSnapshotErrors++;
        this.logger.warn('Remote snapshot rejected: version mismatch', { got: snapshot?.version });
        return 0;
      }

      const ageMs = Date.now() - (snapshot.writtenAt ?? 0);
      if (ageMs > maxAgeMs || ageMs < 0) {
        this.counters.remoteSnapshotErrors++;
        this.logger.warn('Remote snapshot rejected: too old', { ageMinutes: Math.round(ageMs / 60000) });
        return 0;
      }

      if (!Array.isArray(snapshot.entries)) {
        this.counters.remoteSnapshotErrors++;
        this.logger.warn('Remote snapshot rejected: entries is not an array');
        return 0;
      }

      const loaded = this.l1.importEntries(snapshot.entries, this.opts.forbiddenSnapshotPrefixes);
      this.counters.remoteSnapshotDownloads++;
      this.counters.remoteSnapshotLastDownloadedAt = Date.now();
      this.logger.info('Remote cache snapshot loaded (L1 hydrated)', {
        loaded,
        total:  snapshot.entries.length,
        sizeKB: this.l1.getStats().sizeKB,
      });
      return loaded;
    } catch (err) {
      this.counters.remoteSnapshotErrors++;
      this.logger.warn('Remote snapshot load failed — starting cold', { error: (err as Error).message });
      return 0;
    }
  }

  // ── Core get (L1 → L1.5 → L2 → fetch) ───────────────────────────────────

  /**
   * Get a value from cache, or fetch and cache it.
   *
   * @param cacheKey     - Unique key identifying this value
   * @param fetchFn      - Called on a cache miss; its return value is cached and returned
   * @param ttlSeconds   - How long to cache the value (default: 300 s = 5 min)
   * @param opts.priority    - Override the auto-inferred eviction priority
   * @param opts.swr         - Stale-While-Revalidate grace seconds.
   * @param opts.refreshAhead - 0–1 fraction of TTL elapsed at which a background recompute
   *                            is triggered proactively while the caller still receives the
   *                            cached value. E.g. `0.8` starts refreshing at 80 % of TTL.
   *                            Requires `fetchFn` to be stable across calls.
   * @param opts.xfetchBeta  - Enable XFetch (probabilistic early expiration). Higher values
   *                            recompute more aggressively before expiry. Typical range: 0.5–2.
   *                            Complementary to refreshAhead — uses recompute cost (delta) to
   *                            decide probabilistically rather than at a fixed threshold.
   * @param opts.notFoundTtl - Override TTL in seconds for `null`/`undefined` fetch results.
   *                            Caches negative lookups to avoid repeated DB hits for missing keys.
   */
  async get<T>(
    cacheKey:   string,
    fetchFn:    () => Promise<T>,
    ttlSeconds: number = 300,
    opts: {
      priority?:    CachePriority;
      swr?:         number;
      refreshAhead?: number; // 0–1: trigger background recompute at this fraction of TTL elapsed
      xfetchBeta?:  number;  // > 0: XFetch probabilistic early expiration (uses stored delta)
      notFoundTtl?: number;  // seconds; cache null/undefined results with this TTL instead
      /**
       * Tags to associate with this cache entry when fetchFn populates it on a miss.
       * Tags are registered in the in-process `tagIndex` and (if Redis is enabled) mirrored
       * via `SADD` so that `invalidateTag()` covers disk-spill and multi-instance nodes.
       * On an L1/L2 hit the tags are already registered — this field is a no-op for hits.
       */
      tags?:        string[];
    } = {},
  ): Promise<T> {
    const span = this._startSpan('tricache.get');
    if (this.opts.tracer) span.setAttribute('cache.key_prefix', cacheKey.split(':')[0]);
    const k = this.nk(cacheKey); // namespaced key used for all storage
    this.counters.gets++;

    // Normalize all opts fields to plain locals once. Every opts.XXX read
    // elsewhere in this function would hit a polymorphic IC when callers pass
    // different option shapes: {}, { swr }, { refreshAhead }, { tags }, etc.
    // Reading everything here collapses all downstream accesses to fast
    // monomorphic local-variable reads regardless of call-site variety.
    const optSwr          = opts.swr          ?? 0;
    const optPriority     = opts.priority;
    const optRefreshAhead = opts.refreshAhead;
    const optXfetchBeta   = opts.xfetchBeta;
    const optNotFoundTtl  = opts.notFoundTtl;
    const optTags         = opts.tags;

    // L1: in-memory (fastest path)
    const l1Hit = this.l1.get(k);
    if (l1Hit !== null) {
      let isGenerationalStale = false;
      if (this.opts.tagStrategy === 'generational' && l1Hit.tagVersions) {
        const tags = Object.keys(l1Hit.tagVersions);
        const currentVers = await Promise.all(tags.map(tag => this._getTagVersion(tag)));
        for (let i = 0; i < tags.length; i++) {
          if (currentVers[i] > l1Hit.tagVersions[tags[i]]) {
            isGenerationalStale = true;
            break;
          }
        }
      }

      if (isGenerationalStale) {
        this._deleteIfStale(k, l1Hit.setAt ?? 0);
      } else {
        if (l1Hit.isStale) {
          const swrGraceMs = optSwr * 1_000;
          if (swrGraceMs > 0 && !this.revalidating.has(k)) {
            const priority = optPriority ?? inferPriority(cacheKey);
            this.revalidating.add(k);
            void this._revalidate(k, fetchFn, ttlSeconds * 1_000, swrGraceMs, priority);
            this.counters.swrRevalidations++;
            this.logger.debug('SWR: serving stale, revalidating', { cacheKey });
          } else {
            this.logger.debug('L1 hit');
          }
        } else {
          this.logger.debug('L1 hit');
          // Refresh-ahead and XFetch: proactively recompute a fresh entry before it expires.
          // l1Hit already carries expiresAt/ttlMs/delta — no second Map lookup needed.
          const ra = optRefreshAhead;
          const xb = optXfetchBeta;
          if (ra || xb) {
            const now       = l1Hit.fetchedAt ?? Date.now();
            const remaining = l1Hit.expiresAt - now;
            const entryTtl  = l1Hit.ttlMs ?? ttlSeconds * 1_000;

            const shouldRefreshAhead = ra ? remaining <= entryTtl * (1 - ra) : false;
            const shouldXFetch = xb && l1Hit.delta != null
              ? remaining <= l1Hit.delta * xb * -Math.log(Math.random())
              : false;

            if ((shouldRefreshAhead || shouldXFetch) && !this.revalidating.has(k)) {
              const priority = optPriority ?? inferPriority(cacheKey);
              this.revalidating.add(k);
              void this._revalidate(k, fetchFn, entryTtl, optSwr * 1_000, priority);
              this.counters.swrRevalidations++;
              this.logger.debug(
                shouldXFetch ? 'XFetch: proactive background recompute' : 'Refresh-ahead: proactive background recompute',
                { cacheKey, remainingMs: remaining, ttlMs: entryTtl },
              );
            }
          }
        }
        this.counters.l1Hits++;
        this.opts.onHit?.(cacheKey, 'l1');
        if (this.opts.frozen) deepFreeze(l1Hit.value);
        span.setAttribute('cache.hit', true)
          .setAttribute('cache.item.tier', 'memory')
          .setAttribute('cache.hit_tier', 'l1')
          .end();
        return (this.opts.cloneStrategy === 'structuredClone' && l1Hit.value != null && typeof l1Hit.value === 'object')
          ? structuredClone(l1Hit.value) as T
          : l1Hit.value as T;
      }
    }

    const ttlMs      = this._jitterTtl(ttlSeconds * 1_000);
    const swrGraceMs = optSwr * 1_000;
    const priority   = optPriority ?? inferPriority(cacheKey);

    // L2: Redis (distributed, production-only by default)
    if (!this._redisDisabled) {
      try {
        const client = await this.getRedis();
        if (this.opts.tagStrategy === 'generational') {
          const hashData = await client.hgetall(k);
          this.cb.onSuccess();
          if (hashData && hashData.d) {
            let isStale = false;
            let storedTagVersions: Record<string, number> = {};
            if (hashData.tv) {
              try { storedTagVersions = JSON.parse(hashData.tv); } catch { /* ignore */ }
            }
            const tags = Object.keys(storedTagVersions);
            const currentVers = await Promise.all(tags.map(tag => this._getTagVersion(tag)));
            for (let i = 0; i < tags.length; i++) {
              if (currentVers[i] > storedTagVersions[tags[i]]) {
                isStale = true;
                break;
              }
            }
            if (isStale) {
              const setAtMs = parseInt(hashData.t, 10) || 0;
              this._deleteIfStale(k, setAtMs);
            } else {
              const parsed = await this._decryptAndDeserialize<T>(hashData.d);
              this.l1.set(k, parsed, ttlMs, priority, undefined, undefined, storedTagVersions);
              this.counters.l2Hits++;
              this.opts.onHit?.(cacheKey, 'l2');
              this.logger.debug('L2 hit (Redis hash)', { cacheKey });
              span.setAttribute('cache.hit', true)
                .setAttribute('cache.item.tier', 'remote')
                .setAttribute('cache.hit_tier', 'l2')
                .end();
              if (this.opts.frozen) deepFreeze(parsed);
              return (this.opts.cloneStrategy === 'structuredClone' && parsed != null && typeof parsed === 'object')
                ? structuredClone(parsed)
                : parsed;
            }
          }
        } else {
          const raw = await client.get(k);
          this.cb.onSuccess();
          if (raw) {
            const parsed = await this._decryptAndDeserialize<T>(raw);
            this.l1.set(k, parsed, ttlMs, priority);
            this.counters.l2Hits++;
            this.opts.onHit?.(cacheKey, 'l2');
            this.logger.debug('L2 hit (Redis)', { cacheKey });
            span.setAttribute('cache.hit', true)
              .setAttribute('cache.item.tier', 'remote')
              .setAttribute('cache.hit_tier', 'l2')
              .end();
            if (this.opts.frozen) deepFreeze(parsed);
            return (this.opts.cloneStrategy === 'structuredClone' && parsed != null && typeof parsed === 'object')
              ? structuredClone(parsed)
              : parsed;
          }
        }
      } catch (err) {
        this.cb.onFailure();
        this.logger.debug('Redis unavailable, continuing to fetch', { cacheKey, error: (err as Error).message });
      }
    }

    // L1.5: disk tier (evicted L1 entries) — skipped when disk is disabled
    if (!this._diskDisabled) {
      const diskHit = this.disk.load(k);
      if (diskHit !== null) {
        let isDiskStale = false;
        if (this.opts.tagStrategy === 'generational' && diskHit.tagVersions) {
          const tags = Object.keys(diskHit.tagVersions);
          const currentVers = await Promise.all(tags.map(tag => this._getTagVersion(tag)));
          for (let i = 0; i < tags.length; i++) {
            if (currentVers[i] > diskHit.tagVersions[tags[i]]) {
              isDiskStale = true;
              break;
            }
          }
        }

        if (isDiskStale) {
          this.disk.delete(k);
        } else {
          const promoted = this.l1.importEntries(
            [{ key: k, entry: diskHit as unknown as SmartCacheEntry }],
            this.opts.forbiddenSnapshotPrefixes,
          );
          if (promoted > 0) {
            const l1Check = this.l1.get(k);
            if (l1Check !== null) {
              this.counters.diskHits++;
              this.opts.onHit?.(cacheKey, 'disk');
              this.logger.debug('L1.5 hit (disk → L1)', { cacheKey });
              span.setAttribute('cache.hit', true)
                .setAttribute('cache.item.tier', 'disk')
                .setAttribute('cache.hit_tier', 'disk')
                .end();
              if (this.opts.frozen) deepFreeze(l1Check.value);
              return (this.opts.cloneStrategy === 'structuredClone' && l1Check.value != null && typeof l1Check.value === 'object')
                ? structuredClone(l1Check.value) as T
                : l1Check.value as T;
            }
          }
        }
      }
    }

    span.setAttribute('cache.hit', false).setAttribute('cache.hit_tier', 'miss');
    this.opts.onMiss?.(cacheKey);

    // Cache MISS: thundering-herd prevention
    const existing = this.inflight.get(k);
    if (existing) {
      this.counters.stampedes++;
      this.logger.debug('Stampede prevented — coalescing onto inflight fetch', { cacheKey });
      span.setAttribute('cache.hit', true)
        .setAttribute('cache.stampede_coalesced', true)
        .end();
      return existing as Promise<T>;
    }

    const fetchPromise: Promise<T> = (async () => {
      try {
        this.counters.fetches++;
        const fetchStart  = Date.now();
        let data: T;
        try {
          data = await fetchFn();
        } catch (fetchErr) {
          span.setStatus({
            code: 2,
            message: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
          });
          span.recordException?.(fetchErr);
          throw fetchErr;
        }
        const delta       = Date.now() - fetchStart;

        // Negative caching: null/undefined results get their own (shorter) TTL
        const notFoundTtlMs = (optNotFoundTtl ?? this.opts.notFoundTtl) * 1_000;
        let effectiveTtl  = (data == null && notFoundTtlMs > 0) ? notFoundTtlMs : ttlMs;

        if (this.latencyTracker && data != null) {
          this.latencyTracker.record(k, delta);
          const p95 = this.latencyTracker.p95(k);
          if (p95 !== null) {
            const adaptedMs = Math.round(p95 * this.opts.adaptiveTtlMultiplier * 1_000);
            effectiveTtl = Math.max(
              this.opts.adaptiveTtlMinMs,
              Math.min(this.opts.adaptiveTtlMaxMs, adaptedMs),
            );
          }
        }

        const staleAt  = swrGraceMs > 0 ? Date.now() + effectiveTtl : undefined;
        const storeTtl = swrGraceMs > 0 ? effectiveTtl + swrGraceMs : effectiveTtl;

        let activeTagVersions: Record<string, number> | undefined;
        if (optTags?.length) {
          if (this.opts.tagStrategy === 'generational') {
            const vers = await Promise.all(optTags.map(tag => this._getTagVersion(tag)));
            activeTagVersions = {};
            for (let i = 0; i < optTags.length; i++) {
              activeTagVersions[optTags[i]] = vers[i];
            }
          } else {
            await this._registerTags(k, optTags, Math.ceil(effectiveTtl / 1_000));
          }
        }

        this.l1.set(k, data, storeTtl, priority, staleAt, delta, activeTagVersions);

        if (!this._redisDisabled) {
          try {
            const client     = await this.getRedis();
            const serialized = JSON.stringify(data);
            const toStore    = await this._serializeAndEncrypt(serialized);
            const ttlSec     = Math.ceil(effectiveTtl / 1_000);
            if (this.opts.tagStrategy === 'generational' && activeTagVersions) {
              const now = Date.now();
              const tx = client.multi();
              tx.hset(k, {
                d: toStore,
                t: String(now),
                tv: JSON.stringify(activeTagVersions),
              });
              tx.expire(k, ttlSec);
              await tx.exec();
            } else {
              await client.setex(k, ttlSec, toStore);
            }
            this.cb.onSuccess();
            this.logger.debug('Cached L1+L2', { cacheKey, ttlSeconds, encrypted: this.enc.isEnabled });
          } catch {
            this.cb.onFailure();
            this.logger.debug('Cached L1 only (Redis unavailable)', { cacheKey });
          }
        } else {
          this.logger.debug('Cached L1', { cacheKey });
        }

        if (this.opts.frozen) deepFreeze(data);
        return (this.opts.cloneStrategy === 'structuredClone' && data != null && typeof data === 'object')
          ? structuredClone(data)
          : data;
      } finally {
        this.inflight.delete(k);
        span.end();
      }
    })();

    this.inflight.set(k, fetchPromise);
    return fetchPromise;
  }

  /**
   * Internal graceful shutdown trigger invoked by ProcessTerminationBus.
   */
  _triggerShutdown(): void {
    if (!this._diskDisabled) this.writeSnapshot();
    if (this.opts.remoteSnapshot && this.opts.remoteSnapshot.saveOnShutdown !== false) {
      void this.writeRemoteSnapshot();
    }
  }

  /**
   * Universal fetch-and-cache wrapper with an ergonomic options object.
   *
   * Drop-in ergonomic alternative to `get()` matching developer expectations
   * from `cache-manager` and `keyv`.
   *
   * @param cacheKey - Unique cache key.
   * @param fetchFn  - Executed on a cache miss to retrieve fresh data.
   * @param options  - Optional configuration object (TTL, SWR, tags, priority, etc.).
   *
   * @example
   * const user = await cache.wrap(`user:${id}`, () => db.user.findUnique({ where: { id } }), {
   *   ttl: 300,
   *   swr: 60,
   *   tags: ['users'],
   * });
   */
  wrap<T>(cacheKey: string, fetchFn: () => Promise<T>, options?: WrapOptions): Promise<T> {
    const ttl = options?.ttl ?? 300;
    return this.get<T>(cacheKey, fetchFn, ttl, options);
  }

  private async _revalidate<T>(
    cacheKey:  string,
    fetchFn:   () => Promise<T>,
    ttlMs:     number,
    swrGraceMs: number,
    priority:  CachePriority,
  ): Promise<void> {
    try {
      const fetchStart = Date.now();
      const data       = await fetchFn();
      const delta      = Date.now() - fetchStart;
      const staleAt    = Date.now() + ttlMs;

      // Keep the latency tracker current during SWR background revalidations too
      if (this.latencyTracker && data != null) this.latencyTracker.record(cacheKey, delta);

      let activeTagVersions: Record<string, number> | undefined;
      const l1Existing = this.l1.get(cacheKey);
      if (this.opts.tagStrategy === 'generational' && l1Existing?.tagVersions) {
        const tags = Object.keys(l1Existing.tagVersions);
        const vers = await Promise.all(tags.map(tag => this._getTagVersion(tag)));
        activeTagVersions = {};
        for (let i = 0; i < tags.length; i++) {
          activeTagVersions[tags[i]] = vers[i];
        }
      }

      this.l1.set(cacheKey, data, ttlMs + swrGraceMs, priority, staleAt, delta, activeTagVersions);

      if (!this._redisDisabled && this.opts.l2WriteMode === 'read-write') {
        try {
          const client = await this.getRedis();
          const s      = JSON.stringify(data);
          const stored = await this._serializeAndEncrypt(s);
          const ttlSec = Math.ceil(ttlMs / 1_000);
          if (this.opts.tagStrategy === 'generational' && activeTagVersions) {
            const now = Date.now();
            const tx = client.multi();
            tx.hset(cacheKey, {
              d: stored,
              t: String(now),
              tv: JSON.stringify(activeTagVersions),
            });
            tx.expire(cacheKey, ttlSec);
            await tx.exec();
          } else {
            await client.setex(cacheKey, ttlSec, stored);
          }
        } catch { /* ok */ }
      }
      this.logger.debug('SWR: revalidation complete', { cacheKey });
    } catch (err) {
      if (this.opts.staleIfError > 0) {
        const additionalMs = this.opts.staleIfError * 1_000;
        this.l1.bumpExpiry(cacheKey, additionalMs);
        this.logger.debug('SWR: revalidation failed, stale-if-error extending expiry', {
          cacheKey, staleIfErrorSecs: this.opts.staleIfError,
        });
      } else {
        this.logger.debug('SWR: revalidation failed', { cacheKey, error: (err as Error).message });
      }
    } finally {
      this.revalidating.delete(cacheKey);
    }
  }

  // ── Explicit set / delete ─────────────────────────────────────────────────

  /** Explicitly write a value into L1 (+ L2 in production). */
  async set<T>(cacheKey: string, data: T, ttlSeconds = 300, priority?: CachePriority, opts?: { tags?: string[]; dependsOn?: string[] }): Promise<void> {
    const span  = this._startSpan('tricache.set');
    if (this.opts.tracer) {
      span.setAttribute('cache.key_prefix', cacheKey.split(':')[0]);
      span.setAttribute('cache.ttl', ttlSeconds);
    }
    try {
      // ttl 0 = indefinite (documented contract, used by the NestJS store): map to
      // a far-future expiry instead of computing expiresAt = now + 0ms, which
      // created an instantly-expired entry that could never be read.
      const effectiveTtlSeconds = ttlSeconds > 0 ? ttlSeconds : (ttlSeconds === 0 ? INDEFINITE_TTL_SECONDS : ttlSeconds);
      const ttlMs = this._jitterTtl(effectiveTtlSeconds * 1_000);
      const p     = priority ?? inferPriority(cacheKey);
      const k     = this.nk(cacheKey);
      this.counters.sets++;

      let activeTagVersions: Record<string, number> | undefined;
      if (opts?.tags?.length) {
        if (this.opts.tagStrategy === 'generational') {
          const vers = await Promise.all(opts.tags.map(tag => this._getTagVersion(tag)));
          activeTagVersions = {};
          for (let i = 0; i < opts.tags.length; i++) {
            activeTagVersions[opts.tags[i]] = vers[i];
          }
        } else {
          await this._registerTags(k, opts.tags, ttlSeconds);
        }
      }

      this.l1.set(k, data, ttlMs, p, undefined, undefined, activeTagVersions);

      // Register dependency patterns: when any key matching a pattern is deleted,
      // this key (k) is automatically cascaded.
      if (opts?.dependsOn?.length) {
        for (const pattern of opts.dependsOn) {
          const nsPattern = this.nk(pattern);
          let deps = this.dependencyIndex.get(nsPattern);
          if (!deps) { deps = new Set(); this.dependencyIndex.set(nsPattern, deps); }
          deps.add(k);
        }
      }

      if (!this._redisDisabled && this.opts.l2WriteMode === 'read-write') {
        try {
          const client = await this.getRedis();
          const s      = JSON.stringify(data);
          const stored = await this._serializeAndEncrypt(s);
          const ttlSec = Math.ceil(ttlMs / 1_000);
          if (this.opts.tagStrategy === 'generational' && activeTagVersions) {
            const now = Date.now();
            const tx = client.multi();
            tx.hset(k, {
              d: stored,
              t: String(now),
              tv: JSON.stringify(activeTagVersions),
            });
            tx.expire(k, ttlSec);
            await tx.exec();
          } else {
            await client.setex(k, ttlSec, stored);
          }
          this.cb.onSuccess();
        } catch (err) {
          this.cb.onFailure();
          this.logger.debug('set: Redis unavailable', { cacheKey, error: (err as Error).message });
        }
      }

      void this.publishInvalidation('del', k);
    } catch (err) {
      span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
      span.recordException?.(err);
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Register tags for a cache key in the in-process index and (if Redis is enabled) in
   * the Redis SADD index. Tags are best-effort — a Redis failure does not throw.
   */
  private async _registerTags(k: string, tags: string[], ttlSeconds: number): Promise<void> {
    for (const tag of tags) {
      const tagKey = this.nk(`_tag_:${tag}`);
      let members = this.tagIndex.get(tagKey);
      if (!members) { members = new Set(); this.tagIndex.set(tagKey, members); }
      members.add(k);
    }
    if (!this._redisDisabled && this.opts.l2WriteMode === 'read-write') {
      try {
        const client = await this.getRedis();
        const pl = client.pipeline();
        for (const tag of tags) {
          const tagKey = this.nk(`_tag_:${tag}`);
          pl.sadd(tagKey, k);
          pl.expire(tagKey, ttlSeconds + 3_600);
        }
        await pl.exec();
        this.cb.onSuccess();
      } catch { this.cb.onFailure(); /* tags are best-effort */ }
    }
  }

  /**
   * Delete one key or a glob pattern (supports `*` wildcard).
   *
   * @example
   * await cache.delete('user:abc:profile');       // exact key
   * await cache.delete('user:abc:*');              // all keys for user abc
   */
  async delete(cacheKey: string): Promise<void> {
    const span      = this._startSpan('tricache.delete');
    if (this.opts.tracer) span.setAttribute('cache.key_prefix', cacheKey.split(':')[0]);
    try {
      const isPattern = cacheKey.includes('*');
      const k         = this.nk(cacheKey);
      this.counters.deletes++;

      if (isPattern) {
        this.l1.deletePattern(k);
      } else {
        this.l1.delete(k);
        // Defer the synchronous SHA-256 hash + fs syscalls to the next event-loop tick so
        // the caller's await resolves without blocking.  Matches what the backplane handler
        // already does for remote invalidations: setImmediate(() => this.disk.delete(msg.key)).
        // A re-get in the narrow window before the deferred call fires would get an L1 miss
        // and promote the disk entry back — acceptable for a cache (same trade-off the backplane
        // path already accepts).
        setImmediate(() => { if (!this._diskDisabled) this.disk.delete(k); });
        // Cascade: invalidate any key that declared it depends on this exact key's pattern
        this._cascadeDependencies(k);
        // Clean up: remove k from all dependency registrations (it is gone)
        for (const [, dependents] of this.dependencyIndex) dependents.delete(k);
      }

      if (!this._redisDisabled && this.opts.l2WriteMode === 'read-write') {
        try {
          const client = await this.getRedis();
          if (isPattern) {
            const keys = await this._scanKeys(client, k);
            if (keys.length > 0) await client.del(...keys);
          } else {
            await client.del(k);
          }
          this.cb.onSuccess();
        } catch (err) {
          this.cb.onFailure();
          this.logger.debug('delete: Redis unavailable', { cacheKey, error: (err as Error).message });
        }
      }

      void this.publishInvalidation(isPattern ? 'del-glob' : 'del', k, undefined, false, true);
    } catch (err) {
      span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
      span.recordException?.(err);
      throw err;
    } finally {
      span.end();
    }
  }

  // ── Counter (distributed rate limiting) ──────────────────────────────────

  /**
   * Distributed counter.
   *
   * When Redis is active, atomically increments the key via `INCR` and returns
   * the new (fleet-wide) value. On a Redis error it increments `counters.errors`
   * and, by default, fails OPEN — returning `0` so a caller's
   * `if (count > LIMIT) reject()` guard does NOT reject during an outage. Set
   * `failClosed: true` to re-throw the error instead, enforcing the limit even
   * when Redis is unavailable.
   *
   * When Redis is disabled (or `disableRedis: true`), this maintains an
   * IN-PROCESS counter with the same TTL semantics so dev/test rate-limiting
   * works locally. The returned value is the local count (1, 2, 3, …), NOT 0 —
   * a one-time warning is logged because rate-limiting is then per-instance, not
   * fleet-wide.
   */
  async increment(cacheKey: string, ttlSeconds?: number): Promise<number> {
    const k = this.nk(cacheKey);

    if (this._redisDisabled) {
      if (!this._incrementFallbackWarned) {
        this._incrementFallbackWarned = true;
        this.logger.warn(
          'tricache: increment() using in-process counter — rate limiting is NOT fleet-wide (Redis disabled)',
          { cacheKey },
        );
      }
      const now   = Date.now();
      const ttlMs = (ttlSeconds ?? DEFAULT_COUNTER_TTL_SECONDS) * 1_000;
      const entry = this._l1Counters.get(k);
      if (entry && entry.expiresAt > now) {
        entry.value++;
        return entry.value;
      }
      this._l1Counters.set(k, { value: 1, expiresAt: now + ttlMs });
      return 1;
    }

    try {
      const client = await this.getRedis();
      const count  = await client.incr(k);
      if (count === 1 && ttlSeconds) await client.expire(k, ttlSeconds);
      return count;
    } catch (err) {
      this.counters.counterErrors++;
      this.cb.onFailure();
      this.logger.error('increment: Redis error', { cacheKey }, err as Error);
      if (this.opts.failClosed) throw err;
      return 0;
    }
  }

  // ── Clear / Rebalance / TTL ────────────────────────────────────────────────

  /**
   * Flush all cached entries, or only those whose key starts with `prefix`.
   *
   * @example
   * await cache.clear();           // flush everything
   * await cache.clear('user:abc'); // flush all keys for one user
   */
  async clear(prefix?: string): Promise<void> {
    const span = this._startSpan('tricache.clear');
    if (this.opts.tracer) span.setAttribute('cache.prefix', prefix || '*');
    try {
      this.counters.deletes++;
      const k = prefix
        ? this.nk(prefix.includes('*') ? prefix : `${prefix}*`)
        : undefined;

      if (k) {
        this.l1.deletePattern(k);
        // Disk-tier pattern delete is not supported (files are keyed by SHA-256 hash);
        // prefix-scoped clears only evict from L1, matching existing delete('glob*') semantics.
      } else {
        this.l1.clear();
        if (!this._diskDisabled) this.disk.clear();
        this._l1Counters.clear();
        this.tagIndex.clear();
        this.tagVersions.clear();
      }

      if (!this._redisDisabled && this.opts.l2WriteMode === 'read-write') {
        try {
          const client  = await this.getRedis();
          const pattern = k ?? (this._namespace ? `${this._namespace}:*` : '*');
          const keys    = await this._scanKeys(client, pattern);
          if (keys.length > 0) await client.del(...keys);
        } catch (err) {
          this.logger.debug('clear: Redis unavailable', { error: (err as Error).message });
        }
      }

      void this.publishInvalidation('del-glob',
        k ?? (this._namespace ? `${this._namespace}:*` : '*'),
        undefined, false, true);
    } catch (err) {
      span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
      span.recordException?.(err);
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Evict L1 entries that violate the current category or global capacity limits.
   * Useful after a write burst or after adding stricter `categoryLimits`.
   * Returns the number of entries evicted.
   */
  rebalance(): number {
    return this.l1.rebalance();
  }

  /**
   * Return the remaining TTL in seconds for a key currently in L1.
   * Returns null if the key is absent from L1 or has already expired.
   * Only reflects L1 state — does not query Redis or disk.
   */
  ttl(cacheKey: string): number | null {
    return this.l1.ttl(this.nk(cacheKey));
  }

  /**
   * Return true if the key exists in L1 and has not expired.
   * Bloom-filter fast path — no fetch, no disk or Redis round-trip.
   */
  has(cacheKey: string): boolean {
    return this.l1.has(this.nk(cacheKey));
  }

  // ── Iteration ─────────────────────────────────────────────────────────────

  /**
   * Lazily yield every non-expired L1 key, stripped of its namespace prefix.
   *
   * @example
   * for (const key of cache.keys()) console.log(key);
   */
  *keys(): Generator<string> {
    const prefix = this._namespace ? this._namespace + ':' : '';
    for (const key of this.l1.liveKeys()) {
      if (prefix && !key.startsWith(prefix)) continue;
      yield prefix ? key.slice(prefix.length) : key;
    }
  }

  /**
   * Lazily yield every non-expired L1 value.
   * Each value is the cached (pre-deserialized) JS object — no unpack overhead.
   *
   * @example
   * for (const val of cache.values<User>()) console.log(val.id);
   */
  *values<T = unknown>(): Generator<T> {
    const prefix = this._namespace ? this._namespace + ':' : '';
    if (!prefix) {
      yield* this.l1.liveValues() as Generator<T>;
    } else {
      for (const [key, entry] of this.l1.liveEntries()) {
        if (!key.startsWith(prefix)) continue;
        yield this.l1.resolveValue(entry) as T;
      }
    }
  }

  /**
   * Lazily yield every non-expired L1 [key, value] pair.
   * Keys are stripped of their namespace prefix.
   *
   * @example
   * for (const [key, val] of cache.entries<User>()) console.log(key, val.id);
   */
  *entries<T = unknown>(): Generator<[string, T]> {
    const prefix = this._namespace ? this._namespace + ':' : '';
    for (const [key, entry] of this.l1.liveEntries()) {
      if (prefix && !key.startsWith(prefix)) continue;
      yield [prefix ? key.slice(prefix.length) : key, this.l1.resolveValue(entry) as T];
    }
  }

  /**
   * High-throughput bulk scan over all live L1 entries.
   *
   * Compared with `entries()` this avoids generator frame overhead, per-entry
   * `[key, value]` tuple allocation, and the `key.slice()` allocation when the
   * caller uses the `offset` parameter instead of pre-slicing.
   *
   * ```typescript
   * // Zero extra string allocations — use rawKey + offset directly:
   * cache.scan((rawKey, value, offset) => {
   *   const key = rawKey.slice(offset); // allocate only if needed
   *   sync(key, value as User);
   * });
   * ```
   *
   * @param fn Called once per live L1 entry.
   *           `rawKey`  — key with namespace prefix still attached.
   *           `value`   — deserialized cached value.
   *           `offset`  — `rawKey.slice(offset)` gives the bare key without namespace.
   */
  scan<T = unknown>(fn: (rawKey: string, value: T, offset: number) => void): void {
    const prefixLen = this._namespace ? this._namespace.length + 1 : 0;
    this.l1.scan((key, entry, pfx) => {
      const value = (entry.value !== undefined ? entry.value : entry.data) as T;
      fn(key, value, pfx);
    }, prefixLen);
  }

  /**
   * Extend the TTL of a key in L1 (and fire-and-forget EXPIRE in Redis) without fetching.
   * Returns `false` if the key is absent or already expired.
   *
   * @param newTtlSeconds - The new TTL from now, in seconds.
   */
  async touch(cacheKey: string, newTtlSeconds: number): Promise<boolean> {
    const k   = this.nk(cacheKey);
    const hit = this.l1.touch(k, newTtlSeconds * 1_000);
    if (hit && !this._redisDisabled) {
      try {
        const client = await this.getRedis();
        void client.expire(k, newTtlSeconds); // fire-and-forget
      } catch { /* ok */ }
    }
    return hit;
  }

  /**
   * Return the cached value from L1 **only if it is fresh** (not in the SWR grace window).
   * Returns `null` when the key is absent, expired, or stale — without triggering a fetch.
   *
   * @example
   * const fresh = cache.getIfFresh('user:123');
   * if (fresh !== null) return fresh; // serve from L1, no network hop
   */
  getIfFresh<T = unknown>(cacheKey: string): T | null {
    const k     = this.nk(cacheKey);
    const entry = this.l1.getEntry(k);
    if (!entry) return null;
    const now = Date.now();
    if (entry.expiresAt <= now) return null;               // expired
    if (entry.staleAt !== undefined && entry.staleAt < now) return null; // in SWR grace
    return (entry.value !== undefined ? entry.value : this.codec.decode(entry.data)) as T;
  }

  /**
   * Pure read across cache tiers (L1 RAM → L1.5 Disk → L2 Redis) without invoking a fetcher.
   * Returns the cached value if found and valid, or `null` if absent / expired.
   * Does not write dummy entries on misses or trigger side-effects.
   *
   * @example
   * const val = await cache.peek<User>('user:123');
   */
  async peek<T = unknown>(cacheKey: string): Promise<T | null> {
    const k = this.nk(cacheKey);

    // 1. L1 RAM
    const l1Hit = this.l1.get(k);
    if (l1Hit !== null) {
      this.counters.gets++;
      this.counters.l1Hits++;
      const val = l1Hit.value as T;
      if (this.opts.frozen) deepFreeze(val);
      return (this.opts.cloneStrategy === 'structuredClone' && val != null && typeof val === 'object')
        ? structuredClone(val)
        : val;
    }

    // 2. L1.5 Disk
    if (!this._diskDisabled) {
      const diskHit = this.disk.load(k);
      if (diskHit !== null) {
        const promoted = this.l1.importEntries(
          [{ key: k, entry: diskHit as unknown as SmartCacheEntry }],
          this.opts.forbiddenSnapshotPrefixes,
        );
        if (promoted > 0) {
          const l1Check = this.l1.get(k);
          if (l1Check !== null) {
            this.counters.gets++;
            this.counters.diskHits++;
            const val = l1Check.value as T;
            if (this.opts.frozen) deepFreeze(val);
            return (this.opts.cloneStrategy === 'structuredClone' && val != null && typeof val === 'object')
              ? structuredClone(val)
              : val;
          }
        }
      }
    }

    // 3. L2 Redis
    if (!this._redisDisabled && !this.cb.isOpen) {
      try {
        const client = await this.getRedis();
        const raw = await client.get(k);
        if (raw !== null) {
          const parsed = await this._decryptAndDeserialize<T>(raw);
          this.l1.set(k, parsed, 60_000, inferPriority(cacheKey));
          this.counters.gets++;
          this.counters.l2Hits++;
          this.cb.onSuccess();
          if (this.opts.frozen) deepFreeze(parsed);
          return (this.opts.cloneStrategy === 'structuredClone' && parsed != null && typeof parsed === 'object')
            ? structuredClone(parsed)
            : parsed;
        }
      } catch (err) {
        this.cb.onFailure();
        this.logger.debug('peek: Redis read failed', { cacheKey, error: (err as Error).message });
      }
    }

    return null;
  }

  /**
   * Batch get — fetches multiple keys, using L1 where hot and calling `fetchFn` for misses.
   * Preserves input ordering. Uses inflight coalescing per key.
   *
   * @param keys    - Array of cache keys.
   * @param fetchFn - Called with only the keys that missed L1.
   * @param ttl     - TTL in seconds for newly fetched values. Accepts a per-key function
   *                  `(key) => number` so heterogeneous TTLs can be batched in one call.
   */
  async mget<T>(
    keys: string[],
    fetchFn: (missKeys: string[]) => Promise<Record<string, T>>,
    ttl: number | ((key: string) => number) = 300,
    priority?: CachePriority,
  ): Promise<(T | undefined)[]> {
    const span = this._startSpan('tricache.mget');
    if (this.opts.tracer) {
      span.setAttribute('cache.batch.size', keys.length);
    }
    try {
      const result: (T | undefined)[] = Array.from({ length: keys.length });
      const missIndexes: number[] = [];
      const missKeys:   string[]  = [];

      // ── Tier 1: L1 (in-memory) ──
      for (let i = 0; i < keys.length; i++) {
        const k = this.nk(keys[i]);
        const entry = this.l1.getEntry(k);
        if (entry && entry.expiresAt > Date.now()) {
          result[i] = (entry.value !== undefined ? entry.value : this.codec.decode(entry.data)) as T;
          this.counters.l1Hits++;
        } else {
          missIndexes.push(i);
          missKeys.push(keys[i]);
        }
      }

      if (missKeys.length === 0) {
        if (this.opts.tracer) {
          span.setAttribute('cache.hits', keys.length);
          span.setAttribute('cache.misses', 0);
          span.setAttribute('cache.l1_hits', keys.length);
          span.setAttribute('cache.l2_hits', 0);
        }
        return result;
      }

      let l2HitCount = 0;
      // ── Tier 2: L2 (Redis) — fetch all remaining misses in one pipeline ──
      if (!this._redisDisabled) {
        try {
          const client = await this.getRedis();
          const nsKeys = missKeys.map(k => this.nk(k));
          const pipeline = client.multi();
          for (const nk of nsKeys) pipeline.get(nk);
          const raws = await pipeline.exec() as Array<[Error | null, string | null] | null>;
          this.cb.onSuccess();
          for (let j = 0; j < missKeys.length; j++) {
            const raw = raws[j] ? (raws[j] as [Error | null, string | null])[1] : null;
            const idx = missIndexes[j];
            if (raw) {
              const parsed = await this._decryptAndDeserialize<T>(raw);
              const k = nsKeys[j];
              const p = priority ?? inferPriority(missKeys[j]);
              this.l1.set(k, parsed, this._jitterTtl((typeof ttl === 'function' ? ttl(missKeys[j]) : ttl) * 1_000), p);
              this.counters.l2Hits++;
              l2HitCount++;
              result[idx] = parsed;
              missIndexes[j] = -1;
              missKeys[j] = '';
            }
          }
          // Compact the still-missing arrays.
          const remainingIdx = missIndexes.filter(i => i >= 0);
          const remainingKeys = missKeys.filter(k => k !== '');
          missIndexes.length = 0; missKeys.length = 0;
          missIndexes.push(...remainingIdx);
          missKeys.push(...remainingKeys);
        } catch (err) {
          this.cb.onFailure();
          this.logger.debug('mget: Redis unavailable, continuing to disk/fetch', { error: (err as Error).message });
        }
      }

      // ── Tier 1.5: disk spill (evicted L1 entries) ──
      if (!this._diskDisabled && missKeys.length > 0) {
        for (let j = missKeys.length - 1; j >= 0; j--) {
          const k = this.nk(missKeys[j]);
          const diskHit = this.disk.load(k);
          if (diskHit !== null) {
            const promoted = this.l1.importEntries(
              [{ key: k, entry: diskHit as unknown as SmartCacheEntry }],
              this.opts.forbiddenSnapshotPrefixes,
            );
            if (promoted > 0) {
              const l1Check = this.l1.get(k);
              if (l1Check !== null) {
                this.counters.diskHits++;
                result[missIndexes[j]] = l1Check.value as T;
                missIndexes.splice(j, 1);
                missKeys.splice(j, 1);
              }
            }
          }
        }
      }

      // ── Tier 3: fetchFn for whatever still missed ──
      if (missKeys.length > 0) {
        this.counters.fetches++;
        const fetched = await fetchFn(missKeys);
        const setPromises: Promise<void>[] = [];
        for (let j = 0; j < missKeys.length; j++) {
          const v = fetched[missKeys[j]];
          result[missIndexes[j]] = v;
          if (v !== undefined) {
            const resolvedTtl = typeof ttl === 'function' ? ttl(missKeys[j]) : ttl;
            setPromises.push(this.set(missKeys[j], v, resolvedTtl, priority));
          }
        }
        if (setPromises.length > 0) {
          await Promise.all(setPromises);
        }
      }

      if (this.opts.tracer) {
        const finalMisses = missKeys.length;
        const totalHits = keys.length - finalMisses;
        span.setAttribute('cache.hits', totalHits);
        span.setAttribute('cache.misses', finalMisses);
        span.setAttribute('cache.l2_hits', l2HitCount);
      }

      return result;
    } catch (err) {
      span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
      span.recordException?.(err);
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Returns a Promise that resolves once the cache is fully initialised and any
   * startup warming configured via `warmKeys` has completed.
   *
   * Without `warmKeys`, resolves immediately. With `warmKeys`, resolves once
   * `warmFromL2(warmKeys)` finishes — ideal for k8s readiness probes.
   *
   * @example
   * const cache = CacheService.create({ warmKeys: 'user:*' });
   * await cache.ready(); // gate traffic until warm
   */
  ready(): Promise<void> {
    return this._readyPromise;
  }

  /**
   * Batch write — set multiple entries in a single call.
   * TTL jitter is applied per-entry when `ttlJitterFactor` > 0.
   *
   * @example
   * await cache.mset({
   *   'user:1': { value: { name: 'Alice' }, ttl: 300 },
   *   'user:2': { value: { name: 'Bob'   }, ttl: 300, priority: CachePriority.HIGH },
   * });
   */
  async mset<T = unknown>(
    entries: Record<string, { value: T; ttl?: number; priority?: CachePriority; tags?: string[]; dependsOn?: string[] }>,
  ): Promise<void> {
    const span = this._startSpan('tricache.mset');
    const keys = Object.keys(entries);
    if (this.opts.tracer) {
      span.setAttribute('cache.batch.size', keys.length);
    }
    try {
      await Promise.all(keys.map(key => {
        const { value, ttl = 300, priority, tags, dependsOn } = entries[key];
        const hasOpts = tags?.length || dependsOn?.length;
        return this.set(key, value, ttl, priority, hasOpts ? { tags, dependsOn } : undefined);
      }));
    } catch (err) {
      span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
      span.recordException?.(err);
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Batch delete — delete multiple exact keys in a single call.
   * Glob patterns are not supported; use `delete('prefix:*')` for patterns.
   *
   * @example
   * await cache.mdel(['user:1', 'user:2', 'user:3']);
   */
  async mdel(keys: string[]): Promise<void> {
    const span = this._startSpan('tricache.mdel');
    if (this.opts.tracer) {
      span.setAttribute('cache.batch.size', keys.length);
    }
    try {
      await Promise.all(keys.map(k => this.delete(k)));
    } catch (err) {
      span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
      span.recordException?.(err);
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Warm L1 from L2 (Redis) by scanning for keys matching a glob pattern and
   * pulling them into L1. Useful on startup to eliminate cold-start penalty when
   * the local snapshot is unavailable or too stale.
   *
   * Returns the number of keys loaded into L1.
   *
   * @example
   * // In your startup hook (e.g. ECS task, k8s readiness probe):
   * const loaded = await cache.warmFromL2('org:*');
   * console.log(`Warmed ${loaded} keys from Redis`);
   */
  async warmFromL2(pattern: string, opts?: { priority?: CachePriority }): Promise<number> {
    if (this._redisDisabled) return 0;
    try {
      const client  = await this.getRedis();
      const nsPattern = this.nk(pattern);

      // Collect all matching keys via SCAN (handles single-node and Cluster)
      const matchedKeys = await this._scanKeys(client, nsPattern);

      if (matchedKeys.length === 0) {
        this.cb.onSuccess();
        return 0;
      }

      // Fetch values in a pipeline and load into L1
      const pl = client.pipeline();
      for (const k of matchedKeys) pl.get(k);
      const results = await pl.exec() as Array<[Error | null, string | null]>;
      this.cb.onSuccess();

      let loaded = 0;
      for (let i = 0; i < matchedKeys.length; i++) {
        const [err, raw] = results[i];
        if (err || raw == null) continue;
        try {
          const parsed    = await this._decryptAndDeserialize<unknown>(raw);
          // Use a 10-minute TTL as a reasonable default; the real TTL is not
          // returned by GET (use PTTL to be precise, but that doubles round-trips).
          const remainingMs = 10 * 60 * 1_000;
          this.l1.set(matchedKeys[i], parsed, remainingMs, opts?.priority ?? inferPriority(this.unnk(matchedKeys[i])));
          loaded++;
        } catch { /* skip malformed entries */ }
      }

      this.logger.info('warmFromL2 complete', {
        pattern, matched: matchedKeys.length, loaded,
      });
      return loaded;
    } catch (err) {
      this.cb.onFailure();
      this.logger.debug('warmFromL2: Redis unavailable', { error: (err as Error).message });
      return 0;
    }
  }

  /**
   * Invalidate all keys associated with a tag.
   * Deletes from L1, disk, and Redis (both the keyed values and the tag set).
   *
   * @example
   * await cache.set('product:1', data, 60, undefined, { tags: ['catalog'] });
   * await cache.invalidateTag('catalog'); // clears product:1 and any other tagged entries
   */
  async invalidateTag(tag: string): Promise<void> {
    const span = this._startSpan('tricache.invalidate_tag');
    if (this.opts.tracer) {
      span.setAttribute('cache.tag', tag);
      span.setAttribute('cache.tag_strategy', this.opts.tagStrategy);
    }
    try {
      if (this.opts.tagStrategy === 'generational') {
        let newVer = 1;
        if (!this._redisDisabled) {
          try {
            const client = await this.getRedis();
            newVer = await client.incr(this.nk(`tag_ver:${tag}`));
          } catch (err) {
            this.logger.debug('invalidateTag: Redis unavailable', { tag, error: (err as Error).message });
            const current = this.tagVersions.get(tag)?.version ?? 0;
            newVer = current + 1;
          }
        } else {
          const current = this.tagVersions.get(tag)?.version ?? 0;
          newVer = current + 1;
        }
        this._setLocalTagVersion(tag, newVer, Date.now());
        void this.publishInvalidation('tag_incr', tag, newVer, false, true);
        return;
      }

      const tagKey  = this.nk(`_tag_:${tag}`);
      const members = this.tagIndex.get(tagKey) ?? new Set<string>();

      // Remove from L1 + disk
      for (const k of members) {
        this.l1.delete(k);
        if (!this._diskDisabled) this.disk.delete(k);
      }
      this.tagIndex.delete(tagKey);

      if (!this._redisDisabled) {
        try {
          const client = await this.getRedis();
          const redisMembers: string[] = await client.smembers(tagKey);
          const toDelete = [...new Set([...members, ...redisMembers])];
          if (toDelete.length > 0) {
            await client.del(...toDelete, tagKey);
          } else {
            await client.del(tagKey);
          }
        } catch (err) {
          this.logger.debug('invalidateTag: Redis unavailable', { tag, error: (err as Error).message });
        }
      }
    } catch (err) {
      span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
      span.recordException?.(err);
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Invalidate all keys associated with any of the given tags in a single operation.
   * Combines multiple `invalidateTag()` calls into one Redis pipeline round-trip,
   * reducing latency when invalidating several related tags together.
   *
   * Note: Redis pipelines are batched, not atomic. All L1/disk deletes happen
   * synchronously before the Redis round-trip.
   *
   * @example
   * // Instead of three serial round-trips:
   * await cache.invalidateTags(['case:acme', 'org:acme', 'ai-chat:acme']);
   */
  async invalidateTags(tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    if (tags.length === 1) { await this.invalidateTag(tags[0]); return; }

    if (this.opts.tagStrategy === 'generational') {
      const now = Date.now();
      if (!this._redisDisabled) {
        try {
          const client = await this.getRedis();
          const pl = client.pipeline();
          for (const tag of tags) pl.incr(this.nk(`tag_ver:${tag}`));
          const results = await pl.exec() as Array<[Error | null, number]>;
          for (let i = 0; i < tags.length; i++) {
            const [err, newVer] = results[i] ?? [null, null];
            const ver = (!err && typeof newVer === 'number') ? newVer : (this.tagVersions.get(tags[i])?.version ?? 0) + 1;
            this._setLocalTagVersion(tags[i], ver, now);
            void this.publishInvalidation('tag_incr', tags[i], ver, false, true);
          }
          return;
        } catch (err) {
          this.logger.debug('invalidateTags: Redis unavailable', { tags, error: (err as Error).message });
        }
      }
      for (const tag of tags) {
        const ver = (this.tagVersions.get(tag)?.version ?? 0) + 1;
        this._setLocalTagVersion(tag, ver, now);
        void this.publishInvalidation('tag_incr', tag, ver, false, true);
      }
      return;
    }

    // In-process: collect all member keys across all tags and remove from L1 + disk
    const tagKeys: string[] = [];
    const allMembers = new Set<string>();
    for (const tag of tags) {
      const tagKey = this.nk(`_tag_:${tag}`);
      tagKeys.push(tagKey);
      const members = this.tagIndex.get(tagKey) ?? new Set<string>();
      for (const k of members) allMembers.add(k);
      this.tagIndex.delete(tagKey);
    }
    for (const k of allMembers) {
      this.l1.delete(k);
      this.disk.delete(k);
    }

    if (!this._redisDisabled) {
      try {
        const client = await this.getRedis();
        // Single round-trip: pipeline SMEMBERS for all tag keys
        const pl = client.pipeline();
        for (const tagKey of tagKeys) pl.smembers(tagKey);
        const smResults = await pl.exec() as Array<[Error | null, string[] | null]>;

        // Merge Redis members into the master delete set
        const toDelete: string[] = [...allMembers];
        for (const [err, redisMembers] of smResults) {
          if (!err && redisMembers) {
            for (const k of redisMembers) { if (!allMembers.has(k)) toDelete.push(k); }
          }
        }
        // Single DEL for all member keys + tag keys
        const keysToRemove = [...toDelete, ...tagKeys];
        if (keysToRemove.length > 0) await client.del(...keysToRemove);
      } catch (err) {
        this.logger.debug('invalidateTags: Redis unavailable', { tags, error: (err as Error).message });
      }
    }
  }

  /**
   * Get the current generational tag version for a tag (synced with Redis when due).
   */
  async getTagVersion(tag: string): Promise<number> {
    return this._getTagVersion(tag);
  }

  /**
   * Measure L1 / disk / Redis latency.
   * Useful for health checks and dashboards.
   *
   * @returns `{ l1, disk, l2 }` latencies in milliseconds.
   *          `l2` is `null` when Redis is disabled.
   */
  async ping(): Promise<CachePingResult> {
    // L1: measure a has() call
    const t0 = Date.now();
    this.l1.has('__ping__');
    const l1 = Date.now() - t0;

    // Disk: measure a stats access
    const t1 = Date.now();
    void this.disk.stats;
    const disk = Date.now() - t1;

    // L2: PING command
    let l2: number | null = null;
    if (!this._redisDisabled) {
      try {
        const client = await this.getRedis();
        const t2 = Date.now();
        await client.ping();
        l2 = Date.now() - t2;
      } catch { l2 = null; }
    }

    return { l1, disk, l2 };
  }

  /**
   * Export all live L1 entries to Redis via a single pipeline.
   * Useful for warming a new Redis instance or for zero-downtime failover.
   * Returns the number of keys written.
   */
  async drainToL2(): Promise<number> {
    if (this._redisDisabled) return 0;
    try {
      const client  = await this.getRedis();
      const entries = this.l1.exportEntries([]);
      const now     = Date.now();
      if (entries.length === 0) return 0;

      const pl = client.pipeline();
      for (const { key, entry } of entries) {
        const remainingMs = entry.expiresAt - now;
        if (remainingMs <= 0) continue;
        const ttlSecs = Math.max(1, Math.ceil(remainingMs / 1_000));
        const s       = JSON.stringify(entry.value);
        const stored  = this.enc.isEnabled ? this.enc.encrypt(s) : s;
        pl.setex(key, ttlSecs, stored);
      }
      await pl.exec();
      return entries.length;
    } catch (err) {
      this.logger.debug('drainToL2: Redis unavailable', { error: (err as Error).message });
      return 0;
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────────

  stats() {
    return {
      l1:   this.l1.getStats(),
      disk: this.disk.stats,
    };
  }

  // ── Conditional write ─────────────────────────────────────────────────

  /**
   * Write `value` only if the key is not already cached.
   * Returns `true` if the write happened, `false` if the key already existed.
   *
   * When Redis is available, atomicity is guaranteed via `SET NX EX` so this
   * is safe to use for idempotency keys and "first writer wins" patterns across
   * multiple instances. L1 is populated on success.
   *
   * @example
   * const claimed = await cache.setIfAbsent('idempotency:req_abc', payload, 300);
   * if (!claimed) return res.status(409).json({ error: 'duplicate request' });
   */
  async setIfAbsent<T>(cacheKey: string, value: T, ttlSeconds = 300, priority?: CachePriority): Promise<boolean> {
    const k = this.nk(cacheKey);

    // Fast path: L1 check (process-local, no network hop)
    if (this.l1.has(k)) return false;

    if (!this._redisDisabled) {
      try {
        const client     = await this.getRedis();
        const serialized = JSON.stringify(value);
        const toStore    = this.enc.isEnabled ? this.enc.encrypt(serialized) : serialized;
        // SET key value EX ttl NX — atomic; returns 'OK' on success, null if key exists
        const result     = await client.set(k, toStore, 'EX', ttlSeconds, 'NX');
        this.cb.onSuccess();
        if (result === null) return false; // already exists in Redis
      } catch (err) {
        this.cb.onFailure();
        this.logger.debug('setIfAbsent: Redis unavailable, falling back to L1 check', { cacheKey, error: (err as Error).message });
        // Re-check L1 after Redis failure — another thread may have won the race
        if (this.l1.has(k)) return false;
      }
    }

    const ttlMs = this._jitterTtl(ttlSeconds * 1_000);
    const p     = priority ?? inferPriority(cacheKey);
    this.l1.set(k, value, ttlMs, p);
    this.counters.sets++;
    return true;
  }

  // ── Distributed / In-Process Mutex Lock ───────────────────────────────────

  /**
   * Acquire a distributed (or in-process) mutual exclusion lock on `resourceKey`,
   * execute `fn`, and automatically release the lock on completion or error.
   *
   * When Redis is connected, uses `SET lock:<key> <token> NX EX <ttl>` with
   * safe Lua token release (`if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`).
   * When Redis is disabled, uses an in-process promise-chain mutex to ensure thread-safety.
   *
   * @param resourceKey Unique lock name / resource identifier (e.g. `'cron:nightly-sync'`).
   * @param fn Task to run exclusively while holding the lock.
   * @param options TTL, acquire timeout, and retry polling intervals.
   */
  async lock<T>(
    resourceKey: string,
    fn: () => Promise<T>,
    options?: LockOptions,
  ): Promise<T> {
    const ttlSeconds     = Math.max(1, options?.ttl ?? 30);
    const acquireTimeout = Math.max(0, options?.acquireTimeout ?? 5_000);
    const retryInterval  = Math.max(10, options?.retryInterval ?? 100);

    const lockKey = this.nk(`lock:${resourceKey}`);
    const token   = crypto.randomUUID();
    const deadline = Date.now() + acquireTimeout;

    let acquired = false;

    if (!this._redisDisabled) {
      // ── Acquire phase ONLY. Redis-side failures here may fall back to the
      // in-process mutex below. fn() is deliberately NOT inside this try: a
      // business exception must propagate to the caller exactly once — the old
      // control flow caught it HERE and re-ran fn() under the weaker local lock
      // AFTER the distributed lock had already been released (double side-effects).
      let client: AnyRedisClient | null = null;
      try {
        client = await this.getRedis();
        while (Date.now() <= deadline) {
          const res = await client.set(lockKey, token, 'EX', ttlSeconds, 'NX');
          if (res === 'OK') {
            acquired = true;
            break;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await new Promise(r => setTimeout(r, Math.min(retryInterval, remaining)));
        }

        if (!acquired) {
          throw new Error(`Failed to acquire lock for resource "${resourceKey}" within ${acquireTimeout}ms`);
        }
      } catch (err) {
        if ((err as Error).message.startsWith('Failed to acquire lock')) throw err;
        this.logger.debug('Distributed lock: Redis error, falling back to in-process mutex', {
          resourceKey, error: (err as Error).message,
        });
        client = null;
      }

      if (client !== null && acquired) {
        // ── Execution phase: OUTSIDE every fallback catch. An error thrown by
        // fn() propagates directly to the caller and is NEVER retried under the
        // local mutex. Release always runs; the TTL is the safety net if the
        // release call itself fails.
        try {
          return await fn();
        } finally {
          try {
            const LUA_RELEASE_LOCK = `
              if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
              else
                return 0
              end
            `;
            await client.eval(LUA_RELEASE_LOCK, 1, lockKey, token);
          } catch { /* ok — TTL expiry covers us */ }
        }
      }
    }

    // In-process lock fallback
    let unlock: () => void = () => {};
    const lockPromise = new Promise<void>(resolve => { unlock = resolve; });

    while (Date.now() <= deadline) {
      const existing = this._localLocks.get(lockKey);
      if (!existing) {
        this._localLocks.set(lockKey, lockPromise);
        acquired = true;
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await Promise.race([
        existing,
        new Promise(r => setTimeout(r, Math.min(retryInterval, remaining))),
      ]);
    }

    if (!acquired) {
      throw new Error(`Failed to acquire lock for resource "${resourceKey}" within ${acquireTimeout}ms`);
    }

    try {
      return await fn();
    } finally {
      unlock();
      if (this._localLocks.get(lockKey) === lockPromise) {
        this._localLocks.delete(lockKey);
      }
    }
  }

  // ── OpenTelemetry Metrics Integration ──────────────────────────────────────

  private _initOtelMetrics(meter: ICacheMeter): void {
    try {
      this._otelMetrics.gets = meter.createCounter('tricache.gets.total', { description: 'Total cache get operations' });
      this._otelMetrics.l1Hits = meter.createCounter('tricache.l1.hits', { description: 'L1 RAM cache hits' });
      this._otelMetrics.l2Hits = meter.createCounter('tricache.l2.hits', { description: 'L2 Redis cache hits' });
      this._otelMetrics.diskHits = meter.createCounter('tricache.disk.hits', { description: 'L1.5 disk cache hits' });
      this._otelMetrics.fetches = meter.createCounter('tricache.fetches', { description: 'Cache miss fetch calls' });
      this._otelMetrics.stampedes = meter.createCounter('tricache.stampedes.prevented', { description: 'Coalesced duplicate inflight requests' });
      this._otelMetrics.sets = meter.createCounter('tricache.sets.total', { description: 'Total set operations' });
      this._otelMetrics.deletes = meter.createCounter('tricache.deletes.total', { description: 'Total delete operations' });
      this._otelMetrics.swrRevalidations = meter.createCounter('tricache.swr.revalidations', { description: 'SWR background revalidations' });

      const gL1Entries = meter.createObservableGauge('tricache.l1.entries', { description: 'Current L1 entry count' });
      const gL1Bytes   = meter.createObservableGauge('tricache.l1.bytes', { description: 'Current L1 memory usage in bytes' });
      const gDiskFiles = meter.createObservableGauge('tricache.disk.files', { description: 'Current L1.5 disk file count' });
      const gDiskBytes = meter.createObservableGauge('tricache.disk.bytes', { description: 'Current L1.5 disk size in bytes' });
      const gBloomFpr  = meter.createObservableGauge('tricache.bloom.fpr', { description: 'Bloom filter false-positive rate' });

      meter.addBatchObservableCallback((observableResult) => {
        const stats = this.stats();
        const l1 = stats.l1;
        const disk = stats.disk;
        const checks = this.counters.bloomChecks;
        const fps = this.counters.bloomFalsePositives;
        const fpr = checks > 0 ? fps / checks : 0;
        const attrs = this._namespace ? { namespace: this._namespace } : undefined;

        observableResult.observe(gL1Entries, l1.entries, attrs);
        observableResult.observe(gL1Bytes, l1.sizeBytes, attrs);
        observableResult.observe(gDiskFiles, disk.files, attrs);
        observableResult.observe(gDiskBytes, disk.sizeKB * 1024, attrs);
        observableResult.observe(gBloomFpr, fpr, attrs);
      }, [gL1Entries, gL1Bytes, gDiskFiles, gDiskBytes, gBloomFpr]);
    } catch (err) {
      this.logger.warn('Failed to initialize OpenTelemetry metrics meter', { error: (err as Error).message });
    }
  }

  // ── Hot key introspection ─────────────────────────────────────────────

  /**
   * Return the top-N live L1 keys by historical access frequency.
   * Powered by the Count-Min Sketch — includes evicted-then-re-admitted keys
   * whose historical frequency exceeds their current in-memory hit count.
   *
   * Useful for diagnosing what is driving L1 pressure without any extra data
   * collection overhead.
   *
   * @param n - Maximum number of keys to return. Default: 10.
   *
   * @example
   * cache.hotKeys(5).forEach(({ key, hits, sizeBytes }) =>
   *   console.log(key, hits, (sizeBytes / 1024).toFixed(1) + ' KB'));
   */
  hotKeys(n = 10): Array<{ key: string; hits: number; sizeBytes: number }> {
    const prefixLen = this._namespace ? this._namespace.length + 1 : 0;
    return this.l1.hotKeys(n).map(({ key, hits, sizeBytes }) => ({
      key: prefixLen > 0 ? key.slice(prefixLen) : key,
      hits,
      sizeBytes,
    }));
  }

  // ── Dependency cascade helpers ────────────────────────────────────────

  /**
   * Test whether `key` (a concrete namespaced key) matches `pattern` (a glob
   * pattern that may contain `*` wildcards).
   */
  private _matchesGlob(key: string, pattern: string): boolean {
    if (!pattern.includes('*')) return key === pattern;
    return getGlobRegex(pattern).test(key);
  }

  /**
   * When an exact key `deletedKey` is removed, cascade to every dependent key
   * that was registered via `dependsOn` and whose source pattern matches.
   * Transitive dependencies are traversed with cycle protection via a visited Set.
   */
  private _cascadeDependencies(deletedKey: string, visited: Set<string> = new Set()): void {
    if (visited.has(deletedKey)) return;
    visited.add(deletedKey);

    for (const [pattern, dependents] of this.dependencyIndex) {
      if (!this._matchesGlob(deletedKey, pattern)) continue;
      for (const dep of dependents) {
        if (visited.has(dep)) continue;
        this.l1.delete(dep);
        if (!this._diskDisabled) this.disk.delete(dep);
        void this.publishInvalidation('del', dep, undefined, false, true);
        this.logger.debug('Dependency cascade: invalidated dependent key', {
          trigger: deletedKey.slice(0, 60), dependent: dep.slice(0, 60),
        });
        this._cascadeDependencies(dep, visited);
      }
    }
  }


  // ── Observability ──────────────────────────────────────────────────────────────────

  /** Return a full metrics snapshot. */
  metrics(): CacheMetrics {
    const c   = this.counters;
    const l1s = this.l1.getStats();
    const div = (n: number, d: number) => (d > 0 ? n / d : 0);

    return {
      namespace: this.opts.namespace,
      uptimeMs:  Date.now() - c.startedAt,

      gets: {
        total:             c.gets,
        l1Hits:            c.l1Hits,
        l1HitRate:         div(c.l1Hits,  c.gets),
        diskHits:          c.diskHits,
        diskHitRate:       div(c.diskHits, c.gets),
        l2Hits:            c.l2Hits,
        l2HitRate:         div(c.l2Hits,  c.gets),
        fetches:           c.fetches,
        fetchRate:         div(c.fetches,  c.gets),
        stampedePrevented: c.stampedes,
      },

      sets:          { total: c.sets },
      deletes:       { total: c.deletes },
      revalidations: { total: c.swrRevalidations },
      counters: {
        errors:           c.counterErrors,
        singletonDivergences: c.singletonDivergences,
      },

      bloom: {
        checksTotal:       l1s.bloom.checks,
        falsePositives:    l1s.bloom.falsePositives,
        falsePositiveRate: div(l1s.bloom.falsePositives, l1s.bloom.checks),
      },

      compression: {
        entriesCompressed:   l1s.compression.compressed,
        entriesUncompressed: l1s.compression.uncompressed,
        bytesSaved:          l1s.compression.bytesSaved,
      },

      backplane: {
        enabled:  this.opts.invalidationBackplane && !this._redisDisabled,
        mode:     this.opts.backplaneMode,
        sent:     c.invSent,
        received: c.invReceived,
        skipped:  c.invSkipped,
        streamEntriesReceived: c.streamEntriesReceived,
        streamReplays:         c.streamReplays,
        streamGaps:            c.streamGaps,
      },

      l2CircuitBreaker: {
        state: this.cb.currentState,
      },

      oom: {
        enabled:         this.opts.oomProtection,
        evictions:       c.oomEvictions,
        lastTriggeredAt: c.oomLastAt,
      },
      ...(this.opts.remoteSnapshot && {
        remoteSnapshot: {
          enabled: true,
          uploads: c.remoteSnapshotUploads,
          downloads: c.remoteSnapshotDownloads,
          errors: c.remoteSnapshotErrors,
          lastUploadedAt: c.remoteSnapshotLastUploadedAt,
          lastDownloadedAt: c.remoteSnapshotLastDownloadedAt,
        },
      }),
      ...(this.opts.crossRegion && {
        crossRegion: {
          enabled: true,
          currentRegion: this.opts.crossRegion.currentRegion,
          sent: c.crossRegionSent,
          received: c.crossRegionReceived,
          deduplicated: c.crossRegionDeduplicated,
          errors: c.crossRegionErrors,
        },
      }),

      l1: {
        entries:   l1s.entries,
        sizeBytes: this.l1.memoryUsage,
        maxBytes:  this.opts.l1MaxBytes,
      },
      disk: { ...this.disk.stats, disabled: this._diskDisabled },
      ...(this.latencyTracker && {
        adaptiveTtl: {
          enabled: true as const,
          trackedKeys: this.latencyTracker.trackedKeys,
          slowestKeys: this.latencyTracker.snapshot(
            this._namespace ? this._namespace.length + 1 : 0, // strip "namespace:" prefix
            this.opts.adaptiveTtlMultiplier,
            this.opts.adaptiveTtlMinMs,
            this.opts.adaptiveTtlMaxMs,
          ),
        },
      }),
    };
  }

  /**
   * Convert a `CacheMetrics` snapshot to Prometheus text exposition format.
   * Paste the result into your `/metrics` endpoint.
   *
   * @param m      - Snapshot returned by `cache.metrics()`
   * @param prefix - Metric name prefix. Default: `"tricache"`
   */
  static toPrometheusText(m: CacheMetrics, prefix = 'tricache', instanceName?: string): string {
    const parts: string[] = [];
    if (m.namespace) parts.push(`namespace="${m.namespace}"`);
    if (instanceName) parts.push(`instance="${instanceName}"`);
    const lbl  = parts.length ? `{${parts.join(',')}}` : '';
    const lines: string[] = [];

    const counter = (name: string, val: number, help: string) => {
      lines.push(`# HELP ${prefix}_${name}_total ${help}`);
      lines.push(`# TYPE ${prefix}_${name}_total counter`);
      lines.push(`${prefix}_${name}_total${lbl} ${val}`);
    };
    const gauge = (name: string, val: number, help: string) => {
      lines.push(`# HELP ${prefix}_${name} ${help}`);
      lines.push(`# TYPE ${prefix}_${name} gauge`);
      lines.push(`${prefix}_${name}${lbl} ${val}`);
    };

    counter('gets',                m.gets.total,             'Total get() calls');
    counter('l1_hits',             m.gets.l1Hits,            'L1 RAM cache hits');
    counter('disk_hits',           m.gets.diskHits,          'L1.5 disk tier hits');
    counter('l2_hits',             m.gets.l2Hits,            'L2 Redis hits');
    counter('fetches',             m.gets.fetches,           'fetchFn calls (cache misses)');
    counter('stampedes_prevented', m.gets.stampedePrevented, 'Coalesced duplicate inflight requests');
    counter('sets',                m.sets.total,             'Total set() calls');
    counter('deletes',             m.deletes.total,          'Total delete() calls');
    counter('swr_revalidations',   m.revalidations.total,    'Stale-While-Revalidate background refreshes');

    gauge('l1_hit_rate',   m.gets.l1HitRate,   'Fraction of gets served from L1 RAM (0-1)');
    gauge('disk_hit_rate', m.gets.diskHitRate, 'Fraction of gets served from disk (0-1)');
    gauge('l2_hit_rate',   m.gets.l2HitRate,   'Fraction of gets served from Redis (0-1)');
    gauge('fetch_rate',    m.gets.fetchRate,   'Fraction of gets calling fetchFn (0-1)');

    gauge('l1_entries',    m.l1.entries,   'Current L1 entry count');
    gauge('l1_size_bytes', m.l1.sizeBytes, 'Current L1 used bytes');
    gauge('disk_files',    m.disk.files,   'Current L1.5 disk file count');

    gauge('bloom_false_positive_rate', m.bloom.falsePositiveRate,
      'Bloom filter false-positive rate; increase capacity if > 0.01');
    gauge('compression_bytes_saved', m.compression.bytesSaved,
      'Approximate bytes saved by msgpackr compression');

    if (m.backplane.enabled) {
      counter('backplane_sent',     m.backplane.sent,     'Invalidation messages sent via Pub/Sub');
      counter('backplane_received', m.backplane.received, 'Invalidation messages received from peers');
    }
    if (m.oom.enabled) {
      counter('oom_evictions', m.oom.evictions,
        'Emergency L1 eviction rounds triggered by heap pressure');
    }
    if (m.remoteSnapshot?.enabled) {
      counter('remote_snapshot_uploads',   m.remoteSnapshot.uploads,   'Total remote snapshot uploads');
      counter('remote_snapshot_downloads', m.remoteSnapshot.downloads, 'Total remote snapshot downloads');
      counter('remote_snapshot_errors',    m.remoteSnapshot.errors,    'Total remote snapshot errors');
    }
    if (m.crossRegion?.enabled) {
      counter('cross_region_sent',         m.crossRegion.sent,         'Total cross-region invalidations broadcast');
      counter('cross_region_received',     m.crossRegion.received,     'Total cross-region invalidations received');
      counter('cross_region_deduplicated', m.crossRegion.deduplicated, 'Total cross-region invalidations deduplicated or self-filtered');
      counter('cross_region_errors',       m.crossRegion.errors,       'Total cross-region relay errors');
    }

    return lines.join('\n');
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Dynamically rotate the active encryption key at runtime without restarting.
   * Installs the new key as primary for all subsequent writes, while preserving
   * the previous key for seamless fallback decryption of existing cache entries.
   */
  async rotateEncryptionKey(newKeyBase64: string, newMode?: EncryptionMode): Promise<void> {
    this.enc.rotateKey(newKeyBase64, newMode);
    if (this._workerPool) {
      await this._workerPool.drainAndReinit(this.enc.toWorkerInit());
    }
    this.logger.info('tricache: encryption key rotated dynamically', { mode: this.enc.mode });
  }

  /** Close Redis connections and stop all background timers. */
  async destroy(): Promise<void> {
    this._destroyed = true;
    if (this.cleanupInterval)        clearInterval(this.cleanupInterval);
    if (this.diskJanitorInterval)     clearInterval(this.diskJanitorInterval);
    if (this.oomInterval)             clearInterval(this.oomInterval);
    if (this.metricsInterval)         clearInterval(this.metricsInterval);
    if (this.remoteSnapshotInterval) {
      clearInterval(this.remoteSnapshotInterval);
      this.remoteSnapshotInterval = null;
    }
    ProcessTerminationBus.unregister(this);
    this._shutdownHandler = null;
    if (this._workerPool) {
      await this._workerPool.destroy();
      this._workerPool = null;
    }
    if (this.subClient) {
      if (!this.opts.redisSubClient) {
        try { this.subClient.disconnect(); } catch { /* ok */ }
      }
      this.subClient = null;
    }
    if (this.streamClient) {
      try { this.streamClient.disconnect(); } catch { /* ok */ }
      this.streamClient = null;
    }
    if (this.redis) {
      if (!this.opts.redisClient) {
        try { await this.redis.disconnect(); } catch { /* ok */ }
      }
      this.redis = null;
    }
    if (!this._diskDisabled) this.disk.close();
  }

}