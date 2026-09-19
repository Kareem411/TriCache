import { Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER, type TriCacheStore } from 'tricache/nestjs';

export interface Note {
  id: string;
  body: string;
  writtenAt: string;
}

/**
 * Official @nestjs/cache-manager store path.
 *
 * `TriCacheModule` exports `CACHE_MANAGER` (token string `'CACHE_MANAGER'`)
 * bound to `TriCacheStore`. That class is the cache-manager v5/v6 CacheStore:
 * `get` / `set` / `del` / `reset` / `mget` / `mset` / `mdel` / `keys` / `ttl`.
 * `set(key, value, ttl)` takes **milliseconds**, matching Nest's cache-manager.
 */
@Injectable()
export class NotesService {
  constructor(
    @Inject(CACHE_MANAGER) readonly cacheStore: TriCacheStore,
  ) {}

  async read(id: string) {
    const key = noteKey(id);
    const note = await this.cacheStore.get<Note>(key);
    if (!note) {
      return { key, note: null, cache: 'miss' as const };
    }
    const ttlMs = await this.cacheStore.ttl(key);
    return { key, note, cache: 'hit' as const, ttlMs };
  }

  async write(id: string, body: string, ttlMs = 60_000) {
    const key = noteKey(id);
    const note: Note = { id, body, writtenAt: new Date().toISOString() };
    await this.cacheStore.set(key, note, ttlMs);
    return { key, note, cache: 'stored' as const, ttlMs };
  }

  async erase(id: string) {
    const key = noteKey(id);
    await this.cacheStore.del(key);
    return { key, cache: 'deleted' as const };
  }

  async listKeys() {
    const keys = await this.cacheStore.keys('note:');
    return { keys, store: 'TriCacheStore' };
  }
}

function noteKey(id: string): string {
  return `note:${id}`;
}
