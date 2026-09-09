import type { ICacheSpan, ICacheTracer } from '../types';
import type { EdgeCacheOptions, EdgeGetOptions, IEdgeRemoteStorage } from './types';
import { WebCryptoEncryption } from './crypto';

interface EdgeL1Entry<T = unknown> {
  value: T;
  serialized: string;
  bytes: number;
  expiresAt: number;
  staleUntil: number;
  tags?: string[];
  tagVersions?: Record<string, number>;
}

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

  // L1 Dual-bounded LRU
  private readonly l1 = new Map<string, EdgeL1Entry>();
  private currentBytes = 0;

  // Single-flight in-flight stampede coalescing map
  private readonly inflight = new Map<string, Promise<unknown>>();

  // Tag indexing for edge
  private readonly tagIndex = new Map<string, Set<string>>();

  // Tag version in-isolate cache with 800ms micro-TTL (prevents HTTP fetch amplification on L1 hits)
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
  }

  private nk(key: string): string {
    return this.namespace ? `${this.namespace}:${key}` : key;
  }

  private _estimateBytes(key: string, serialized: string): number {
    // Approximate UTF-16 / UTF-8 memory footprint
    return (key.length + serialized.length) * 2 + 64;
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
    this.tagVersionCache.set(tag, { version, expiresAt: now + this.tagVersionTtlMs });
    return version;
  }

  private async _batchGetTagVersions(tags: string[]): Promise<Record<string, number>> {
    const now = Date.now();
    const result: Record<string, number> = {};
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
            result[t] = v;
            this.tagVersionCache.set(t, { version: v, expiresAt: now + this.tagVersionTtlMs });
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
    const now = Date.now();
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

          if (l1Entry.staleUntil > now && fetchFn) {
            // Stale hit — trigger background revalidation
            span.setAttribute('cache.hit', true);
            span.setAttribute('cache.item.tier', 'memory');
            span.setAttribute('cache.hit_tier', 'l1');
            span.setAttribute('cache.stale', true);

            const revalPromise = this._revalidate(key, fetchFn, resolvedTtl, options);
            if (options?.ctx?.waitUntil) {
              options.ctx.waitUntil(revalPromise);
            }
            return l1Entry.value as T;
          }

          // Hard expired in L1
          this._deleteL1(nsKey);
        }
      }

      // 2. Check L2 Remote Storage
      if (this.remoteStorage) {
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
              // Warm L1
              await this.set(key, parsed, resolvedTtl, options);

              span.setAttribute('cache.hit', true);
              span.setAttribute('cache.item.tier', 'remote');
              span.setAttribute('cache.hit_tier', 'l2');
              return parsed;
            }
          }
        } catch (remoteErr) {
          span.recordException?.(remoteErr);
        }
      }

      // 3. Cache Miss — Single-flight fetch promise coalescing
      if (!fetchFn) {
        span.setAttribute('cache.hit', false);
        span.setAttribute('cache.hit_tier', 'miss');
        return null;
      }

      let inflightPromise = this.inflight.get(nsKey) as Promise<T> | undefined;
      let coalesced = false;

      if (inflightPromise) {
        coalesced = true;
      } else {
        inflightPromise = (async () => {
          try {
            const fresh = await fetchFn();
            await this.set(key, fresh, resolvedTtl, options);
            return fresh;
          } finally {
            this.inflight.delete(nsKey);
          }
        })();
        this.inflight.set(nsKey, inflightPromise);
      }

      span.setAttribute('cache.hit', coalesced);
      span.setAttribute('cache.hit_tier', coalesced ? 'l1' : 'miss');
      span.setAttribute('cache.stampede_coalesced', coalesced);

      const result = await inflightPromise;
      return result;
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

    const task = (async () => {
      try {
        const fresh = await fetchFn();
        await this.set(key, fresh, ttl, options);
      } catch {
        // Suppress background revalidation error to prevent unhandled rejection
      } finally {
        this.inflight.delete(nsKey);
      }
    })();

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
    options?: { tags?: string[]; swr?: number },
  ): Promise<void> {
    const span = this._startSpan('tricache.set');
    span.setAttribute('cache.key', key);
    const nsKey = this.nk(key);
    const resolvedTtl = ttlSeconds ?? this.defaultTtl;
    const now = Date.now();
    const swrSeconds = options?.swr ?? 0;

    try {
      let activeTagVersions: Record<string, number> | undefined;
      if (options?.tags?.length) {
        activeTagVersions = await this._batchGetTagVersions(options.tags);
      }

      const serialized = JSON.stringify(value);
      const bytes = this._estimateBytes(nsKey, serialized);

      // Clean old entry if updating
      this._deleteL1(nsKey);
      this._evictIfNeeded(bytes);

      const entry: EdgeL1Entry<T> = {
        value,
        serialized,
        bytes,
        expiresAt: now + resolvedTtl * 1000,
        staleUntil: now + (resolvedTtl + swrSeconds) * 1000,
        tags: options?.tags,
        tagVersions: activeTagVersions,
      };

      this.l1.set(nsKey, entry);
      this.currentBytes += bytes;

      // Index tags
      if (options?.tags) {
        for (const tag of options.tags) {
          let s = this.tagIndex.get(tag);
          if (!s) {
            s = new Set<string>();
            this.tagIndex.set(tag, s);
          }
          s.add(nsKey);
        }
      }

      // Write to L2 Remote Storage if configured
      if (this.remoteStorage) {
        const toStoreRaw = activeTagVersions
          ? JSON.stringify({ __t_val: value, __t_tv: activeTagVersions })
          : serialized;
        const payloadToStore = this.enc.isEnabled ? await this.enc.encrypt(toStoreRaw) : toStoreRaw;
        await this.remoteStorage.set(nsKey, payloadToStore, resolvedTtl + swrSeconds);
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
   * Deletes a key from all tiers.
   */
  async delete(key: string): Promise<void> {
    const span = this._startSpan('tricache.delete');
    span.setAttribute('cache.key', key);
    const nsKey = this.nk(key);

    try {
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
   * Invalidates all cached entries associated with a tag.
   */
  async invalidateTag(tag: string): Promise<void> {
    const span = this._startSpan('tricache.invalidate_tag');
    span.setAttribute('cache.tag', tag);

    try {
      let newVer = 1;
      if (this.remoteStorage) {
        try {
          if (typeof this.remoteStorage.incrementTagVersion === 'function') {
            newVer = await this.remoteStorage.incrementTagVersion(this.nk(tag));
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

      // Update in-isolate version cache immediately (with 60s pin)
      this.tagVersionCache.set(tag, { version: newVer, expiresAt: Date.now() + 60_000 });

      // Invalidate local L1 entries
      const keys = this.tagIndex.get(tag);
      if (keys) {
        const keysArr = Array.from(keys);
        for (const k of keysArr) {
          this._deleteL1(k);
        }
        this.tagIndex.delete(tag);
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
   * Clears all entries from the edge cache.
   */
  async clear(): Promise<void> {
    const span = this._startSpan('tricache.clear');
    try {
      this.l1.clear();
      this.currentBytes = 0;
      this.tagIndex.clear();
      this.tagVersionCache.clear();
      if (this.remoteStorage) {
        await this.remoteStorage.clear?.(this.namespace || undefined);
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
   * Batch get with miss-fetching.
   */
  async mget<T>(
    keys: string[],
    fetchFn?: (missKeys: string[]) => Promise<Record<string, T>>,
    ttlSeconds?: number,
  ): Promise<(T | null)[]> {
    const span = this._startSpan('tricache.mget');
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
        for (let j = 0; j < missKeys.length; j++) {
          const k = missKeys[j];
          const fetchedVal = fetchedMap[k];
          if (fetchedVal !== undefined) {
            results[missIndices[j]] = fetchedVal;
            await this.set(k, fetchedVal, ttlSeconds);
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
