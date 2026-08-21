import type { CacheService } from '../index.js';
import type { NestCacheStore } from './types.js';

/**
 * TriCacheStore — drop-in CacheStore conforming to @nestjs/cache-manager and cache-manager v5/v6.
 *
 * Implements millisecond-based TTL semantics expected by cache-manager v5/v6
 * while dispatching to TriCache's three-tier engine with L1 memory, L1.5 NVMe disk spill,
 * and L2 Redis/Valkey tiers.
 */
export class TriCacheStore implements NestCacheStore {
  constructor(public readonly cache: CacheService) {}

  /**
   * Retrieve an item from the cache.
   * Returns undefined on miss (matching cache-manager v5/v6 contract).
   */
  async get<T>(key: string): Promise<T | undefined> {
    const val = await this.cache.peek<T>(key);
    return val !== null ? val : undefined;
  }

  /**
   * Set an item in the cache.
   * @param key   - Cache key
   * @param value - Cache value
   * @param ttl   - TTL in milliseconds (0 = indefinite / default engine TTL)
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    const ttlSeconds = typeof ttl === 'number' && ttl > 0 ? Math.round(ttl / 1000) : (ttl === 0 ? 0 : undefined);
    await this.cache.set(key, value, ttlSeconds);
  }

  /**
   * Remove an item from the cache.
   */
  async del(key: string): Promise<void> {
    await this.cache.delete(key);
  }

  /**
   * Clear the entire cache namespace.
   */
  async reset(): Promise<void> {
    await this.cache.clear();
  }

  /**
   * Batch get multiple items from the cache.
   */
  async mget<T>(...keys: string[]): Promise<(T | undefined)[]> {
    if (keys.length === 0) return [];
    return this.cache.mget<T>(keys, async () => ({}));
  }

  /**
   * Batch set multiple entries with per-entry millisecond TTL.
   */
  async mset(entries: Array<{ key: string; value: unknown; ttl?: number }>): Promise<void> {
    if (entries.length === 0) return;
    const batch: Record<string, { value: unknown; ttl?: number }> = {};
    for (const e of entries) {
      batch[e.key] = {
        value: e.value,
        ttl: typeof e.ttl === 'number' && e.ttl > 0 ? Math.round(e.ttl / 1000) : (e.ttl === 0 ? 0 : undefined),
      };
    }
    await this.cache.mset(batch);
  }

  /**
   * Batch delete multiple keys.
   */
  async mdel(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.cache.mdel(keys);
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
}
