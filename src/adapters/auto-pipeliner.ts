import type { IRedisDriver, IRedisPipeline } from '../types';
import { Cluster } from 'ioredis';
import { redisHashSlot } from '../utils/redis-slot';

export interface AutoPipelinerOptions {
  /** Maximum number of operations to coalesce before forcing an immediate pipeline dispatch. Default: 100 */
  maxBatchSize?: number;
  /** Whether auto-pipelining is enabled. Default: true */
  enabled?: boolean;
}

interface PendingGetOp {
  type: 'get';
  key: string;
  resolve: (val: string | null) => void;
  reject: (err: Error) => void;
}

interface PendingSetexOp {
  type: 'setex';
  key: string;
  seconds: number;
  value: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

interface PendingSetpxOp {
  type: 'setpx';
  key: string;
  milliseconds: number;
  value: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PendingDelOp {
  type: 'del';
  keys: string[];
  resolve: (deleted: number) => void;
  reject: (err: Error) => void;
}

export interface TimedRedisValue {
  raw: string | Record<string, string> | null;
  ttlMs?: number;
}

interface PendingReadOp {
  type: 'read';
  key: string;
  hash: boolean;
  resolve: (value: TimedRedisValue) => void;
  reject: (err: Error) => void;
}

/** Read value + PTTL in one atomic, single-key transaction where the driver supports it. */
export async function readRedisValue(client: any, key: string, hash = false): Promise<TimedRedisValue> {
  if (typeof client.pttl === 'function' && typeof client.multi === 'function') {
    const transaction = client.multi();
    if (typeof transaction.pttl === 'function' && (!hash || typeof transaction.hgetall === 'function')) {
      if (hash) transaction.hgetall(key);
      else transaction.get(key);
      transaction.pttl(key);
      const results = await transaction.exec();
      if (!results) throw new Error('Redis read transaction aborted');
      if (results[0]?.[0]) throw results[0][0];
      if (results[1]?.[0]) throw results[1][0];
      return { raw: results[0]?.[1] ?? null, ttlMs: Number(results[1]?.[1]) };
    }
  }
  // Legacy/custom drivers without an atomic TTL read retain the documented L1 fallback TTL.
  return { raw: await (hash ? client.hgetall(key) : client.get(key)) };
}

type PendingOp = PendingGetOp | PendingSetexOp | PendingSetpxOp | PendingDelOp | PendingReadOp;

/**
 * AutoPipeliner — Microtask-coalesced Redis request batching.
 *
 * Automatically combines individual Redis commands dispatched during the same synchronous
 * tick of the Node.js event loop into a single `pipeline()` network round-trip.
 *
 * Uses `queueMicrotask` exclusively (never `setImmediate` or timers) to ensure ZERO
 * artificial latency penalty (0ms overhead) while slashing network syscalls under high concurrency.
 */
export class AutoPipeliner {
  public readonly maxBatchSize: number;
  public enabled: boolean;

  private queue: PendingOp[] = [];
  private scheduled = false;
  private inFlight = false;

  private statsInternal = {
    batchesDispatched: 0,
    operationsBatched: 0,
  };

  constructor(
    private readonly client: IRedisDriver | any,
    options?: AutoPipelinerOptions,
  ) {
    this.maxBatchSize = options?.maxBatchSize ?? 100;
    this.enabled = options?.enabled ?? true;
  }

  public get stats() {
    return {
      batchesDispatched: this.statsInternal.batchesDispatched,
      operationsBatched: this.statsInternal.operationsBatched,
      pendingQueueSize: this.queue.length,
    };
  }

  public async get(key: string): Promise<string | null> {
    if (!this.enabled || !this.supportsPipelines()) {
      return this.client.get(key);
    }

    return new Promise<string | null>((resolve, reject) => {
      this.enqueue({ type: 'get', key, resolve, reject });
    });
  }

  public async read(key: string, hash = false): Promise<TimedRedisValue> {
    if (!hash && typeof this.client.pttl !== 'function') return { raw: await this.get(key) };
    if (!this.enabled || !this.supportsPipelines() || typeof this.client.pttl !== 'function') {
      return readRedisValue(this.client, key, hash);
    }
    const probe = typeof this.client.pipeline === 'function' ? this.client.pipeline() : this.client.multi();
    if (typeof probe.pttl !== 'function' || (hash && typeof probe.hgetall !== 'function')) {
      return readRedisValue(this.client, key, hash);
    }
    return new Promise<TimedRedisValue>((resolve, reject) => this.enqueue({ type: 'read', key, hash, resolve, reject }));
  }

  public async setex(key: string, seconds: number, value: string): Promise<void> {
    if (!this.enabled || !this.supportsPipelines()) {
      if (typeof this.client.setex === 'function') {
        await this.client.setex(key, seconds, value);
      } else {
        await this.client.set(key, value, 'EX', seconds);
      }
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.enqueue({ type: 'setex', key, seconds, value, resolve, reject });
    });
  }

  public async setpx(key: string, milliseconds: number, value: string): Promise<void> {
    if (!this.enabled || !this.supportsPipelines()) {
      await this.client.set(key, value, 'PX', milliseconds);
      return;
    }
    return new Promise<void>((resolve, reject) => this.enqueue({ type: 'setpx', key, milliseconds, value, resolve, reject }));
  }

  public async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    if (this.client instanceof Cluster && keys.length > 1) {
      return (await Promise.all(keys.map(key => this.del(key)))).reduce((sum, value) => sum + value, 0);
    }
    if (!this.enabled || !this.supportsPipelines()) {
      return this.client.del(...keys);
    }

    return new Promise<number>((resolve, reject) => {
      this.enqueue({ type: 'del', keys, resolve, reject });
    });
  }

  private supportsPipelines(): boolean {
    return Boolean(
      typeof this.client?.pipeline === 'function' ||
      typeof this.client?.multi === 'function'
    );
  }

  private enqueue(op: PendingOp): void {
    this.queue.push(op);

    // If batch limit reached, trigger immediate synchronous dispatch to avoid microtask queue starvation
    if (this.queue.length >= this.maxBatchSize) {
      void this.flush();
      return;
    }

    // Schedule flush in the identical execution tick via microtask
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        void this.flush();
      });
    }
  }

  public async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    const batch = this.queue;
    this.queue = [];
    this.scheduled = false;

    this.statsInternal.batchesDispatched++;
    this.statsInternal.operationsBatched += batch.length;

    if (this.client instanceof Cluster) {
      const groups = new Map<string, PendingOp[]>();
      for (const operation of batch) {
        const key = operation.type === 'del' ? operation.keys[0] : operation.key;
        const slot = redisHashSlot(key);
        const master = this.client.slots[slot]?.[0] ?? String(slot);
        const members = groups.get(master) ?? [];
        members.push(operation);
        groups.set(master, members);
      }
      await Promise.all([...groups.values()].map(members => this.dispatch(members)));
      return;
    }
    await this.dispatch(batch);
  }

  private async dispatch(batch: PendingOp[]): Promise<void> {
    try {
      const pipe: IRedisPipeline = typeof this.client.pipeline === 'function' ? this.client.pipeline() : this.client.multi();
      const indexes: number[] = [];
      let commandCount = 0;
      for (const op of batch) {
        indexes.push(commandCount++);
        switch (op.type) {
          case 'get': pipe.get(op.key); break;
          case 'setex': pipe.setex(op.key, op.seconds, op.value); break;
          case 'setpx': pipe.set(op.key, op.value, 'PX', op.milliseconds); break;
          case 'del': pipe.del(...op.keys); break;
          case 'read':
            if (op.hash) pipe.hgetall!(op.key);
            else pipe.get(op.key);
            pipe.pttl!(op.key);
            commandCount++;
            break;
        }
      }
      const results = await pipe.exec();

      if (!results) {
        // Pipeline returned null / aborted
        for (const op of batch) {
          op.reject(new Error('Redis pipeline aborted'));
        }
        return;
      }

      for (let i = 0; i < batch.length; i++) {
        const op = batch[i];
        const resTuple = results[indexes[i]];

        if (!resTuple) {
          op.reject(new Error('Missing Redis pipeline result'));
          continue;
        }

        const [err, val] = resTuple;
        if (err) {
          op.reject(err instanceof Error ? err : new Error(String(err)));
        } else {
          if (op.type === 'read') {
            const ttlResult = results[indexes[i] + 1];
            if (!ttlResult || ttlResult[0]) op.reject(ttlResult?.[0] ?? new Error('Missing Redis PTTL result'));
            else op.resolve({ raw: val, ttlMs: Number(ttlResult[1]) });
          } else if (op.type === 'get') {
            op.resolve(val != null ? String(val) : null);
          } else if (op.type === 'del') {
            op.resolve(typeof val === 'number' ? val : Number(val) || 0);
          } else {
            op.resolve();
          }
        }
      }
    } catch (err) {
      for (const op of batch) {
        op.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
}
