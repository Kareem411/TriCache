import type { ICacheSpan, ICacheTracer, InvalidateTagOptions } from '../types';
import type {
  EdgeCacheOptions,
  EdgeGetOptions,
  IEdgeRemoteStorage,
  IEdgeBloomFilter,
  CloudflareR2Object,
  EdgeSnapshotSource,
  EdgeHydrateOptions,
  EdgeExportSnapshotOptions,
  EdgeSnapshotPayload,
} from './types';
import { WebCryptoEncryption } from './crypto';
import { WasmBloomFilter } from '../wasm/bloom-filter-wasm';
import { Murmur3BloomFilter } from './utils/murmur3';
import { isWildcardTag, matchesTagPattern, isChildTag } from '../utils/tag-matcher';

interface EdgeL1Entry<T = unknown> {
  value: T;
  serialized: string;
  bytes: number;
  expiresAt: number;
  staleUntil: number;
  tags?: string[];
  tagVersions?: Record<string, number>;
}

const NAMESPACE_TAG = '_tricache_namespace_';

/**
 * Enterprise-grade cache service designed specifically for pure V8 Edge Isolates
 * (Cloudflare Workers, Fastly Compute, Vercel Edge, Next.js Edge Runtime, Deno).
 *
 * Characteristics:
 *  - Zero Node.js dependencies (no node:fs, node:v8, node:net, worker_threads)
 *  - Dual-bounded LRU with zero background intervals (allows isolates to suspend cleanly)
 *  - In-flight Promise Coalescing (prevents thundering herd on edge cold starts)
 *  - Edge-safe Stale-While-Revalidate with ctx.waitUntil() isolation fence
 *  - Web Crypto AEAD at-rest encryption cross-compatible with Node.js
 *  - OpenTelemetry semantic conventions instrumentation
 */
export class EdgeCacheService {
  private readonly maxKeys: number;
  private readonly maxBytes: number;
  private readonly defaultTtl: number;
  private readonly namespace: string;
  private readonly remoteStorage: IEdgeRemoteStorage | null;
  private readonly enc: WebCryptoEncryption;
  private readonly tracer: ICacheTracer | null;
  private readonly bloomFilter: IEdgeBloomFilter | null;
  private readonly bloomAuthoritative: boolean;
  private globalEpoch = 0;
  private lastGlobalMutationAt = 0;
  private readonly keyEpochs = new Map<string, number>();

  // L1 Dual-bounded LRU
  private readonly l1 = new Map<string, EdgeL1Entry>();
  private currentBytes = 0;

  // Single-flight in-flight stampede coalescing map
  private readonly inflight = new Map<string, Promise<unknown>>();

  // Tag indexing for edge
  private readonly tagIndex = new Map<string, Set<string>>();

  // Tag version in-isolate cache with 800ms micro-TTL (prevents HTTP fetch amplification on L1 hits)
  private static readonly MAX_TAG_VERSION_CACHE = 10_000;
  private readonly tagVersionCache = new Map<string, { version: number; expiresAt: number }>();
  private readonly tagVersionTtlMs = 800;

  constructor(options?: EdgeCacheOptions) {
    this.maxKeys = options?.maxKeys ?? 10_000;
    this.maxBytes = options?.maxBytes ?? 32 * 1024 * 1024; // 32 MB
    this.defaultTtl = options?.defaultTtlSeconds ?? 300;
    this.namespace = options?.namespace?.trim() ?? '';
    this.remoteStorage = options?.remoteStorage ?? null;
    this.tracer = options?.tracer ?? null;
    this.enc = new WebCryptoEncryption(options?.encryption);
    this.bloomAuthoritative = options?.bloomFilterAuthoritative ?? false;
    if (!Number.isInteger(this.maxKeys) || this.maxKeys < 0 || !Number.isFinite(this.maxBytes) || this.maxBytes < 0 ||
        !Number.isFinite(this.defaultTtl) || this.defaultTtl < 0) throw new Error('Edge cache limits and TTL must be finite non-negative values');

    if (options?.bloomFilter === true) {
      try {
        this.bloomFilter = new WasmBloomFilter();
      } catch {
        this.bloomFilter = new Murmur3BloomFilter();
      }
    } else if (options?.bloomFilter) {
      this.bloomFilter = options.bloomFilter;
    } else {
      this.bloomFilter = null;
    }
  }

  /**
   * Active Bloom filter instance defending against cold miss penetration, or null.
   */
  get bloom(): IEdgeBloomFilter | null {
    return this.bloomFilter;
  }

  private nk(key: string): string {
    return this.namespace ? `${this.namespace}:${key}` : key;
  }

  private _estimateBytes(key: string, serialized: string): number {
    // Approximate UTF-16 / UTF-8 memory footprint
    return (key.length + serialized.length) * 2 + 64;
  }

  private fence(key: string): string { return `${this.globalEpoch}:${this.keyEpochs.get(key) ?? 0}`; }
  private mutate(key: string): void {
    this.keyEpochs.set(key, (this.keyEpochs.get(key) ?? 0) + 1);
    this.inflight.delete(key);
    if (this.keyEpochs.size > 50000) { this.globalEpoch++; this.keyEpochs.clear(); }
  }
  private invalidateWork(): void {
    this.globalEpoch++;
    this.lastGlobalMutationAt = Date.now();
    this.inflight.clear();
  }

  private storeL1(key: string, entry: EdgeL1Entry): boolean {
    this._deleteL1(key);
    if (entry.bytes > this.maxBytes || this.maxKeys === 0 || entry.staleUntil <= Date.now()) return false;
    this._evictIfNeeded(entry.bytes);
    this.l1.set(key, entry);
    this.currentBytes += entry.bytes;
    for (const tag of entry.tags ?? []) {
      const members = this.tagIndex.get(tag) ?? new Set<string>();
      members.add(key);
      this.tagIndex.set(tag, members);
    }
    this.bloomFilter?.add(key);
    return true;
  }

  private async commit<T>(key: string, value: T, ttl: number, options: EdgeGetOptions | undefined,
    versions: Record<string, number>, epoch: string): Promise<void> {
    const namespaced = this.nk(key);
    if (this.fence(namespaced) !== epoch) return;
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return; // Undefined is not a JSON cache value.
    const now = Date.now();
    const entry: EdgeL1Entry<T> = { value, serialized, bytes: this._estimateBytes(namespaced, serialized),
      expiresAt: now + ttl * 1000, staleUntil: now + (ttl + (options?.swr ?? 0)) * 1000,
      tags: options?.tags ? [...new Set(options.tags)] : undefined, tagVersions: versions };
    this.storeL1(namespaced, entry);
    if (this.remoteStorage) {
      const envelope = JSON.stringify({ __t_edge: 2, __t_val: value, __t_tv: versions, __t_exp: entry.expiresAt,
        __t_stale: entry.staleUntil, __t_tags: entry.tags });
      const payload = this.enc.isEnabled ? await this.enc.encrypt(envelope) : envelope;
      if (this.fence(namespaced) !== epoch) return;
      await this.remoteStorage.set(namespaced, payload, ttl + (options?.swr ?? 0));
    }
  }

  private _evictIfNeeded(newBytes: number): void {
    // 1. Evict based on byte ceiling
    while (this.currentBytes + newBytes > this.maxBytes && this.l1.size > 0) {
      const oldestKey = this.l1.keys().next().value;
      if (oldestKey === undefined) break;
      this._deleteL1(oldestKey);
    }

    // 2. Evict based on key ceiling
    while (this.l1.size >= this.maxKeys) {
      const oldestKey = this.l1.keys().next().value;
      if (oldestKey === undefined) break;
      this._deleteL1(oldestKey);
    }
  }

  private _deleteL1(k: string): void {
    const entry = this.l1.get(k);
    if (entry) {
      this.currentBytes = Math.max(0, this.currentBytes - entry.bytes);
      this.l1.delete(k);
      // Clean up tag index
      if (entry.tags) {
        for (const tag of entry.tags) {
          const s = this.tagIndex.get(tag);
          if (s) {
            s.delete(k);
            if (s.size === 0) this.tagIndex.delete(tag);
          }
        }
      }
    }
  }

  private _startSpan(name: string): ICacheSpan {
    if (this.tracer) {
      const span = this.tracer.startSpan(name);
      if (this.namespace) span.setAttribute('cache.namespace', this.namespace);
      return span;
    }
    return {
      setAttribute() { return this; },
      setStatus() { return this; },
      recordException() { return this; },
      end() {},
    };
  }

  private _setTagVersionCache(tag: string, version: number, expiresAt: number): void {
    if (this.tagVersionCache.size >= EdgeCacheService.MAX_TAG_VERSION_CACHE && !this.tagVersionCache.has(tag)) {
      const now = Date.now();
      for (const [k, v] of this.tagVersionCache) {
        if (v.expiresAt <= now) {
          this.tagVersionCache.delete(k);
        }
      }
      if (this.tagVersionCache.size >= EdgeCacheService.MAX_TAG_VERSION_CACHE) {
        const oldestKey = this.tagVersionCache.keys().next().value;
        if (oldestKey !== undefined) this.tagVersionCache.delete(oldestKey);
      }
    }
    const known = this.tagVersionCache.get(tag)?.version ?? 0;
    this.tagVersionCache.set(tag, { version: Math.max(known, version), expiresAt });
  }

  private async _getTagVersion(tag: string): Promise<number> {
    const cached = this.tagVersionCache.get(tag);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.version;
    }
    let version = 1;
    if (this.remoteStorage) {
      try {
        if (typeof this.remoteStorage.getTagVersion === 'function') {
          version = await this.remoteStorage.getTagVersion(this.nk(tag));
        } else {
          const raw = await this.remoteStorage.get(this.nk(`tag_ver:${tag}`));
          version = raw ? parseInt(raw, 10) || 1 : 1;
        }
      } catch {
        version = cached?.version ?? 1;
      }
    } else {
      version = cached?.version ?? 1;
    }
    this._setTagVersionCache(tag, version, now + this.tagVersionTtlMs);
    return this.tagVersionCache.get(tag)?.version ?? version;
  }

  private async _batchGetTagVersions(tags: string[]): Promise<Record<string, number>> {
    const now = Date.now();
    const result: Record<string, number> = Object.create(null);
    const missingTags: string[] = [];

    for (const t of tags) {
      const c = this.tagVersionCache.get(t);
      if (c && c.expiresAt > now) {
        result[t] = c.version;
      } else {
        missingTags.push(t);
      }
    }

    if (missingTags.length > 0 && this.remoteStorage) {
      try {
        if (typeof this.remoteStorage.batchGetTagVersions === 'function') {
          const nsTags = missingTags.map(t => this.nk(t));
          const remoteVersions = await this.remoteStorage.batchGetTagVersions(nsTags);
          for (let i = 0; i < missingTags.length; i++) {
            const t = missingTags[i];
            const v = remoteVersions[this.nk(t)] ?? remoteVersions[t] ?? 1;
            result[t] = Math.max(this.tagVersionCache.get(t)?.version ?? 0, v);
            this._setTagVersionCache(t, v, now + this.tagVersionTtlMs);
          }
        } else {
          await Promise.all(missingTags.map(async t => {
            const v = await this._getTagVersion(t);
            result[t] = v;
          }));
        }
      } catch {
        for (const t of missingTags) {
          result[t] = this.tagVersionCache.get(t)?.version ?? 1;
        }
      }
    } else {
      for (const t of missingTags) {
        result[t] = this.tagVersionCache.get(t)?.version ?? 1;
      }
    }

    return result;
  }

  /**
   * Reads or fetches a value by key.
   */
  async get<T>(
    key: string,
    fetchFn?: () => Promise<T>,
    ttlSeconds?: number,
    options?: EdgeGetOptions,
  ): Promise<T | null> {
    const span = this._startSpan('tricache.get');
    span.setAttribute('cache.key', key);
    const nsKey = this.nk(key);
    let now = Date.now();
    const resolvedTtl = ttlSeconds ?? this.defaultTtl;

    try {
      // 1. Check L1 Memory
      const l1Entry = this.l1.get(nsKey);
      if (l1Entry) {
        // Check generational tag staleness
        let isTagStale = false;
        if (l1Entry.tagVersions) {
          const tagNames = Object.keys(l1Entry.tagVersions);
          const currentVers = await this._batchGetTagVersions(tagNames);
          for (const tag of tagNames) {
            if (currentVers[tag] > l1Entry.tagVersions[tag]) {
              isTagStale = true;
              break;
            }
          }
        }
        now = Date.now();

        if (isTagStale) {
          this._deleteL1(nsKey);
        } else {
          // Move to end of Map for LRU freshness
          this.l1.delete(nsKey);
          this.l1.set(nsKey, l1Entry);

          if (l1Entry.expiresAt > now) {
            // Fresh hit
            span.setAttribute('cache.hit', true);
            span.setAttribute('cache.item.tier', 'memory');
            span.setAttribute('cache.hit_tier', 'l1');
            return l1Entry.value as T;
          }

          if (l1Entry.staleUntil > now && fetchFn && (options?.swr ?? 0) > 0) {
            // Stale hit — trigger background revalidation
            span.setAttribute('cache.hit', true);
            span.setAttribute('cache.item.tier', 'memory');
            span.setAttribute('cache.hit_tier', 'l1');
            span.setAttribute('cache.stale', true);

            const revalPromise = this._revalidate(key, fetchFn, resolvedTtl, { ...options, tags: options?.tags ?? l1Entry.tags });
            if (options?.ctx?.waitUntil) {
              options.ctx.waitUntil(revalPromise);
            }
            return l1Entry.value as T;
          }

          // Hard expired in L1
          if (l1Entry.staleUntil <= now) this._deleteL1(nsKey);
        }
      }

      const existing = this.inflight.get(nsKey);
      if (existing) {
        span.setAttribute('cache.stampede_coalesced', true);
        return await existing as T;
      }
      const epoch = this.fence(nsKey);
      const execution: Promise<T | null> = Promise.resolve().then(async () => {
      try {
      // A local Bloom filter cannot prove that another isolate's remote key is absent.
      if (this.remoteStorage) {
        if (this.bloomAuthoritative && this.bloomFilter && !this.bloomFilter.mightContain(nsKey)) {
          span.setAttribute('cache.bloom.filtered', true);
        } else {
          try {
            const rawRemote = await this.remoteStorage.get(nsKey);
            if (rawRemote !== null) {
              const plain = this.enc.isEnabled ? await this.enc.decrypt(rawRemote) : rawRemote;
              const parsedJson = JSON.parse(plain);
              let parsed: T;
              let activeTagVersions: Record<string, number> | undefined;
              let isStaleRemote = false;

              if (parsedJson && typeof parsedJson === 'object' && '__t_val' in parsedJson && '__t_tv' in parsedJson) {
                parsed = parsedJson.__t_val as T;
                activeTagVersions = parsedJson.__t_tv as Record<string, number>;
                if (!activeTagVersions || typeof activeTagVersions !== 'object' || Array.isArray(activeTagVersions) ||
                    Object.values(activeTagVersions).some(version => !Number.isSafeInteger(version) || version < 0)) throw new Error('Invalid remote tag versions');
                const tagNames = Object.keys(activeTagVersions);
                const currentVers = await this._batchGetTagVersions(tagNames);
                for (const tag of tagNames) {
                  if (currentVers[tag] > activeTagVersions[tag]) {
                    isStaleRemote = true;
                    break;
                  }
                }
              } else {
                parsed = parsedJson as T;
              }

              if (!isStaleRemote) {
                const freshUntil = Number(parsedJson?.__t_exp);
                const staleUntil = Number(parsedJson?.__t_stale);
                const versioned = parsedJson?.__t_edge === 2 && Number.isFinite(freshUntil) && Number.isFinite(staleUntil) && staleUntil >= freshUntil;
                if (versioned && (staleUntil <= Date.now() || freshUntil <= Date.now() && (!(options?.swr ?? 0) || !fetchFn))) {
                  isStaleRemote = true;
                } else {
                // Promote without rewriting Redis/KV, resetting expiry, or discarding tags.
                if (versioned && this.fence(nsKey) === epoch) {
                  const serialized = JSON.stringify(parsed);
                  const tags = Array.isArray(parsedJson.__t_tags) ? parsedJson.__t_tags : Object.keys(activeTagVersions ?? {}).filter(tag => tag !== NAMESPACE_TAG);
                  this.storeL1(nsKey, { value: parsed, serialized, bytes: this._estimateBytes(nsKey, serialized),
                    expiresAt: freshUntil, staleUntil, tags, tagVersions: activeTagVersions });
                  if (freshUntil <= Date.now() && fetchFn) {
                    const refresh = execution.then(() => this._revalidate(key, fetchFn, resolvedTtl, { ...options, tags }));
                    options?.ctx?.waitUntil(refresh);
                  }
                }
                // Legacy raw JSON has no trustworthy remaining TTL: read it but do not promote it.

                span.setAttribute('cache.hit', true);
                span.setAttribute('cache.item.tier', 'remote');
                span.setAttribute('cache.hit_tier', 'l2');
                return parsed;
                }
              }
            }
          } catch (remoteErr) {
            span.recordException?.(remoteErr);
          }
        }
      }

      // 3. Cache Miss — Single-flight fetch promise coalescing
      if (!fetchFn) {
        span.setAttribute('cache.hit', false);
        span.setAttribute('cache.hit_tier', 'miss');
        return null;
      }

      const tags = [...new Set([NAMESPACE_TAG, ...options?.tags ?? []])];
      const versions = await this._batchGetTagVersions(tags);
      const fresh = await fetchFn();
      const current = await this._batchGetTagVersions(tags);
      if (this.fence(nsKey) === epoch && tags.every(tag => current[tag] === versions[tag])) {
        try { await this.commit(key, fresh, resolvedTtl, options, versions, epoch); }
        catch (error) { span.recordException?.(error); } // Origin reads remain available during cache outages.
      }
      span.setAttribute('cache.hit', false).setAttribute('cache.hit_tier', 'miss');
      return fresh;
      } finally {
        if (this.inflight.get(nsKey) === execution) this.inflight.delete(nsKey);
      }
      });
      this.inflight.set(nsKey, execution);
      return await execution;
    } catch (err) {
      span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
      span.recordException?.(err);
      throw err;
    } finally {
      span.end();
    }
  }

  private async _revalidate<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttl: number,
    options?: EdgeGetOptions,
  ): Promise<void> {
    const nsKey = this.nk(key);
    if (this.inflight.has(nsKey)) return;

    const epoch = this.fence(nsKey);
    const task = Promise.resolve().then(async () => {
      try {
        const tags = [...new Set([NAMESPACE_TAG, ...options?.tags ?? []])];
        const versions = await this._batchGetTagVersions(tags);
        const fresh = await fetchFn();
        const current = await this._batchGetTagVersions(tags);
        if (this.fence(nsKey) === epoch && tags.every(tag => current[tag] === versions[tag])) await this.commit(key, fresh, ttl, options, versions, epoch);
      } catch {
        // Suppress background revalidation error to prevent unhandled rejection
      } finally {
        if (this.inflight.get(nsKey) === task) this.inflight.delete(nsKey);
      }
    });

    this.inflight.set(nsKey, task);
    await task;
  }

  /**
   * Sets a value in the cache with an optional TTL and tags.
   */
  async set<T>(
    key: string,
    value: T,
    ttlSeconds?: number,
    options?: { tags?: string[]; swr?: number } | string[],
  ): Promise<void> {
    const span = this._startSpan('tricache.set');
    span.setAttribute('cache.key', key);
    const nsKey = this.nk(key);
    this.mutate(nsKey);
    const epoch = this.fence(nsKey);
    const resolvedTtl = ttlSeconds ?? this.defaultTtl;
    const optObj = Array.isArray(options) ? { tags: options } : options;
    const swrSeconds = optObj?.swr ?? 0;

    try {
      if (!Number.isFinite(resolvedTtl) || resolvedTtl < 0 || !Number.isFinite(swrSeconds) || swrSeconds < 0) throw new Error('Edge TTL and SWR must be finite non-negative values');
      const versions = await this._batchGetTagVersions([...new Set([NAMESPACE_TAG, ...optObj?.tags ?? []])]);
      await this.commit(key, value, resolvedTtl, optObj, versions, epoch);
    } catch (err) {
      span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
      span.recordException?.(err);
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Deletes a key from all tiers.
   */
  async delete(key: string): Promise<void> {
    const span = this._startSpan('tricache.delete');
    span.setAttribute('cache.key', key);
    const nsKey = this.nk(key);

    try {
      this.mutate(nsKey);
      this._deleteL1(nsKey);
      if (this.remoteStorage) {
        await this.remoteStorage.delete(nsKey);
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
   * Executes invalidation for a single already-resolved concrete tag without
   * re-entering wildcard/cascade resolution.
   */
  private async _invalidateConcreteTag(tag: string): Promise<void> {
    this.invalidateWork();
    const previous = this.tagVersionCache.get(tag)?.version ?? 1;
    let newVer = 1;
    if (this.remoteStorage) {
      try {
        if (typeof this.remoteStorage.incrementTagVersion === 'function') {
          newVer = await this.remoteStorage.incrementTagVersion(this.nk(tag));
          if (newVer <= previous) newVer = await this.remoteStorage.incrementTagVersion(this.nk(tag));
          newVer = Math.max(previous + 1, newVer);
        } else {
          const key = this.nk(`tag_ver:${tag}`);
          const current = await this._getTagVersion(tag);
          newVer = Math.max(current + 1, Date.now());
          await this.remoteStorage.set(key, String(newVer));
        }
      } catch {
        const current = this.tagVersionCache.get(tag)?.version ?? 1;
        newVer = current + 1;
      }
    } else {
      const current = this.tagVersionCache.get(tag)?.version ?? 1;
      newVer = current + 1;
    }

    this._setTagVersionCache(tag, newVer, Date.now() + this.tagVersionTtlMs);

    // Invalidate local L1 entries
    const keys = this.tagIndex.get(tag);
    if (keys) {
      const keysArr = Array.from(keys);
      for (const k of keysArr) {
        this._deleteL1(k);
      }
      this.tagIndex.delete(tag);
    }
  }

  /**
   * Invalidates all cached entries associated with a tag.
   */
  async invalidateTag(tag: string, opts?: InvalidateTagOptions): Promise<void> {
    const span = this._startSpan('tricache.invalidate_tag');
    span.setAttribute('cache.tag', tag);
    if (opts?.cascade) span.setAttribute('cache.cascade', true);

    try {
      const isPattern = isWildcardTag(tag);
      const shouldCascade = Boolean(opts?.cascade);
      if (isPattern || shouldCascade) {
        const matched = new Set<string>();
        const tagMatches = (t: string) => {
          if (t === tag) return true;
          if (isPattern && matchesTagPattern(tag, t)) return true;
          if (shouldCascade && isChildTag(tag, t, ':')) return true;
          return false;
        };
        for (const t of this.tagIndex.keys()) {
          if (tagMatches(t)) matched.add(t);
        }
        for (const t of this.tagVersionCache.keys()) {
          if (tagMatches(t)) matched.add(t);
        }
        if (shouldCascade && !isPattern) matched.add(tag);
        for (const t of matched) {
          await this._invalidateConcreteTag(t);
        }
        return;
      }

      await this._invalidateConcreteTag(tag);
    } catch (err) {
      span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
      span.recordException?.(err);
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Clears all entries from the edge cache.
   */
  async clear(): Promise<void> {
    const span = this._startSpan('tricache.clear');
    try {
      const previousNamespace = await this._getTagVersion(NAMESPACE_TAG);
      this.invalidateWork();
      this.l1.clear();
      this.currentBytes = 0;
      this.tagIndex.clear();
      this.tagVersionCache.clear();
      if (this.bloomFilter) {
        this.bloomFilter.reset();
      }
      if (this.remoteStorage) {
        await this.remoteStorage.clear?.(this.namespace ? this.namespace + ':' : undefined);
      }
      this._setTagVersionCache(NAMESPACE_TAG, previousNamespace, Date.now() + this.tagVersionTtlMs);
      await this._invalidateConcreteTag(NAMESPACE_TAG);
    } catch (err) {
      span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
      span.recordException?.(err);
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Batch get with miss-fetching.
   */
  async mget<T>(
    keys: string[],
    fetchFn?: (missKeys: string[]) => Promise<Record<string, T> | Map<string, T>>,
    ttlSeconds?: number,
  ): Promise<(T | null)[]> {
    const span = this._startSpan('tricache.mget');
    const epochs = new Map(keys.map(key => [key, this.fence(this.nk(key))]));
    span.setAttribute('cache.batch.size', keys.length);

    try {
      const results: (T | null)[] = Array.from({ length: keys.length }, () => null);
      const missIndices: number[] = [];
      const missKeys: string[] = [];

      for (let i = 0; i < keys.length; i++) {
        const val = await this.get<T>(keys[i]);
        if (val !== null) {
          results[i] = val;
        } else {
          missIndices.push(i);
          missKeys.push(keys[i]);
        }
      }

      span.setAttribute('cache.hits', keys.length - missKeys.length);
      span.setAttribute('cache.misses', missKeys.length);

      if (missKeys.length > 0 && fetchFn) {
        const fetchedMap = await fetchFn(missKeys);
        const isMap = fetchedMap instanceof Map;
        for (let j = 0; j < missKeys.length; j++) {
          const k = missKeys[j];
          const fetchedVal = isMap ? (fetchedMap as Map<string, T>).get(k) : Object.hasOwn(fetchedMap, k) ? (fetchedMap as Record<string, T>)[k] : undefined;
          if (fetchedVal !== undefined) {
            results[missIndices[j]] = fetchedVal;
            if (this.fence(this.nk(k)) === epochs.get(k)) await this.set(k, fetchedVal, ttlSeconds);
          }
        }
      }

      return results;
    } catch (err) {
      span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
      span.recordException?.(err);
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Serializes active, unexpired L1 entries into a snapshot string (encrypted if WebCrypto encryption is enabled).
   * Ideal for persisting Edge state to Cloudflare R2 before worker restart.
   */
  async exportSnapshot(options?: EdgeExportSnapshotOptions): Promise<string> {
    const now = Date.now();
    const entries: EdgeSnapshotPayload['entries'] = [];

    for (const [nsKey, entry] of this.l1.entries()) {
      if (entry.expiresAt > now || entry.staleUntil > now) {
        const cleanKey = this.namespace && nsKey.startsWith(this.namespace + ':')
          ? nsKey.slice(this.namespace.length + 1)
          : nsKey;

        entries.push({
          key: cleanKey,
          value: entry.value,
          expiresAt: entry.expiresAt,
          staleUntil: entry.staleUntil,
          tags: entry.tags,
          tagVersions: entry.tagVersions,
        });
      }
    }

    const payload: EdgeSnapshotPayload = {
      version: 1,
      writtenAt: now,
      entries,
    };

    const jsonStr = JSON.stringify(payload);
    const shouldEncrypt = options?.encrypt ?? this.enc.isEnabled;
    if (shouldEncrypt && this.enc.isEnabled) {
      return await this.enc.encrypt(jsonStr);
    }
    return jsonStr;
  }

  /**
   * Hydrates L1 memory and primes the Bloom filter directly from Cloudflare R2 or snapshot sources on edge isolate initialization.
   *
   * @param source Cloudflare R2 bucket binding (env.MY_BUCKET), reader object, snapshot string, or ArrayBuffer.
   * @param options Configuration options (key, maxAgeMs, clockSkewToleranceMs).
   * @returns Number of cache entries successfully restored into L1.
   *
   * @example
   * // In Cloudflare Worker:
   * export default {
   *   async fetch(request, env, ctx) {
   *     await edgeCache.hydrate(env.CACHE_R2_BUCKET);
   *     return handleRequest(request);
   *   }
   * }
   */
  async hydrate(source: EdgeSnapshotSource, options?: EdgeHydrateOptions): Promise<number> {
    const epoch = this.globalEpoch;
    let rawStr: string | null = null;

    if (source && typeof source === 'object') {
      if ('get' in source && typeof source.get === 'function') {
        const key = options?.key ?? 'tricache-edge.snap';
        const obj = await source.get(key);
        if (!obj) return 0;

        if (typeof obj === 'string') {
          rawStr = obj;
        } else if (obj instanceof ArrayBuffer || (typeof Uint8Array !== 'undefined' && obj instanceof Uint8Array)) {
          rawStr = new TextDecoder().decode(obj);
        } else if (typeof (obj as CloudflareR2Object).text === 'function') {
          rawStr = await (obj as CloudflareR2Object).text();
        } else if (typeof (obj as CloudflareR2Object).arrayBuffer === 'function') {
          const ab = await (obj as CloudflareR2Object).arrayBuffer();
          rawStr = new TextDecoder().decode(ab);
        }
      } else if (source instanceof ArrayBuffer) {
        rawStr = new TextDecoder().decode(source);
      } else if (typeof Uint8Array !== 'undefined' && source instanceof Uint8Array) {
        rawStr = new TextDecoder().decode(source);
      }
    } else if (typeof source === 'string') {
      rawStr = source;
    }

    if (!rawStr) return 0;

    // Decrypt if encrypted envelope
    if (rawStr.startsWith('enc:v1:') || rawStr.startsWith('a128:v1:')) {
      try {
        rawStr = await this.enc.decrypt(rawStr);
      } catch {
        return 0; // Decryption failure -> fallback to cold start
      }
    }

    let payload: EdgeSnapshotPayload;
    try {
      payload = JSON.parse(rawStr) as EdgeSnapshotPayload;
    } catch {
      return 0; // Malformed JSON -> fallback cold
    }

    if (!payload || payload.version !== 1 || !Array.isArray(payload.entries) || this.globalEpoch !== epoch) {
      return 0;
    }

    const now = Date.now();
    const maxAgeMs = options?.maxAgeMs ?? 7_200_000;
    const tolerance = options?.clockSkewToleranceMs ?? 250;
    const writtenAt = payload.writtenAt ?? 0;
    if (!Number.isFinite(writtenAt) || writtenAt < this.lastGlobalMutationAt) return 0;

    // Reject future timestamp exceeding clock skew tolerance
    if (writtenAt - now > tolerance) {
      return 0;
    }

    // Reject stale snapshot
    const ageMs = Math.max(0, now - writtenAt);
    if (ageMs > maxAgeMs) {
      return 0;
    }

    let imported = 0;
    for (const item of payload.entries) {
      if (!item || typeof item.key !== 'string') continue;
      // Skip if completely expired
      if (item.expiresAt <= now && item.staleUntil <= now) continue;

      const nsKey = this.nk(item.key);
      if (this.l1.has(nsKey) || this.keyEpochs.has(nsKey) || !Number.isFinite(item.expiresAt) || !Number.isFinite(item.staleUntil)) continue;
      const serialized = JSON.stringify(item.value);
      const bytes = this._estimateBytes(nsKey, serialized);
      if (bytes > this.maxBytes || this.maxKeys === 0) continue;

      this._deleteL1(nsKey);
      this._evictIfNeeded(bytes);

      const entry: EdgeL1Entry = {
        value: item.value,
        serialized,
        bytes,
        expiresAt: item.expiresAt,
        staleUntil: item.staleUntil,
        tags: item.tags,
        tagVersions: item.tagVersions,
      };

      this.l1.set(nsKey, entry);
      this.currentBytes += bytes;

      if (item.tags) {
        for (const tag of item.tags) {
          let s = this.tagIndex.get(tag);
          if (!s) {
            s = new Set<string>();
            this.tagIndex.set(tag, s);
          }
          s.add(nsKey);
        }
      }

      if (this.bloomFilter) {
        this.bloomFilter.add(nsKey);
      }

      imported++;
    }

    return imported;
  }

  /**
   * Diagnostic snapshot of edge cache memory usage.
   */
  stats() {
    return {
      keys: this.l1.size,
      bytes: this.currentBytes,
      maxKeys: this.maxKeys,
      maxBytes: this.maxBytes,
      tags: this.tagIndex.size,
    };
  }
}
