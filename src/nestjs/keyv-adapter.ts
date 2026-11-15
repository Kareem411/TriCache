import { EventEmitter } from 'node:events';
import type { CacheService } from '../cache-service.js';

/**
 * Relative-millisecond storage adapter for Keyv 5 / cache-manager 7.
 * Wrap it in Keyv before passing it to Nest's CacheModule. Unlike TriCacheStore,
 * this is a storage adapter, not the injected cache-manager facade.
 * The supplied engine remains caller-owned when Keyv disconnects.
 */
export class TriCacheKeyvAdapter extends EventEmitter {
  private _namespace?: string;

  constructor(public readonly cache: CacheService) { super(); }

  get namespace(): string | undefined { return this._namespace; }
  set namespace(value: string | undefined) {
    if (value && ['*', '?', '[', ']', '\\'].some(character => value.includes(character))) {
      throw new Error('Keyv namespace must not contain glob characters');
    }
    this._namespace = value;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const value = await this.cache.peek<T>(key);
    return value === null ? undefined : value;
  }

  async set(key: string, value: unknown, ttl?: number): Promise<boolean> {
    if (ttl !== undefined && (!Number.isFinite(ttl) || ttl < 0)) throw new Error('Keyv TTL must be finite and non-negative');
    const ttlSeconds = ttl === undefined ? 0 : ttl / 1000;
    await this.cache.set(key, value, ttlSeconds);
    return true;
  }

  async delete(key: string): Promise<boolean> {
    const found = await this.has(key);
    await this.cache.delete(key);
    return found;
  }

  async clear(): Promise<void> {
    await this.cache.clear(this._namespace ? `${this._namespace}:` : undefined);
  }

  async has(key: string): Promise<boolean> { return await this.cache.peek(key) !== null; }

  async getMany<T = unknown>(keys: string[]): Promise<(T | undefined)[]> {
    return this.cache.mget<T>(keys);
  }

  async deleteMany(keys: string[]): Promise<boolean> {
    const found = await this.cache.mget(keys);
    await this.cache.mdel(keys);
    return found.every(value => value !== undefined && value !== null);
  }

  async setMany(entries: Array<{ key: string; value: unknown; ttl?: number }>): Promise<boolean[]> {
    const results = await Promise.all(entries.map(entry => this.set(entry.key, entry.value, entry.ttl)));
    return results;
  }

  async hasMany(keys: string[]): Promise<boolean[]> {
    const values = await this.cache.mget(keys);
    return values.map(value => value !== null && value !== undefined);
  }

  async disconnect(): Promise<void> { /* The caller owns and closes the shared engine. */ }
}
