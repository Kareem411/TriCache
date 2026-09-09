import { describe, it, expect, beforeEach } from 'vitest';
import {
  murmur3_32,
  Murmur3BloomFilter,
  WasmBloomFilter,
  EdgeCacheService,
  type IEdgeRemoteStorage,
} from '../src/edge/index';

describe('Murmur3 32-bit Hash (x86_32)', () => {
  it('computes deterministic 32-bit unsigned hashes', () => {
    const h1 = murmur3_32('hello_world');
    const h2 = murmur3_32('hello_world');
    expect(h1).toBe(h2);
    expect(h1).toBeGreaterThanOrEqual(0);
    expect(h1).toBeLessThanOrEqual(0xffffffff);
  });

  it('handles empty strings and seeds', () => {
    const h0 = murmur3_32('', 0);
    const h1 = murmur3_32('', 42);
    expect(typeof h0).toBe('number');
    expect(typeof h1).toBe('number');
    expect(h0).not.toBe(h1);
  });

  it('produces avalanche effect with different seeds', () => {
    const key = 'user:session:994821';
    const hashA = murmur3_32(key, 0);
    const hashB = murmur3_32(key, 0x9747b28c);
    expect(hashA).not.toBe(hashB);
  });

  it('hashes multi-byte UTF-8 strings accurately', () => {
    const kanji = murmur3_32('日本語キャッシュキー');
    const emoji = murmur3_32('user:🚀:profile');
    const cyrillic = murmur3_32('токен_авторизации');
    expect(kanji).toBeGreaterThan(0);
    expect(emoji).toBeGreaterThan(0);
    expect(cyrillic).toBeGreaterThan(0);
  });
});

describe('Murmur3BloomFilter — Pure TypeScript Edge Filter', () => {
  let filter: Murmur3BloomFilter;

  beforeEach(() => {
    filter = new Murmur3BloomFilter(100_000, 7);
  });

  it('returns true for empty string (guard check)', () => {
    expect(filter.mightContain('')).toBe(true);
  });

  it('returns false for keys that were never added', () => {
    expect(filter.mightContain('never_inserted_12345')).toBe(false);
  });

  it('returns true after key is added', () => {
    filter.add('product:electronics:42');
    expect(filter.mightContain('product:electronics:42')).toBe(true);
  });

  it('tracks distinct keys independently', () => {
    const keys = ['auth:tok_1', 'auth:tok_2', 'catalog:cat_3', 'item:sku_99'];
    for (const k of keys) filter.add(k);
    for (const k of keys) expect(filter.mightContain(k)).toBe(true);
    expect(filter.mightContain('auth:tok_unseen')).toBe(false);
  });

  it('clears bits and resets insertion count on reset()', () => {
    filter.add('to_be_cleared');
    expect(filter.mightContain('to_be_cleared')).toBe(true);
    filter.reset();
    expect(filter.mightContain('to_be_cleared')).toBe(false);
    expect(filter.insertions).toBe(0);
    expect(filter.stats.bitsSet).toBe(0);
  });

  it('rebuilds from an iterable of keys', () => {
    filter.add('legacy_key');
    filter.rebuild(['fresh_1', 'fresh_2']);
    expect(filter.mightContain('legacy_key')).toBe(false);
    expect(filter.mightContain('fresh_1')).toBe(true);
    expect(filter.mightContain('fresh_2')).toBe(true);
    expect(filter.insertions).toBe(2);
  });

  it('maintains low false-positive rate (<1%) for target capacity', () => {
    const itemCount = 1_000;
    for (let i = 0; i < itemCount; i++) {
      filter.add(`resident_key_${i}`);
    }

    let falsePositives = 0;
    const testCount = 5_000;
    for (let i = 0; i < testCount; i++) {
      if (filter.mightContain(`non_resident_probe_${i}`)) {
        falsePositives++;
      }
    }

    const fpr = falsePositives / testCount;
    expect(fpr).toBeLessThan(0.01);
  });
});

describe('WasmBloomFilter — Universal Edge Compatibility (No Buffer)', () => {
  it('instantiates and operates without global Buffer', () => {
    const originalBuffer = (globalThis as any).Buffer;
    try {
      delete (globalThis as any).Buffer;
      const wasmFilter = new WasmBloomFilter();
      wasmFilter.add('edge_route_home');
      expect(wasmFilter.mightContain('edge_route_home')).toBe(true);
      expect(wasmFilter.mightContain('edge_route_404')).toBe(false);
    } finally {
      (globalThis as any).Buffer = originalBuffer;
    }
  });
});

describe('EdgeCacheService — Bloom Filter Penetration Defense', () => {
  function createMockRemoteStorage(stored: Record<string, string> = {}) {
    const map = new Map<string, string>(Object.entries(stored));
    const calls = { get: 0, set: 0, delete: 0 };

    const storage: IEdgeRemoteStorage = {
      async get(k: string) {
        calls.get++;
        return map.get(k) ?? null;
      },
      async set(k: string, v: string) {
        calls.set++;
        map.set(k, v);
      },
      async delete(k: string) {
        calls.delete++;
        map.delete(k);
      },
    };

    return { storage, calls, map };
  }

  it('bypasses remote storage query completely on Bloom filter negative', async () => {
    const { storage, calls } = createMockRemoteStorage();
    const bloom = new Murmur3BloomFilter();

    const cache = new EdgeCacheService({
      remoteStorage: storage,
      bloomFilter: bloom,
    });

    // Key has never been set -> Bloom filter returns false
    const res = await cache.get('random_miss_key_xyz');
    expect(res).toBeNull();
    // CRITICAL: Remote storage was NEVER queried! (HTTP subrequest saved)
    expect(calls.get).toBe(0);
  });

  it('queries remote storage when Bloom filter mightContain is true', async () => {
    const { storage, calls, map } = createMockRemoteStorage();
    const bloom = new Murmur3BloomFilter();

    // Pre-populate key in remote storage and mark it in bloom
    map.set('existing_key', JSON.stringify({ name: 'Alice' }));
    bloom.add('existing_key');

    const cache = new EdgeCacheService({
      remoteStorage: storage,
      bloomFilter: bloom,
    });

    const res = await cache.get<{ name: string }>('existing_key');
    expect(res).toEqual({ name: 'Alice' });
    expect(calls.get).toBe(1);
  });

  it('automatically registers keys into Bloom filter on set()', async () => {
    const { storage, calls } = createMockRemoteStorage();
    const cache = new EdgeCacheService({
      remoteStorage: storage,
      bloomFilter: true, // auto-instantiates WasmBloomFilter
    });

    expect(cache.bloom).toBeDefined();

    // Key not set yet -> remote storage not called
    await cache.get('new_article:101');
    expect(calls.get).toBe(0);

    // Write key
    await cache.set('new_article:101', { title: 'Edge Computing' }, 300);
    expect(cache.bloom?.mightContain('new_article:101')).toBe(true);

    // Evict from L1 memory to simulate cold edge isolate reboot
    (cache as any).l1.clear();

    // Now reading it will pass Bloom and fetch from remote storage
    const fetched = await cache.get<{ title: string }>('new_article:101');
    expect(fetched).toEqual({ title: 'Edge Computing' });
    expect(calls.get).toBe(1);
  });

  it('resets Bloom filter on cache.clear()', async () => {
    const { storage } = createMockRemoteStorage();
    const cache = new EdgeCacheService({
      remoteStorage: storage,
      bloomFilter: true,
    });

    await cache.set('temp_key', 'temp_val', 60);
    expect(cache.bloom?.mightContain('temp_key')).toBe(true);

    await cache.clear();
    expect(cache.bloom?.mightContain('temp_key')).toBe(false);
  });
});
