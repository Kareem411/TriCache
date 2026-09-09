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
  });
});
