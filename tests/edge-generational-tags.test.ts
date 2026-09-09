import { describe, it, expect, vi } from 'vitest';
import { EdgeCacheService, CloudflareKVAdapter, CloudflareDOStorageAdapter } from '../src/edge';
import type { IEdgeRemoteStorage, CloudflareKVNamespace, CloudflareDOStorage } from '../src/edge';

describe('Edge Generational Tag Synchronization (Phase 3 & Guardrail 3)', () => {
  it('CloudflareKVAdapter generates monotonic timestamp versions on incrementTagVersion', async () => {
    const store = new Map<string, string>();
    const mockKv: CloudflareKVNamespace = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, val: string) => { store.set(key, val); }),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
    };

    const adapter = new CloudflareKVAdapter(mockKv);

    const v1 = await adapter.incrementTagVersion('users');
    expect(v1).toBeGreaterThanOrEqual(1);

    const v2 = await adapter.incrementTagVersion('users');
    expect(v2).toBeGreaterThan(v1);

    const storedVer = await adapter.getTagVersion('users');
    expect(storedVer).toBe(v2);
  });

  it('CloudflareDOStorageAdapter performs transactional tag increments', async () => {
    const map = new Map<string, unknown>();
    const mockDo = {
      get: vi.fn(async (keys: string | string[]) => {
        if (Array.isArray(keys)) {
          const res = new Map<string, unknown>();
          for (const k of keys) {
            if (map.has(k)) res.set(k, map.get(k));
          }
          return res;
        }
        return map.get(keys);
      }),
      put: vi.fn(async (entries: Record<string, unknown> | string, val?: unknown) => {
        if (typeof entries === 'string') {
          map.set(entries, val);
        } else {
          for (const [k, v] of Object.entries(entries)) map.set(k, v);
        }
      }),
      delete: vi.fn(async (keys: string | string[]) => {
        if (Array.isArray(keys)) keys.forEach(k => map.delete(k));
        else map.delete(keys);
        return true;
      }),
    } as unknown as CloudflareDOStorage;

    const adapter = new CloudflareDOStorageAdapter(mockDo);
    const ver1 = await adapter.incrementTagVersion('catalog');
    expect(ver1).toBe(1);

    const ver2 = await adapter.incrementTagVersion('catalog');
    expect(ver2).toBe(2);

    const current = await adapter.getTagVersion('catalog');
    expect(current).toBe(2);
  });

  it('synchronizes generational tag invalidation across edge isolates without cross-isolate desync', async () => {
    // Shared mock storage simulating remote Upstash Redis or KV across edge PoPs
    const remoteData = new Map<string, string>();
    const tagVersions = new Map<string, number>();

    const sharedRemoteStorage: IEdgeRemoteStorage = {
      async get(key: string) {
        return remoteData.get(key) ?? null;
      },
      async set(key: string, value: string) {
        remoteData.set(key, value);
      },
      async delete(key: string) {
        remoteData.delete(key);
      },
      async getTagVersion(tag: string) {
        return tagVersions.get(tag) ?? 1;
      },
      async incrementTagVersion(tag: string) {
        const current = tagVersions.get(tag) ?? 1;
        const next = current + 1;
        tagVersions.set(tag, next);
        return next;
      },
      async batchGetTagVersions(tags: string[]) {
        const res: Record<string, number> = {};
        for (const t of tags) res[t] = tagVersions.get(t) ?? 1;
        return res;
      },
    };

    // Simulate two edge isolates running in separate PoPs
    const isolateFrankfurt = new EdgeCacheService({ remoteStorage: sharedRemoteStorage });
    const isolateSanJose = new EdgeCacheService({ remoteStorage: sharedRemoteStorage });

    let dbFetchCount = 0;
    const fetchDoc = async () => {
      dbFetchCount++;
      return { id: 101, title: 'Quarterly Report' };
    };

    // 1. Isolate Frankfurt writes doc:101 with tag 'finance'
    await isolateFrankfurt.get('doc:101', fetchDoc, 300, { tags: ['finance'] });
    expect(dbFetchCount).toBe(1);

    // 2. Isolate San Jose reads doc:101 from remote L2
    const sjResult = await isolateSanJose.get('doc:101', fetchDoc, 300, { tags: ['finance'] });
    expect(sjResult).toEqual({ id: 101, title: 'Quarterly Report' });
    expect(dbFetchCount).toBe(1); // fetched from L2, not DB

    // 3. Both isolates now hold the value in their local L1 memory
    expect(isolateFrankfurt.stats().keys).toBe(1);
    expect(isolateSanJose.stats().keys).toBe(1);

    // 4. An admin webhook hits Isolate San Jose: invalidateTag('finance')
    await isolateSanJose.invalidateTag('finance');

    // Remote tag version is now incremented
    expect(tagVersions.get('finance')).toBe(2);

    // 5. Wait for the 800ms in-isolate micro-TTL to elapse
    await new Promise(r => setTimeout(r, 850));

    // Isolate Frankfurt now reads doc:101
    // Its L1 detects that local entry version (1) < remote tag version (2)
    // and evicts the stale entry, re-triggering fetchDoc!
    const freshFrankfurt = await isolateFrankfurt.get('doc:101', fetchDoc, 300, { tags: ['finance'] });
    expect(freshFrankfurt).toEqual({ id: 101, title: 'Quarterly Report' });
    expect(dbFetchCount).toBe(2); // re-fetched fresh from upstream!
  });

  it('in-isolate micro-TTL prevents HTTP fetch amplification on rapid L1 reads', async () => {
    let getTagVersionCalls = 0;
    const mockStorage: IEdgeRemoteStorage = {
      async get() { return null; },
      async set() {},
      async delete() {},
      async getTagVersion() {
        getTagVersionCalls++;
        return 1;
      },
    };

    const edgeCache = new EdgeCacheService({ remoteStorage: mockStorage });

    // Populate L1 with tagged entry
    await edgeCache.set('item:1', { name: 'Chair' }, 60, { tags: ['furniture'] });

    // First read: reads tag version from remote storage
    await edgeCache.get('item:1');
    const firstCallCount = getTagVersionCalls;

    // Subsequent 5 rapid reads within micro-TTL (800ms)
    for (let i = 0; i < 5; i++) {
      await edgeCache.get('item:1');
    }

    // Assert zero additional remote calls were made during the micro-TTL window
    expect(getTagVersionCalls).toBe(firstCallCount);
  });
});
