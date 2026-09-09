import { describe, it, expect, vi } from 'vitest';
import { UpstashRedisAdapter } from '../src/edge/adapters/upstash';
import { CloudflareKVAdapter } from '../src/edge/adapters/cloudflare-kv';
import { CloudflareDOStorageAdapter } from '../src/edge/adapters/cloudflare-do';
import type { CloudflareKVNamespace, CloudflareDOStorage } from '../src/edge/types';

describe('Universal Edge Portability: Edge Remote Storage Adapters', () => {
  describe('UpstashRedisAdapter (HTTPS REST)', () => {
    it('executes GET, SET with TTL, and DEL commands via REST JSON', async () => {
      const calls: Array<{ url: string; body: unknown }> = [];
      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        calls.push({ url: String(url), body });

        if (Array.isArray(body)) {
          const cmd = body[0];
          if (cmd === 'GET') {
            return { ok: true, json: async () => ({ result: 'cached-value' }) } as Response;
          }
          if (cmd === 'SET') {
            return { ok: true, json: async () => ({ result: 'OK' }) } as Response;
          }
          if (cmd === 'DEL') {
            return { ok: true, json: async () => ({ result: 1 }) } as Response;
          }
        }
        return { ok: true, json: async () => ({ result: null }) } as Response;
      }) as unknown as typeof globalThis.fetch;

      const upstash = new UpstashRedisAdapter({
        url: 'https://us1-mock.upstash.io',
        token: 'mock-token',
        fetch: mockFetch,
      });

      // 1. SET with TTL
      await upstash.set('user:101', '{"name":"Alice"}', 120);
      expect(calls[0].body).toEqual(['SET', 'user:101', '{"name":"Alice"}', 'EX', 120]);

      // 2. GET
      const val = await upstash.get('user:101');
      expect(val).toBe('cached-value');
      expect(calls[1].body).toEqual(['GET', 'user:101']);

      // 3. DEL
      await upstash.delete('user:101');
      expect(calls[2].body).toEqual(['DEL', 'user:101']);
    });

    it('handles Upstash command-level error envelopes gracefully', async () => {
      const mockFetch = vi.fn(async () => {
        return {
          ok: true,
          json: async () => ({ error: 'WRONGTYPE Operation against a key holding the wrong kind of value' }),
        } as Response;
      }) as unknown as typeof globalThis.fetch;

      const upstash = new UpstashRedisAdapter({
        url: 'https://us1-mock.upstash.io',
        token: 'mock-token',
        fetch: mockFetch,
      });

      await expect(upstash.get('invalid-key')).rejects.toThrow(
        /WRONGTYPE Operation against a key holding the wrong kind of value/,
      );
    });

    it('handles batch mset via /pipeline endpoint', async () => {
      let pipelineCalled = false;
      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith('/pipeline')) {
          pipelineCalled = true;
          return {
            ok: true,
            json: async () => [{ result: 'OK' }, { result: 'OK' }],
          } as Response;
        }
        return { ok: true, json: async () => ({ result: null }) } as Response;
      }) as unknown as typeof globalThis.fetch;

      const upstash = new UpstashRedisAdapter({
        url: 'https://us1-mock.upstash.io',
        token: 'mock-token',
        fetch: mockFetch,
      });

      await upstash.mset({ k1: 'v1', k2: 'v2' }, 60);
      expect(pipelineCalled).toBe(true);
    });
    it('throws actionable error when fetch returns HTTP non-200', async () => {
      const mockFetch = vi.fn(async () => ({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => 'Cluster failover in progress',
      })) as unknown as typeof globalThis.fetch;

      const upstash = new UpstashRedisAdapter({
        url: 'https://us1-mock.upstash.io',
        token: 'mock-token',
        fetch: mockFetch,
      });

      await expect(upstash.get('fail-key')).rejects.toThrow(
        /Upstash HTTP error \(503 Service Unavailable\): Cluster failover in progress/,
      );
    });

    it('executes batch mget with mixed hits and misses', async () => {
      const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        if (Array.isArray(body) && body[0] === 'MGET') {
          return {
            ok: true,
            json: async () => ({ result: ['hit1', null, 'hit3'] }),
          } as Response;
        }
        return { ok: true, json: async () => ({ result: null }) } as Response;
      }) as unknown as typeof globalThis.fetch;

      const upstash = new UpstashRedisAdapter({
        url: 'https://us1-mock.upstash.io',
        token: 'mock-token',
        fetch: mockFetch,
      });

      const res = await upstash.mget(['k1', 'k2', 'k3']);
      expect(res).toEqual(['hit1', null, 'hit3']);
    });

    it('clears keys matching a prefix via KEYS and DEL', async () => {
      const executed: unknown[][] = [];
      const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        executed.push(body);
        if (body[0] === 'KEYS') {
          return { ok: true, json: async () => ({ result: ['tenant:1', 'tenant:2'] }) } as Response;
        }
        return { ok: true, json: async () => ({ result: 2 }) } as Response;
      }) as unknown as typeof globalThis.fetch;

      const upstash = new UpstashRedisAdapter({
        url: 'https://us1-mock.upstash.io',
        token: 'mock-token',
        fetch: mockFetch,
      });

      await upstash.clear('tenant:');
      expect(executed[0]).toEqual(['KEYS', 'tenant:*']);
      expect(executed[1]).toEqual(['DEL', 'tenant:1', 'tenant:2']);
    });
  });

  describe('CloudflareKVAdapter (Sub-minute TTL mitigation)', () => {
    it('stores sub-minute TTL in logical envelope and clamps KV TTL to 60s minimum', async () => {
      const kvStore = new Map<string, string>();
      const kvPutOptions: Record<string, { expirationTtl?: number }> = {};

      const mockKV: CloudflareKVNamespace = {
        async get(key: string) {
          return kvStore.get(key) ?? null;
        },
        async put(key: string, value: string, options?: { expirationTtl?: number }) {
          kvStore.set(key, value);
          if (options) kvPutOptions[key] = options;
        },
        async delete(key: string) {
          kvStore.delete(key);
        },
      };

      const adapter = new CloudflareKVAdapter(mockKV);

      // Store with 5-second TTL (< 60s minimum)
      await adapter.set('short-key', 'ephemeral-data', 5);

      // KV expirationTtl must be clamped to 60s
      expect(kvPutOptions['short-key']?.expirationTtl).toBe(60);

      // Stored data must contain logical envelope with exp timestamp
      const rawStored = kvStore.get('short-key');
      expect(rawStored).toBeDefined();
      expect(rawStored).toContain('"val":"ephemeral-data"');
      expect(rawStored).toContain('"exp":');

      // Immediate read returns unwrapped value
      const val = await adapter.get('short-key');
      expect(val).toBe('ephemeral-data');

      // Test expired logical envelope
      const expiredEnvelope = JSON.stringify({ exp: Date.now() - 1000, val: 'ephemeral-data' });
      kvStore.set('expired-key', expiredEnvelope);

      const expiredVal = await adapter.get('expired-key');
      expect(expiredVal).toBeNull();
      // Should have deleted key
      expect(kvStore.has('expired-key')).toBe(false);
    });

    it('passes standard >=60s TTL directly to KV expirationTtl', async () => {
      const kvStore = new Map<string, string>();
      let capturedTtl: number | undefined;

      const mockKV: CloudflareKVNamespace = {
        async get(key: string) { return kvStore.get(key) ?? null; },
        async put(key: string, value: string, options?: { expirationTtl?: number }) {
          kvStore.set(key, value);
          capturedTtl = options?.expirationTtl;
        },
        async delete(key: string) { kvStore.delete(key); },
      };

      const adapter = new CloudflareKVAdapter(mockKV);
      await adapter.set('long-key', 'durable-data', 300);

      expect(capturedTtl).toBe(300);
      expect(kvStore.get('long-key')).toBe('durable-data');
      expect(await adapter.get('long-key')).toBe('durable-data');
    });

    it('clears paginated keys using cursor loop', async () => {
      const kvStore = new Map<string, string>([
        ['cache:1', 'v1'],
        ['cache:2', 'v2'],
        ['cache:3', 'v3'],
      ]);

      let listCallCount = 0;
      const mockKV: CloudflareKVNamespace = {
        async get(k: string) { return kvStore.get(k) ?? null; },
        async put(k: string, v: string) { kvStore.set(k, v); },
        async delete(k: string) { kvStore.delete(k); },
        async list(options?: { prefix?: string; cursor?: string }) {
          listCallCount++;
          if (!options?.cursor) {
            return {
              keys: [{ name: 'cache:1' }, { name: 'cache:2' }],
              list_complete: false,
              cursor: 'cursor-page-2',
            };
          }
          return {
            keys: [{ name: 'cache:3' }],
            list_complete: true,
          };
        },
      };

      const adapter = new CloudflareKVAdapter(mockKV);
      await adapter.clear('cache:');

      expect(listCallCount).toBe(2);
      expect(kvStore.size).toBe(0);
    });

    it('performs batch mget and mset on Cloudflare KV', async () => {
      const kvStore = new Map<string, string>();
      const mockKV: CloudflareKVNamespace = {
        async get(k: string) { return kvStore.get(k) ?? null; },
        async put(k: string, v: string) { kvStore.set(k, v); },
        async delete(k: string) { kvStore.delete(k); },
      };

      const adapter = new CloudflareKVAdapter(mockKV);
      await adapter.mset({ 'item:1': 'A', 'item:2': 'B' }, 120);

      const res = await adapter.mget(['item:1', 'item:2', 'item:3']);
      expect(res).toEqual(['A', 'B', null]);
    });
  });

  describe('CloudflareDOStorageAdapter (Durable Objects)', () => {
    it('stores, retrieves, and handles expiration in transactional storage', async () => {
      const doMap = new Map<string, unknown>();

      const mockDO: CloudflareDOStorage = {
        async get<T = unknown>(key: string): Promise<T | undefined> {
          return doMap.get(key) as T;
        },
        async put<T = unknown>(key: string, value: T): Promise<void> {
          doMap.set(key, value);
        },
        async delete(key: string): Promise<boolean> {
          return doMap.delete(key);
        },
      } as CloudflareDOStorage;

      const adapter = new CloudflareDOStorageAdapter(mockDO);

      await adapter.set('session:1', 'user-session-state', 3600);
      const val = await adapter.get('session:1');
      expect(val).toBe('user-session-state');

      await adapter.delete('session:1');
      expect(await adapter.get('session:1')).toBeNull();
    });

    it('performs batch mset and mget on Durable Object storage', async () => {
      const doMap = new Map<string, unknown>();

      const mockDO: CloudflareDOStorage = {
        async get<T = unknown>(keys: string[]): Promise<Map<string, T>> {
          const m = new Map<string, T>();
          for (const k of keys) {
            if (doMap.has(k)) m.set(k, doMap.get(k) as T);
          }
          return m;
        },
        async put<T = unknown>(entries: Record<string, T>): Promise<void> {
          for (const [k, v] of Object.entries(entries)) {
            doMap.set(k, v);
          }
        },
        async delete(keys: string[]): Promise<number> {
          let count = 0;
          for (const k of keys) {
            if (doMap.delete(k)) count++;
          }
          return count;
        },
      } as unknown as CloudflareDOStorage;

      const adapter = new CloudflareDOStorageAdapter(mockDO);
      await adapter.mset({ a: '1', b: '2' }, 300);

      const res = await adapter.mget(['a', 'b', 'c']);
      expect(res).toEqual(['1', '2', null]);
    });

    it('clears keys matching a prefix from Durable Object storage', async () => {
      const doMap = new Map<string, unknown>([
        ['tenant:1', 'val1'],
        ['tenant:2', 'val2'],
        ['other:3', 'val3'],
      ]);

      const mockDO: CloudflareDOStorage = {
        async list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>> {
          const m = new Map<string, T>();
          for (const [k, v] of doMap.entries()) {
            if (!options?.prefix || k.startsWith(options.prefix)) {
              m.set(k, v as T);
            }
          }
          return m;
        },
        async delete(keys: string[]): Promise<number> {
          let c = 0;
          for (const k of keys) {
            if (doMap.delete(k)) c++;
          }
          return c;
        },
      } as unknown as CloudflareDOStorage;

      const adapter = new CloudflareDOStorageAdapter(mockDO);
      await adapter.clear('tenant:');

      expect(doMap.has('tenant:1')).toBe(false);
      expect(doMap.has('tenant:2')).toBe(false);
      expect(doMap.has('other:3')).toBe(true);
    });
  });
});
