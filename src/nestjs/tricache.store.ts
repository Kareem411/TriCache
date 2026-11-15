import type { CacheService } from '../index.js';
import type { NestCacheStore } from './types.js';
import { EventEmitter } from 'node:events';

/**
 * TriCacheStore — Nest CACHE_MANAGER facade for CacheInterceptor and basic cache calls.
 *
 * Implements millisecond-based TTL semantics for cache-manager v7's common API
 * while dispatching to TriCache's three-tier engine with L1 memory, L1.5 disk spill,
 * and L2 Redis/Valkey tiers.
 */
export class TriCacheStore extends EventEmitter implements NestCacheStore {
  constructor(public readonly cache: CacheService) { super(); }

  /**
   * Retrieve an item from the cache.
   * Returns undefined on miss (matching Keyv/cache-manager contract).
   */
  async get<T>(key: string): Promise<T | undefined>;
  async get<T>(key: string, options: { raw: true }): Promise<{ value: T; expires?: number } | undefined>;
  async get<T>(key: string, options?: { raw?: boolean }): Promise<T | { value: T; expires?: number } | undefined> {
    const val = await this.cache.peek<T>(key);
    if (val === null) return undefined;
    if (options?.raw) {
      const remaining = this.cache.ttl(key);
      return { value: val, expires: remaining === null ? undefined : Date.now() + remaining * 1000 };
    }
    return val;
  }

  /**
   * Set an item in the cache.
   * @param key   - Cache key
   * @param value - Cache value
   * @param ttl   - TTL in milliseconds (0 = indefinite / default engine TTL)
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<T> {
    const ttlSeconds = typeof ttl === 'number' && ttl > 0 ? ttl / 1000 : (ttl === 0 ? 0 : undefined);
    await this.cache.set(key, value, ttlSeconds);
    return value;
  }

  /**
   * Remove an item from the cache.
   */
  async del(key: string): Promise<boolean> {
    await this.cache.delete(key);
    return true;
  }

  /**
   * Clear the entire cache namespace.
   */
  async reset(): Promise<boolean> {
    await this.cache.clear();
    return true;
  }

  /**
   * Batch get multiple items from the cache. Accepts cache-manager 7's key array
   * and the legacy cache-store variadic form.
   */
  async mget<T>(keys: string[]): Promise<(T | undefined)[]>;
  async mget<T>(...keys: string[]): Promise<(T | undefined)[]>;
  async mget<T>(keysOrFirst: string[] | string = [], ...rest: string[]): Promise<(T | undefined)[]> {
    const keys = Array.isArray(keysOrFirst) ? keysOrFirst : [keysOrFirst, ...rest];
    if (keys.length === 0) return [];
    return this.cache.mget<T>(keys);
  }

  /**
   * Batch set multiple entries with per-entry millisecond TTL.
   */
  async mset(entries: Array<{ key: string; value: unknown; ttl?: number }>): Promise<Array<{ key: string; value: unknown; ttl?: number }>> {
    if (entries.length === 0) return [];
    const batch: Record<string, { value: unknown; ttl?: number }> = {};
    for (const e of entries) {
      batch[e.key] = {
        value: e.value,
        ttl: typeof e.ttl === 'number' && e.ttl > 0 ? e.ttl / 1000 : (e.ttl === 0 ? 0 : undefined),
      };
    }
    await this.cache.mset(batch);
    return entries;
  }

  /**
   * Batch delete multiple keys.
   */
  async mdel(keys: string[]): Promise<boolean>;
  async mdel(...keys: string[]): Promise<boolean>;
  async mdel(keysOrFirst: string[] | string = [], ...rest: string[]): Promise<boolean> {
    const keys = Array.isArray(keysOrFirst) ? keysOrFirst : [keysOrFirst, ...rest];
    if (keys.length === 0) return true;
    await this.cache.mdel(keys);
    return true;
  }

  /**
   * Scan keys currently resident in the cache.
   */
  async keys(pattern?: string): Promise<string[]> {
    const all: string[] = [];
    for (const k of this.cache.keys()) {
      if (!pattern || k.includes(pattern)) all.push(k);
    }
    return all;
  }

  /**
   * Get remaining TTL for a key in milliseconds.
   */
  async ttl(key: string): Promise<number | undefined> {
    const rem = this.cache.ttl(key);
    return rem !== null ? rem * 1000 : undefined;
  }

  async wrap<T>(key: string, fetch: () => T | Promise<T>, ttl?: number, refreshThreshold?: number): Promise<T> {
    const seconds = ttl === undefined ? 0 : ttl / 1000;
    const refreshAhead = ttl && refreshThreshold ? Math.max(0, Math.min(1, (ttl - refreshThreshold) / ttl)) : undefined;
    return this.cache.wrap(key, async () => await fetch(), { ttl: seconds, refreshAhead });
  }

  cacheId(): string { return `tricache:${this.cache.options.namespace ?? 'default'}`; }
  get stores(): unknown[] { return [this]; }
  async clear(): Promise<boolean> { await this.reset(); return true; }
  async disconnect(): Promise<undefined> { return undefined; }
}
