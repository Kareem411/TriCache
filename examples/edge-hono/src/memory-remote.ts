import type { IEdgeRemoteStorage } from 'tricache/edge';

interface MemoryRemoteEntry {
  value: string;
  expiresAt?: number;
}

/**
 * In-isolate L2 stand-in implementing the published `IEdgeRemoteStorage` contract.
 *
 * Production Workers should swap this for `CloudflareKVAdapter` or `UpstashRedisAdapter`.
 * The demo keeps L2 in-memory so Bloom-filter cold-miss skips are observable
 * (`getCount` does not increase when `Murmur3BloomFilter.mightContain` is false).
 */
export class MemoryRemoteStorage implements IEdgeRemoteStorage {
  private readonly store = new Map<string, MemoryRemoteEntry>();
  getCount = 0;

  async get(key: string): Promise<string | null> {
    this.getCount += 1;
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const expiresAt =
      typeof ttlSeconds === 'number' && ttlSeconds > 0
        ? Date.now() + Math.round(ttlSeconds * 1000)
        : undefined;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(prefix?: string): Promise<void> {
    if (!prefix) {
      this.store.clear();
      return;
    }
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }
}
