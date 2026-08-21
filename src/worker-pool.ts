/**
 * WorkerPool — a fixed-size pool of worker threads for off-main-thread
 * encryption and decryption of large cache payloads.
 *
 * Design goals:
 *  - Zero-allocation hot path: pending Promises are stored in a pre-keyed Map.
 *  - Round-robin dispatch: tasks fan out evenly across all workers.
 *  - Auto-fallback: if the pool fails to initialize, `isAvailable` is false and
 *    the caller falls through to the synchronous path without any error.
 *  - Graceful drain: `destroy()` terminates all workers after in-flight
 *    Promises have settled.
 *
 * Memory model:
 *  - The encryption key is passed once via `workerData` at thread creation.
 *    Per-message IPC carries only the plaintext/ciphertext string — no key material.
 *  - All message payloads are structured-cloned (strings are fast to clone).
 *
 * Usage:
 *   const pool = new WorkerPool({ keyBase64, mode, size: 2 });
 *   if (pool.isAvailable) {
 *     const cipher = await pool.encrypt(jsonString);
 *     const plain  = await pool.decrypt(cipher);
 *   }
 */

import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';
import type { EncryptionMode } from './encryption.js';
import type { CompressionAlgorithm } from './compression.js';

// Locate the serialize-worker entry point.
// Production: tsup emits compile .js files as flat siblings → use .js path.
// Development / test (tsx, Vitest): the .ts source is used directly with the
// tsx ESM loader registered via execArgv so TypeScript is transpiled on-demand.
import { existsSync } from 'fs';

let _workerFile: string;
let _workerExecArgv: string[] = [];

try {
  const dir = dirname(fileURLToPath(import.meta.url));
  const jsPath = join(dir, 'serialize-worker.js');
  const tsPath = join(dir, 'serialize-worker.ts');

  if (existsSync(jsPath)) {
    // Compiled output present (dist/ after tsup, or src/ after manual compile)
    _workerFile = jsPath;
  } else if (existsSync(tsPath)) {
    // Source-only environment (Vitest, tsx dev runner) — run via tsx loader.
    // Use '--import tsx' (not 'tsx/esm') so that tsx registers both CJS and ESM
    // hooks, giving it full control over .js → .ts extension remapping for
    // sub-imports (encryption.js → encryption.ts, etc.).  tsx/esm alone is
    // unreliable for this inside worker threads on Node 22.
    _workerFile    = tsPath;
    _workerExecArgv = ['--import', 'tsx'];
  } else {
    _workerFile = jsPath; // will fail at runtime → pool marks itself unavailable
  }
} catch {
  // CJS fallback — __dirname is available natively in CJS (and shimmed by tsup for ESM).
  _workerFile = join(__dirname, 'serialize-worker.js');
}

export interface WorkerPoolOptions {
  /** Base64-encoded raw key bytes. Empty string = no encryption (pool becomes a no-op pass-through). */
  keyBase64:      string;
  mode:           EncryptionMode;
  prevKeyBase64?: string;
  prevMode?:      EncryptionMode;
  compression?:   CompressionAlgorithm;
  compressionThresholdBytes?: number;
  /** Number of worker threads. Default: min(4, availableCPUs). */
  size?:          number;
}

type PendingEntry = { resolve: (v: string) => void; reject: (e: Error) => void };

/**
 * Safely extracts or allocates a transferable ArrayBuffer for worker_threads postMessage.
 *
 * Prevents detach corruption on Node's shared 8 KB internal Buffer pool (Buffer.poolSize):
 * - If the buffer owns the entire underlying ArrayBuffer (byteOffset === 0 && byteLength === buffer.byteLength),
 *   it can be transferred directly with zero copies.
 * - For large pooled slices (>= 128 KB), copies to an isolated ArrayBuffer so transferring it
 *   detaches only the copy and never the main-thread pooled slab.
 * - For smaller pooled slices (< 128 KB), returns null to let structured cloning handle it without transfer.
 */
export function getTransferableArrayBuffer(buf: Buffer | Uint8Array): ArrayBuffer | null {
  if (buf.buffer instanceof ArrayBuffer) {
    if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
      return buf.buffer;
    }
  }

  if (buf.byteLength >= 131_072) {
    const copy = new ArrayBuffer(buf.byteLength);
    new Uint8Array(copy).set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    return copy;
  }

  return null;
}

export class WorkerPool {
  private workers:  Worker[] = [];
  private pending:  Map<number, PendingEntry>[] = [];
  private _nextId            = 0;
  private _robin             = 0;
  private _available         = false;

  constructor(opts: WorkerPoolOptions) {
    try {
      const { workers, pending } = this._spawnWorkers(opts);
      this.workers = workers;
      this.pending = pending;
      this._available = true;
    } catch {
      // Worker creation failed (e.g., missing file, restricted runtime).
      // Callers check isAvailable before using the pool.
      this._destroy();
    }
  }

  private _spawnWorkers(opts: WorkerPoolOptions): { workers: Worker[]; pending: Map<number, PendingEntry>[] } {
    const size = Math.max(1, opts.size ?? Math.min(4, availableCpus()));
    const workerData = {
      keyBase64:     opts.keyBase64,
      mode:          opts.mode,
      prevKeyBase64: opts.prevKeyBase64 ?? '',
      prevMode:      opts.prevMode,
      compression:   opts.compression ?? 'none',
      compressionThresholdBytes: opts.compressionThresholdBytes ?? 1024,
    };

    const workers: Worker[] = [];
    const pendingList: Map<number, PendingEntry>[] = [];

    const createWorker = (index: number): Worker => {
      const worker = new Worker(_workerFile, {
        workerData,
        execArgv: _workerExecArgv.length > 0 ? _workerExecArgv : undefined,
      });
      const pending = pendingList[index] ?? new Map<number, PendingEntry>();
      if (!pendingList[index]) pendingList[index] = pending;

      worker.on('message', (msg: { id: number; result?: string | Uint8Array; error?: string; isTransfer?: boolean }) => {
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        if (pending.size === 0) worker.unref();
        if (msg.error !== undefined) {
          entry.reject(new Error(msg.error));
        } else if (msg.result !== undefined) {
          if (typeof msg.result === 'string') {
            entry.resolve(msg.result);
          } else {
            entry.resolve(Buffer.from(msg.result.buffer, msg.result.byteOffset, msg.result.byteLength).toString('utf8'));
          }
        }
      });

      worker.on('error', (err: Error) => {
        for (const [, entry] of pending) entry.reject(err);
        pending.clear();
        worker.unref();
      });

      worker.on('exit', (exitCode: number) => {
        for (const [, entry] of pending) {
          entry.reject(new Error(`Worker thread exited unexpectedly with code ${exitCode}`));
        }
        pending.clear();
        worker.unref();

        // If pool is still active and worker exited with non-zero code, auto-replace
        if (this._available && exitCode !== 0 && workers[index] === worker) {
          try {
            workers[index] = createWorker(index);
          } catch { /* ok */ }
        }
      });

      worker.unref();
      return worker;
    };

    for (let i = 0; i < size; i++) {
      const worker = createWorker(i);
      workers.push(worker);
    }

    return { workers, pending: pendingList };
  }

  /**
   * Gracefully drain in-flight tasks and re-initialize workers with updated key material.
   * Atomically swaps workers so new requests immediately route to new workers,
   * while existing in-flight operations complete on old workers before termination.
   */
  async drainAndReinit(opts: WorkerPoolOptions): Promise<void> {
    const { workers: newWorkers, pending: newPending } = this._spawnWorkers(opts);

    // Atomically swap references
    const oldWorkers = this.workers;
    const oldPending = this.pending;
    this.workers = newWorkers;
    this.pending = newPending;
    this._robin = 0;
    this._available = true;

    // Await drain of in-flight tasks on old workers
    const start = Date.now();
    while (oldPending.some(m => m.size > 0)) {
      if (Date.now() - start > 5_000) break; // 5s timeout guard
      await new Promise(r => setTimeout(r, 10));
    }

    // Cleanly terminate old workers
    for (let i = 0; i < oldWorkers.length; i++) {
      for (const [, entry] of oldPending[i] ?? []) {
        entry.reject(new Error('WorkerPool replaced during key rotation'));
      }
      oldPending[i]?.clear();
      oldWorkers[i]?.terminate().catch(() => {});
    }
  }

  get isAvailable(): boolean { return this._available; }

  /** Encrypt a string or buffer in a worker thread. Returns the encrypted envelope string. */
  encrypt(payload: string | Buffer | Uint8Array): Promise<string> {
    return this._dispatch('encrypt', payload);
  }

  /** Decrypt an encrypted envelope string or buffer in a worker thread. Returns the original JSON string. */
  decrypt(payload: string | Buffer | Uint8Array): Promise<string> {
    return this._dispatch('decrypt', payload);
  }

  private _dispatch(type: 'encrypt' | 'decrypt', payload: string | Buffer | Uint8Array): Promise<string> {
    if (!this._available || this.workers.length === 0) {
      return Promise.reject(new Error('WorkerPool is not available'));
    }
    const id      = this._nextId++;
    const idx     = this._robin;
    const worker  = this.workers[idx];
    const pending = this.pending[idx];
    this._robin   = (this._robin + 1) % this.workers.length;

    let transferable: ArrayBuffer | null = null;
    let dataToSend: string | Uint8Array = typeof payload === 'string' ? payload : payload;

    if (typeof payload !== 'string') {
      transferable = getTransferableArrayBuffer(payload);
      if (transferable) {
        dataToSend = new Uint8Array(transferable);
      }
    } else if (payload.length >= 131_072) {
      const buf = Buffer.from(payload, 'utf8');
      transferable = getTransferableArrayBuffer(buf);
      if (transferable) {
        dataToSend = new Uint8Array(transferable);
      }
    }

    const transferList = transferable ? [transferable] : [];

    return new Promise<string>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      // Re-ref the worker while this request is in flight so the event loop
      // stays alive even in short-lived scripts (benchmarks, CLI tools).
      worker.ref();
      worker.postMessage({ id, type, payload: dataToSend }, transferList);
    });
  }

  /** Terminate all worker threads. In-flight promises are rejected. */
  async destroy(): Promise<void> {
    this._available = false;
    this._destroy();
  }

  private _destroy(): void {
    for (let i = 0; i < this.workers.length; i++) {
      for (const [, entry] of this.pending[i] ?? []) {
        entry.reject(new Error('WorkerPool destroyed'));
      }
      this.pending[i]?.clear();
      this.workers[i]?.terminate().catch(() => {});
    }
  }
}

function availableCpus(): number {
  // Node >= 22.13.0 (engines constraint) always has availableParallelism.
  return os.availableParallelism?.() ?? os.cpus().length;
}
