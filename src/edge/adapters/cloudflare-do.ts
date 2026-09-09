import type { IEdgeRemoteStorage, CloudflareDOStorage } from '../types';

interface DOEntry {
  val: string;
  exp: number; // 0 = no expiration
}

/**
 * Storage adapter for Cloudflare Durable Objects transactional storage (`state.storage`).
 * Enables strongly-consistent edge caching and coordination across edge isolates.
 */
export class CloudflareDOStorageAdapter implements IEdgeRemoteStorage {
  private readonly storage: CloudflareDOStorage;

  constructor(storage: CloudflareDOStorage) {
    if (!storage) {
      throw new Error('CloudflareDOStorageAdapter: DurableObjectStorage instance is required.');
    }
    this.storage = storage;
  }

  async get(key: string): Promise<string | null> {
    const entry = await this.storage.get<DOEntry | string>(key);
    if (entry === undefined || entry === null) return null;

    if (typeof entry === 'object' && 'val' in entry && 'exp' in entry) {
      if (entry.exp > 0 && Date.now() >= entry.exp) {
        void this.storage.delete(key).catch(() => {});
        return null;
      }
      return entry.val;
    }

    return String(entry);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const exp = typeof ttlSeconds === 'number' && ttlSeconds > 0
      ? Date.now() + Math.round(ttlSeconds * 1000)
      : 0;

    const entry: DOEntry = { val: value, exp };
    await this.storage.put(key, entry);
  }

  async delete(key: string): Promise<void> {
    await this.storage.delete(key);
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return [];
    const map = await this.storage.get<DOEntry | string>(keys);
    const now = Date.now();
    const result: (string | null)[] = [];

    for (const k of keys) {
      const entry = map.get(k);
      if (entry === undefined || entry === null) {
        result.push(null);
      } else if (typeof entry === 'object' && 'val' in entry && 'exp' in entry) {
        if (entry.exp > 0 && now >= entry.exp) {
          void this.storage.delete(k).catch(() => {});
          result.push(null);
        } else {
          result.push(entry.val);
        }
      } else {
        result.push(String(entry));
      }
    }

    return result;
  }

  async mset(entries: Record<string, string>, ttlSeconds?: number): Promise<void> {
    const exp = typeof ttlSeconds === 'number' && ttlSeconds > 0
      ? Date.now() + Math.round(ttlSeconds * 1000)
      : 0;

    const record: Record<string, DOEntry> = {};
    for (const [k, v] of Object.entries(entries)) {
      record[k] = { val: v, exp };
    }
    await this.storage.put(record);
  }

  async clear(prefix?: string): Promise<void> {
    if (!this.storage.list) return;

    const map = await this.storage.list({ prefix });
    const keysToDelete = Array.from(map.keys());
    if (keysToDelete.length > 0) {
      await this.storage.delete(keysToDelete);
    }
  }

  async incrementTagVersion(tag: string): Promise<number> {
    const key = `tag_ver:${tag}`;
    const raw = await this.storage.get<DOEntry>(key);
    const prev = (raw && typeof raw === 'object' && 'val' in raw)
      ? parseInt(raw.val, 10) || 0
      : (typeof raw === 'string' ? parseInt(raw, 10) || 0 : 0);
    const nextVer = prev + 1;
    await this.storage.put(key, { val: String(nextVer), exp: 0 });
    return nextVer;
  }

  async getTagVersion(tag: string): Promise<number> {
    const raw = await this.storage.get<DOEntry>(`tag_ver:${tag}`);
    if (raw && typeof raw === 'object' && 'val' in raw) {
      return parseInt(raw.val, 10) || 1;
    }
    return typeof raw === 'string' ? parseInt(raw, 10) || 1 : 1;
  }

  async batchGetTagVersions(tags: string[]): Promise<Record<string, number>> {
    const keys = tags.map(t => `tag_ver:${t}`);
    const map = await this.storage.get<DOEntry>(keys);
    const result: Record<string, number> = {};
    for (const tag of tags) {
      const entry = map.get(`tag_ver:${tag}`);
      if (entry && typeof entry === 'object' && 'val' in entry) {
        result[tag] = parseInt(entry.val, 10) || 1;
      } else {
        result[tag] = typeof entry === 'string' ? parseInt(entry, 10) || 1 : 1;
      }
    }
    return result;
  }
}
