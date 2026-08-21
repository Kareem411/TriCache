import { describe, it, expect, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service';
import { pack } from 'msgpackr';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

function makeKey(len: number, char = 'a'): string {
  return Buffer.from(char.repeat(len)).toString('base64');
}

describe('Runtime dynamic key rotation (rotateEncryptionKey)', () => {
  let svc: CacheService | null = null;
  let diskDir: string | null = null;

  afterEach(async () => {
    if (svc) {
      await svc.destroy();
      svc = null;
    }
    if (diskDir) {
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
      diskDir = null;
    }
  });

  it('rotates primary key and decrypts pre-rotation disk entries via previous key', async () => {
    diskDir = mkdtempSync(path.join(os.tmpdir(), 'tricache-rotation-test-'));
    const key1 = makeKey(32, '1');
    const key2 = makeKey(32, '2');

    svc = new CacheService({
      diskCacheDir: diskDir,
      disableRedis: true,
      encryptionKey: key1,
      encryptionMode: 'aes-256-gcm',
    });

    // Write value under Key 1 directly to disk tier
    const payload1 = pack({ name: 'Alice', role: 'admin' });
    const disk = (svc as unknown as { disk: { save: (k: string, e: unknown) => Promise<void> } }).disk;
    await disk.save('user:profile:1', {
      data: payload1,
      size: payload1.length,
      expiresAt: Date.now() + 60_000,
      priority: 0,
      hits: 1,
      lastAccess: Date.now(),
      isCompressed: true,
    });

    // Rotate to Key 2 dynamically
    await svc.rotateEncryptionKey(key2, 'aes-256-gcm');

    // Read pre-rotation entry: should fall back to previous key seamlessly
    const val = await svc.get('user:profile:1', async () => ({ name: 'Fetched', role: 'guest' }));
    expect(val).toEqual({ name: 'Alice', role: 'admin' });

    // Write new entry under Key 2 to disk tier
    const payload2 = pack({ name: 'Bob', role: 'user' });
    await disk.save('user:profile:2', {
      data: payload2,
      size: payload2.length,
      expiresAt: Date.now() + 60_000,
      priority: 0,
      hits: 1,
      lastAccess: Date.now(),
      isCompressed: true,
    });

    const val2 = await svc.get('user:profile:2', async () => ({ name: 'Fetched', role: 'guest' }));
    expect(val2).toEqual({ name: 'Bob', role: 'user' });
  });

  it('handles in-flight WorkerPool tasks during rotateEncryptionKey()', async () => {
    diskDir = mkdtempSync(path.join(os.tmpdir(), 'tricache-rotation-worker-'));
    const key1 = makeKey(32, 'a');
    const key2 = makeKey(32, 'b');

    svc = new CacheService({
      diskCacheDir: diskDir,
      disableRedis: true,
      encryptionKey: key1,
      encryptionMode: 'aes-256-gcm',
      workerThreads: true,
      workerThresholdBytes: 10,
    });

    const pool = (svc as unknown as { _workerPool: { encrypt: (s: string) => Promise<string> } | null })._workerPool;
    expect(pool).not.toBeNull();

    // Start an in-flight encrypt operation
    const largePayload = JSON.stringify({ items: Array.from({ length: 100 }, (_, i) => `item-${i}`) });
    const inFlightEncrypt = pool!.encrypt(largePayload);

    // Trigger key rotation concurrently
    const rotatePromise = svc.rotateEncryptionKey(key2, 'aes-256-gcm');

    const [encryptedResult] = await Promise.all([inFlightEncrypt, rotatePromise]);
    expect(encryptedResult).toBeDefined();
    expect(encryptedResult.startsWith('enc:v1:')).toBe(true);
  });

  it('multi-rotation gracefully returns cache miss (calls fetchFn) for N-2 key entries without crashing', async () => {
    diskDir = mkdtempSync(path.join(os.tmpdir(), 'tricache-rotation-multi-'));
    const keyA = makeKey(32, 'a');
    const keyB = makeKey(32, 'b');
    const keyC = makeKey(32, 'c');

    svc = new CacheService({
      diskCacheDir: diskDir,
      disableRedis: true,
      encryptionKey: keyA,
      encryptionMode: 'aes-256-gcm',
    });

    // Write under Key A
    await svc.set('legacy:item', { version: 'A' }, 60);

    // Clear L1
    (svc as unknown as { l1: { delete: (k: string) => void } }).l1.delete('legacy:item');

    // First rotation: Key A -> prevKey, Key B -> primary
    await svc.rotateEncryptionKey(keyB, 'aes-256-gcm');

    // Second rotation: Key B -> prevKey, Key C -> primary (Key A is dropped)
    await svc.rotateEncryptionKey(keyC, 'aes-256-gcm');

    // Attempt to read entry written under Key A:
    // Key C fails, Key B fails -> decrypt fails -> falls back to fetchFn (clean cache miss)
    let fetchCalled = false;
    const result = await svc.get('legacy:item', async () => {
      fetchCalled = true;
      return { version: 'refetched-under-key-c' };
    });

    expect(fetchCalled).toBe(true);
    expect(result).toEqual({ version: 'refetched-under-key-c' });

    // getIfFresh also returns null rather than throwing
    (svc as unknown as { l1: { delete: (k: string) => void } }).l1.delete('legacy:item');
    const fresh = svc.getIfFresh('legacy:item');
    expect(fresh).toBeNull();
  });
});
