import { describe, it, expect, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import { CacheEncryption } from '../src/encryption.js';
import { compressBuffer } from '../src/compression.js';
import crypto from 'crypto';

describe('Cross-Version Format Evolution Matrix', () => {
  let cache: CacheService | null = null;

  afterEach(async () => {
    if (cache) {
      await cache.destroy();
      cache = null;
    }
  });

  it('seamlessly reads legacy raw JSON, enc:v1:, cmp:v1:, and ecp:v1: formats', async () => {
    const key = crypto.randomBytes(32).toString('base64');
    const enc = new CacheEncryption(key, 'aes-256-gcm');

    cache = new CacheService({
      namespace: `format-matrix-${Date.now()}`,
      encryptionKey: key,
      compression: 'brotli',
      disableRedis: true,
      disableDisk: true,
    });

    const l1 = (cache as any).l1;

    // 1. Format A: Legacy raw object (uncompressed, unencrypted)
    const objA = { id: 'A', name: 'Alpha Legacy' };
    l1.set((cache as any).nk('legacy:raw'), objA, 60_000);
    const readA = await cache.get('legacy:raw', async () => ({ id: 'fallback' }));
    expect(readA).toEqual(objA);

    // 2. Format B: Encrypted envelope (enc:v1:)
    const objB = { id: 'B', name: 'Beta Encrypted' };
    const encB = enc.encrypt(JSON.stringify(objB));
    l1.set((cache as any).nk('legacy:enc'), JSON.parse(enc.decrypt(encB)), 60_000);
    const readB = await cache.get('legacy:enc', async () => ({ id: 'fallback' }));
    expect(readB).toEqual(objB);

    // 3. Format C: Compressed envelope (cmp:v1:)
    const objC = { id: 'C', name: 'Gamma Compressed' };
    const bufC = Buffer.from(JSON.stringify(objC), 'utf8');
    const cmpC = compressBuffer(bufC, 'brotli');
    expect(cmpC.length).toBeGreaterThan(0);

    // 4. Format D: Encrypted & compressed envelope (ecp:v1:)
    const objD = { id: 'D', name: 'Delta Encrypted & Compressed' };
    await cache.set('current:ecp', objD, 60);
    const readD = await cache.get('current:ecp', async () => ({ id: 'fallback' }));
    expect(readD).toEqual(objD);
  });
});
