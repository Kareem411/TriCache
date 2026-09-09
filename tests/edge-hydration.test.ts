import { describe, it, expect } from 'vitest';
import { EdgeCacheService } from '../src/edge/cache.js';
import type { CloudflareR2Bucket, CloudflareR2Object } from '../src/edge/types.js';

describe('Edge Hydration Hook (Cloudflare R2 & Cold-Start Priming)', () => {
  const sampleKey32 = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='; // 32 bytes base64

  function createMockR2Bucket(initialData: Record<string, string> = {}): CloudflareR2Bucket {
    const store = new Map<string, string>(Object.entries(initialData));

    return {
      async get(key: string): Promise<CloudflareR2Object | null> {
        const val = store.get(key);
        if (val === undefined) return null;

        return {
          async text() { return val; },
          async arrayBuffer() {
            return new TextEncoder().encode(val).buffer;
          },
        };
      },
      async put(key: string, value: string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream) {
        let str: string;
        if (typeof value === 'string') {
          str = value;
        } else if (value instanceof ArrayBuffer) {
          str = new TextDecoder().decode(value);
        } else if (value instanceof Uint8Array) {
          str = new TextDecoder().decode(value);
        } else {
          str = String(value);
        }
        store.set(key, str);
      },
      async delete(key: string | string[]) {
        if (Array.isArray(key)) {
          for (const k of key) store.delete(k);
        } else {
          store.delete(key);
        }
      },
    };
  }

  it('exports and hydrates plaintext L1 snapshot to and from Cloudflare R2 bucket', async () => {
    const r2 = createMockR2Bucket();

    // Edge isolate 1: Set cache keys and export snapshot to R2
    const edge1 = new EdgeCacheService({ bloomFilter: true });
    await edge1.set('user:edge:100', { name: 'Ada', role: 'engineer' }, 3600, { tags: ['users'] });
    await edge1.set('config:edge:flag', true, 3600);

    const snapshot = await edge1.exportSnapshot();
    await r2.put('tricache-edge.snap', snapshot);

    // Edge isolate 2: Newly spawned worker, starts cold, hydrates from R2
    const edge2 = new EdgeCacheService({ bloomFilter: true });
    expect(await edge2.get('user:edge:100')).toBeNull();

    const restored = await edge2.hydrate(r2);
    expect(restored).toBe(2);

    // Reads now hit L1 directly
    const user = await edge2.get('user:edge:100');
    expect(user).toEqual({ name: 'Ada', role: 'engineer' });

    const flag = await edge2.get('config:edge:flag');
    expect(flag).toBe(true);

    // Bloom filter is primed
    expect(edge2.bloom?.mightContain('user:edge:100')).toBe(true);
    expect(edge2.bloom?.mightContain('config:edge:flag')).toBe(true);
  });

  it('seamlessly encrypts and decrypts R2 snapshots using Web Crypto AEAD (AES-256-GCM)', async () => {
    const r2 = createMockR2Bucket();

    // Edge worker 1 with AEAD encryption
    const edge1 = new EdgeCacheService({
      encryption: {
        keyBase64: sampleKey32,
        mode: 'aes-256-gcm',
      },
    });

    await edge1.set('secret:token', { token: 'super-sensitive-jwt' }, 3600);
    const encryptedSnapshot = await edge1.exportSnapshot();

    expect(encryptedSnapshot.startsWith('enc:v1:')).toBe(true);
    await r2.put('tricache-edge.snap', encryptedSnapshot);

    // Edge worker 2 with matching decryption key
    const edge2 = new EdgeCacheService({
      encryption: {
        keyBase64: sampleKey32,
        mode: 'aes-256-gcm',
      },
    });

    const count = await edge2.hydrate(r2);
    expect(count).toBe(1);

    const secret = await edge2.get('secret:token');
    expect(secret).toEqual({ token: 'super-sensitive-jwt' });
  });

  it('rejects stale snapshots exceeding maxAgeMs and starts cold', async () => {
    const r2 = createMockR2Bucket();

    const stalePayload = JSON.stringify({
      version: 1,
      writtenAt: Date.now() - (4 * 3600 * 1000), // 4 hours ago
      entries: [
        { key: 'stale:key', value: 'old', expiresAt: Date.now() + 3600000, staleUntil: Date.now() + 3600000 },
      ],
    });

    await r2.put('tricache-edge.snap', stalePayload);

    const edge = new EdgeCacheService();
    const count = await edge.hydrate(r2, { maxAgeMs: 3600 * 1000 }); // 1 hour max age
    expect(count).toBe(0);
    expect(await edge.get('stale:key')).toBeNull();
  });

  it('tolerates future timestamps within clockSkewToleranceMs', async () => {
    const r2 = createMockR2Bucket();

    // Clock skew: written 150ms in the future
    const skewedPayload = JSON.stringify({
      version: 1,
      writtenAt: Date.now() + 150,
      entries: [
        { key: 'skew:key', value: 'valid', expiresAt: Date.now() + 3600000, staleUntil: Date.now() + 3600000 },
      ],
    });

    await r2.put('tricache-edge.snap', skewedPayload);

    const edge = new EdgeCacheService();
    const count = await edge.hydrate(r2, { clockSkewToleranceMs: 250 });
    expect(count).toBe(1);
    expect(await edge.get('skew:key')).toBe('valid');
  });

  it('rejects future timestamps exceeding clockSkewToleranceMs', async () => {
    const r2 = createMockR2Bucket();

    // Clock skew: written 5000ms in future
    const skewedPayload = JSON.stringify({
      version: 1,
      writtenAt: Date.now() + 5000,
      entries: [
        { key: 'skew:key', value: 'valid', expiresAt: Date.now() + 3600000, staleUntil: Date.now() + 3600000 },
      ],
    });

    await r2.put('tricache-edge.snap', skewedPayload);

    const edge = new EdgeCacheService();
    const count = await edge.hydrate(r2, { clockSkewToleranceMs: 250 });
    expect(count).toBe(0);
  });

  it('handles missing snapshot in R2 cleanly without throwing (first cold start)', async () => {
    const emptyR2 = createMockR2Bucket();
    const edge = new EdgeCacheService();

    const count = await edge.hydrate(emptyR2);
    expect(count).toBe(0);
  });

  it('handles corrupted snapshot data gracefully by falling back to cold start', async () => {
    const corruptR2 = createMockR2Bucket({
      'tricache-edge.snap': 'NOT_A_VALID_JSON_SNAPSHOT_PAYLOAD!@#$%^',
    });

    const edge = new EdgeCacheService();
    const count = await edge.hydrate(corruptR2);
    expect(count).toBe(0);
  });

  it('supports direct hydration from raw string or ArrayBuffer', async () => {
    const rawPayload = JSON.stringify({
      version: 1,
      writtenAt: Date.now(),
      entries: [
        { key: 'direct:key', value: 42, expiresAt: Date.now() + 60000, staleUntil: Date.now() + 60000 },
      ],
    });

    const edge = new EdgeCacheService();
    const count = await edge.hydrate(rawPayload);
    expect(count).toBe(1);
    expect(await edge.get('direct:key')).toBe(42);

    const edgeAb = new EdgeCacheService();
    const ab = new TextEncoder().encode(rawPayload).buffer;
    const countAb = await edgeAb.hydrate(ab);
    expect(countAb).toBe(1);
    expect(await edgeAb.get('direct:key')).toBe(42);
  });
});
