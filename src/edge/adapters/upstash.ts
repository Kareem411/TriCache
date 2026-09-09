import type { IEdgeRemoteStorage, UpstashRedisOptions } from '../types';

/**
 * High-performance HTTP-based Redis driver for Upstash.
 * Compatible with pure V8 Edge Isolates (Cloudflare Workers, Vercel Edge, Fastly Compute).
 *
 * Communicates over HTTPS REST with zero native socket dependencies.
 */
export class UpstashRedisAdapter implements IEdgeRemoteStorage {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly customFetch: typeof globalThis.fetch;

  constructor(options: UpstashRedisOptions) {
    if (!options?.url || !options?.token) {
      throw new Error('UpstashRedisAdapter: url and token are required.');
    }
    this.baseUrl = options.url.replace(/\/+$/, '');
    this.token = options.token;
    this.customFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async _executeCommand<T = unknown>(command: unknown[]): Promise<T> {
    const res = await this.customFetch(this.baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Upstash HTTP error (${res.status} ${res.statusText}): ${text}`);
    }

    const json = (await res.json()) as { result?: T; error?: string };
    if (json.error) {
      throw new Error(`Upstash Redis command error: ${json.error}`);
    }

    return json.result as T;
  }

  private async _executePipeline<T = unknown>(commands: unknown[][]): Promise<T[]> {
    const res = await this.customFetch(`${this.baseUrl}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Upstash Pipeline error (${res.status} ${res.statusText}): ${text}`);
    }

    const json = (await res.json()) as Array<{ result?: T; error?: string }>;
    return json.map(item => {
      if (item.error) {
        throw new Error(`Upstash Redis pipeline item error: ${item.error}`);
      }
      return item.result as T;
    });
  }

  async get(key: string): Promise<string | null> {
    const res = await this._executeCommand<string | null>(['GET', key]);
    return res ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (typeof ttlSeconds === 'number' && ttlSeconds > 0) {
      await this._executeCommand(['SET', key, value, 'EX', Math.round(ttlSeconds)]);
    } else {
      await this._executeCommand(['SET', key, value]);
    }
  }

  async delete(key: string): Promise<void> {
    await this._executeCommand(['DEL', key]);
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return [];
    const res = await this._executeCommand<(string | null)[]>(['MGET', ...keys]);
    return Array.isArray(res) ? res : [];
  }

  async mset(entries: Record<string, string>, ttlSeconds?: number): Promise<void> {
    const keys = Object.keys(entries);
    if (keys.length === 0) return;

    if (typeof ttlSeconds === 'number' && ttlSeconds > 0) {
      const roundedTtl = Math.round(ttlSeconds);
      const commands = keys.map(k => ['SET', k, entries[k], 'EX', roundedTtl]);
      await this._executePipeline(commands);
    } else {
      const args: string[] = [];
      for (const k of keys) {
        args.push(k, entries[k]);
      }
      await this._executeCommand(['MSET', ...args]);
    }
  }

  async clear(prefix?: string): Promise<void> {
    if (prefix) {
      const pattern = prefix.endsWith('*') ? prefix : `${prefix}*`;
      const keys = await this._executeCommand<string[]>(['KEYS', pattern]);
      if (Array.isArray(keys) && keys.length > 0) {
        await this._executeCommand(['DEL', ...keys]);
      }
    } else {
      await this._executeCommand(['FLUSHDB']);
    }
  }
}
