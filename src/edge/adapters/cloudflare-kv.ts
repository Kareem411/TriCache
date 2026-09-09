import type { IEdgeRemoteStorage, CloudflareKVNamespace } from '../types';

interface SubMinuteEnvelope {
  exp: number;
  val: string;
}

const MIN_CF_KV_TTL = 60; // Cloudflare KV requires expirationTtl >= 60s

/**
 * Storage adapter for Cloudflare Workers KV.
 *
 * Mitigates Cloudflare KV's strict 60-second TTL floor by wrapping sub-minute
 * TTLs in a lightweight timestamp envelope and validating expiry on read.
 */
export class CloudflareKVAdapter implements IEdgeRemoteStorage {
  private readonly kv: CloudflareKVNamespace;

  constructor(kv: CloudflareKVNamespace) {
    if (!kv) {
      throw new Error('CloudflareKVAdapter: KVNamespace instance is required.');
    }
    this.kv = kv;
  }

  async get(key: string): Promise<string | null> {
    const raw = await this.kv.get(key, { type: 'text' });
    if (raw === null) return null;

    // Check if entry was wrapped in a sub-minute logical envelope
    if (raw.startsWith('{"exp":') && raw.includes('"val":')) {
      try {
        const parsed = JSON.parse(raw) as SubMinuteEnvelope;
        if (typeof parsed.exp === 'number' && typeof parsed.val === 'string') {
          if (Date.now() >= parsed.exp) {
            // Expired logically — eagerly clean up and return null
            void this.kv.delete(key).catch(() => {});
            return null;
          }
          return parsed.val;
        }
      } catch {
        // Fallback to returning raw if parsing fails
      }
    }

    return raw;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (typeof ttlSeconds === 'number' && ttlSeconds > 0) {
      if (ttlSeconds < MIN_CF_KV_TTL) {
        // Sub-minute TTL: store expiration timestamp envelope and clamp KV TTL to minimum 60s
        const envelope: SubMinuteEnvelope = {
          exp: Date.now() + Math.round(ttlSeconds * 1000),
          val: value,
        };
        await this.kv.put(key, JSON.stringify(envelope), { expirationTtl: MIN_CF_KV_TTL });
      } else {
        await this.kv.put(key, value, { expirationTtl: Math.round(ttlSeconds) });
      }
    } else {
      await this.kv.put(key, value);
    }
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    return Promise.all(keys.map(k => this.get(k)));
  }

  async mset(entries: Record<string, string>, ttlSeconds?: number): Promise<void> {
    const keys = Object.keys(entries);
    await Promise.all(keys.map(k => this.set(k, entries[k], ttlSeconds)));
  }

  async clear(prefix?: string): Promise<void> {
    if (!this.kv.list) return;

    let cursor: string | undefined;
    do {
      const res = await this.kv.list({ prefix, cursor });
      if (res.keys.length > 0) {
        await Promise.all(res.keys.map(item => this.kv.delete(item.name)));
      }
      cursor = res.list_complete ? undefined : res.cursor;
    } while (cursor);
  }
}
