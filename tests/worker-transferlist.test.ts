import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'crypto';
import { WorkerPool, getTransferableArrayBuffer } from '../src/worker-pool.js';

describe('Zero-Copy WorkerPool transferList', () => {
  let pool: WorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.destroy();
      pool = null;
    }
  });

  describe('getTransferableArrayBuffer', () => {
    it('returns dedicated non-pooled ArrayBuffer directly without copying', () => {
      const dedicated = Buffer.alloc(200_000, 'x');
      const ab = getTransferableArrayBuffer(dedicated);
      expect(ab).not.toBeNull();
      expect(ab).toBe(dedicated.buffer);
    });

    it('returns null for small pooled buffer slices to prevent detaching shared pool', () => {
      // Node's internal buffer pool shares an 8 KB slab for small strings/slices
      const pooledSlice = Buffer.from('small-test-string').subarray(1, 5);
      const ab = getTransferableArrayBuffer(pooledSlice);
      expect(ab).toBeNull();
    });

    it('returns an isolated copy for large pooled buffer slices (>= 128 KB)', () => {
      // Create a mock pooled slice
      const largeSlab = new ArrayBuffer(300_000);
      const largeSlice = new Uint8Array(largeSlab, 1000, 150_000);
      largeSlice.fill(42);

      const ab = getTransferableArrayBuffer(largeSlice);
      expect(ab).not.toBeNull();
      expect(ab).not.toBe(largeSlab); // must be an isolated copy, not the parent slab
      expect(ab!.byteLength).toBe(150_000);

      // Verify contents copied accurately
      const view = new Uint8Array(ab!);
      expect(view[0]).toBe(42);
      expect(view[view.length - 1]).toBe(42);
    });
  });

  describe('WorkerPool execution with zero-copy transferList', () => {
    it('encrypts and decrypts large payloads (>= 128 KB) via worker thread transferList', async () => {
      const keyBase64 = crypto.randomBytes(32).toString('base64');
      pool = new WorkerPool({
        keyBase64,
        mode: 'aes-256-gcm',
        compression: 'brotli',
        compressionThresholdBytes: 1024,
        size: 2,
      });

      if (!pool.isAvailable) return;

      // Generate 200 KB payload
      const largePayload = JSON.stringify({
        data: 'A'.repeat(200_000),
        timestamp: Date.now(),
      });

      const encrypted = await pool.encrypt(largePayload);
      expect(encrypted).toBeDefined();
      expect(typeof encrypted).toBe('string');
      expect(encrypted.startsWith('ecp:v1:') || encrypted.startsWith('enc:v1:')).toBe(true);

      const decrypted = await pool.decrypt(encrypted);
      expect(decrypted).toBe(largePayload);
      const parsed = JSON.parse(decrypted);
      expect(parsed.data.length).toBe(200_000);
    });

    it('handles Buffer and Uint8Array input payloads', async () => {
      const keyBase64 = crypto.randomBytes(32).toString('base64');
      pool = new WorkerPool({
        keyBase64,
        mode: 'aes-256-gcm',
        size: 1,
      });

      if (!pool.isAvailable) return;

      const rawJson = JSON.stringify({ item: 'test-buffer', val: 12345 });
      const rawBuf = Buffer.from(rawJson, 'utf8');

      const encrypted = await pool.encrypt(rawBuf);
      expect(encrypted).toBeDefined();

      const decrypted = await pool.decrypt(encrypted);
      expect(decrypted).toBe(rawJson);
    });
  });
});
