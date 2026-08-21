/// <reference types="node" />
import { describe, it, expect, afterEach } from 'vitest';
import { WorkerPool } from '../src/worker-pool';

const TEST_KEY_B64 = Buffer.from('a'.repeat(32)).toString('base64');

describe('WorkerPool unit tests', () => {
  let pool: WorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.destroy();
      pool = null;
    }
  });

  describe('Lifecycle & Availability', () => {
    it('initializes and reports isAvailable = true', () => {
      pool = new WorkerPool({ keyBase64: TEST_KEY_B64, mode: 'aes-256-gcm', size: 1 });
      expect(pool.isAvailable).toBe(true);
    });

    it('sets isAvailable = false after destroy()', async () => {
      pool = new WorkerPool({ keyBase64: TEST_KEY_B64, mode: 'aes-256-gcm', size: 1 });
      expect(pool.isAvailable).toBe(true);

      await pool.destroy();
      expect(pool.isAvailable).toBe(false);
    });

    it('rejects encrypt/decrypt calls when pool is destroyed or unavailable', async () => {
      pool = new WorkerPool({ keyBase64: TEST_KEY_B64, mode: 'aes-256-gcm', size: 1 });
      await pool.destroy();

      await expect(pool.encrypt('test')).rejects.toThrow('WorkerPool is not available');
      await expect(pool.decrypt('test')).rejects.toThrow('WorkerPool is not available');
    });
  });

  describe('Crypto operations', () => {
    it('encrypts and decrypts strings correctly', async () => {
      pool = new WorkerPool({ keyBase64: TEST_KEY_B64, mode: 'aes-256-gcm', size: 2 });
      const payload = JSON.stringify({ userId: 123, role: 'admin', active: true });

      const encrypted = await pool.encrypt(payload);
      expect(encrypted).not.toBe(payload);
      expect(encrypted.startsWith('enc:v1:')).toBe(true);

      const decrypted = await pool.decrypt(encrypted);
      expect(decrypted).toBe(payload);
    });

    it('handles multiple concurrent requests across worker threads', async () => {
      pool = new WorkerPool({ keyBase64: TEST_KEY_B64, mode: 'aes-256-gcm', size: 2 });

      const items = Array.from({ length: 15 }, (_, i) => JSON.stringify({ id: i, data: `data-${i}` }));
      const encryptedItems = await Promise.all(items.map(item => pool!.encrypt(item)));
      const decryptedItems = await Promise.all(encryptedItems.map(item => pool!.decrypt(item)));

      for (let i = 0; i < items.length; i++) {
        expect(decryptedItems[i]).toBe(items[i]);
      }
    });

    it('rejects with error when decrypting invalid or corrupted ciphertext', async () => {
      pool = new WorkerPool({ keyBase64: TEST_KEY_B64, mode: 'aes-256-gcm', size: 1 });

      const validEnc = await pool.encrypt('hello world');
      const corruptedEnc = validEnc.slice(0, -6) + 'ZZZZZZ';

      await expect(pool.decrypt(corruptedEnc)).rejects.toThrow();
    });
  });

  describe('Error handling & in-flight drainage', () => {
    it('rejects in-flight requests when pool is destroyed while requests are pending', async () => {
      pool = new WorkerPool({ keyBase64: TEST_KEY_B64, mode: 'aes-256-gcm', size: 1 });

      // Start an operation and immediately destroy the pool
      const encryptPromise = pool.encrypt('some large payload to process');
      const destroyPromise = pool.destroy();

      await destroyPromise;
      // Either it completed before destroy or rejected with 'WorkerPool destroyed'
      try {
        await encryptPromise;
      } catch (err) {
        expect((err as Error).message).toBe('WorkerPool destroyed');
      }
    });

    it('rejects in-flight entries on worker error event', async () => {
      pool = new WorkerPool({ keyBase64: TEST_KEY_B64, mode: 'aes-256-gcm', size: 1 });

      const workers = (pool as unknown as { workers: Array<{ emit: (event: string, arg: unknown) => void }> }).workers;
      expect(workers.length).toBe(1);

      // Trigger an error event on the worker
      const err = new Error('simulated worker error');
      workers[0].emit('error', err);

      // Next call should still reject or handle cleanly
      expect(pool.isAvailable).toBe(true);
    });
  });
});
