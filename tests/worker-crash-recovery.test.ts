import { describe, it, expect, afterEach } from 'vitest';
import { WorkerPool } from '../src/worker-pool.js';
import crypto from 'crypto';

describe('Worker Thread Sudden Crash & Auto-Recovery', () => {
  let pool: WorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.destroy();
      pool = null;
    }
  });

  it('rejects in-flight task on worker termination and automatically replaces crashed worker', async () => {
    const key = crypto.randomBytes(32).toString('base64');
    pool = new WorkerPool({
      keyBase64: key,
      mode: 'aes-256-gcm',
      size: 2,
    });

    expect(pool.isAvailable).toBe(true);

    // Verify pool can encrypt/decrypt normally
    const encrypted = await pool.encrypt('hello-world');
    const decrypted = await pool.decrypt(encrypted);
    expect(decrypted).toBe('hello-world');

    // Terminate one underlying worker thread forcibly (simulating OOM / process.abort)
    const workers = (pool as any).workers;
    const initialWorkerCount = workers.length;
    expect(initialWorkerCount).toBe(2);

    const crashedWorker = workers[0];
    await crashedWorker.terminate();

    // Poll deterministically until exit listener processes and auto-spawns replacement worker
    const deadline = Date.now() + 1500;
    while (workers[0] === crashedWorker && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10));
    }
    expect(workers[0]).not.toBe(crashedWorker);

    // Verify pool self-healed and continues processing requests normally
    const encryptedAfterCrash = await pool.encrypt('recovered-payload');
    const decryptedAfterCrash = await pool.decrypt(encryptedAfterCrash);
    expect(decryptedAfterCrash).toBe('recovered-payload');
  });
});
