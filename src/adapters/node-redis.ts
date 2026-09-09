import { EventEmitter } from 'node:events';
import type { IRedisDriver, IRedisPipeline } from '../types';

export type { IRedisDriver, IRedisPipeline };

/**
 * Pipeline adapter converting `@redis/client` (node-redis v4/v5/v6) chained multi calls
 * into the tuple response format (`Array<[Error | null, any]>`) expected by TriCache.
 */
export class NodeRedisPipelineAdapter implements IRedisPipeline {
  private readonly multiInstance: any;

  constructor(multiInstance: any) {
    this.multiInstance = multiInstance;
  }

  get(key: string): this {
    this.multiInstance.get(key);
    return this;
  }

  set(key: string, value: string, ...args: (string | number)[]): this {
    const opts = parseSetArgs(args);
    if (opts) {
      this.multiInstance.set(key, value, opts);
    } else {
      this.multiInstance.set(key, value);
    }
    return this;
  }

  setex(key: string, seconds: number, value: string): this {
    if (typeof this.multiInstance.setEx === 'function') {
      this.multiInstance.setEx(key, seconds, value);
    } else if (typeof this.multiInstance.setex === 'function') {
      this.multiInstance.setex(key, seconds, value);
    } else {
      this.multiInstance.set(key, value, { EX: seconds });
    }
    return this;
  }

  del(...keys: string[]): this {
    if (keys.length === 0) return this;
    this.multiInstance.del(keys.length === 1 ? keys[0] : keys);
    return this;
  }

  expire(key: string, seconds: number): this {
    this.multiInstance.expire(key, seconds);
    return this;
  }

  incr(key: string): this {
    this.multiInstance.incr(key);
    return this;
  }

  sadd(key: string, ...members: string[]): this {
    if (members.length === 0) return this;
    if (typeof this.multiInstance.sAdd === 'function') {
      this.multiInstance.sAdd(key, members.length === 1 ? members[0] : members);
    } else {
      this.multiInstance.sadd(key, ...members);
    }
    return this;
  }

  smembers(key: string): this {
    if (typeof this.multiInstance.sMembers === 'function') {
      this.multiInstance.sMembers(key);
    } else {
      this.multiInstance.smembers(key);
    }
    return this;
  }

  hset(key: string, value: Record<string, string>): this {
    if (typeof this.multiInstance.hSet === 'function') {
      this.multiInstance.hSet(key, value);
    } else {
      this.multiInstance.hset(key, value);
    }
    return this;
  }

  async exec(): Promise<Array<[Error | null, any]> | null> {
    const raw = await this.multiInstance.exec();
    if (!raw) return null;
    return raw.map((item: any) => {
      if (item instanceof Error) {
        return [item, null];
      }
      return [null, item];
    });
  }
}

/**
 * Universal driver adapter wrapping `@redis/client` (node-redis) to satisfy TriCache's
 * `IRedisDriver` contract without adding runtime dependencies.
 */
export class NodeRedisAdapter implements IRedisDriver {
  readonly client: any;

  constructor(client: any) {
    if (!client) {
      throw new Error('NodeRedisAdapter requires an active @redis/client instance');
    }
    this.client = client;
  }

  get isOpen(): boolean {
    return this.client.isOpen !== false;
  }

  async connect(): Promise<unknown> {
    if (typeof this.client.connect === 'function' && !this.client.isOpen) {
      return await this.client.connect();
    }
    return undefined;
  }

  async disconnect(): Promise<void> {
    if (typeof this.client.disconnect === 'function' && this.client.isOpen !== false) {
      try {
        await this.client.disconnect();
      } catch {
        /* ok */
      }
    } else if (typeof this.client.quit === 'function') {
      try {
        await this.client.quit();
      } catch {
        /* ok */
      }
    }
  }

  async quit(): Promise<void> {
    return this.disconnect();
  }

  async get(key: string): Promise<string | null> {
    return (await this.client.get(key)) ?? null;
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<unknown> {
    const opts = parseSetArgs(args);
    if (opts) {
      return await this.client.set(key, value, opts);
    }
    return await this.client.set(key, value);
  }

  async setex(key: string, seconds: number, value: string): Promise<unknown> {
    if (typeof this.client.setEx === 'function') {
      return await this.client.setEx(key, seconds, value);
    }
    if (typeof this.client.setex === 'function') {
      return await this.client.setex(key, seconds, value);
    }
    return await this.client.set(key, value, { EX: seconds });
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const res = await this.client.del(keys.length === 1 ? keys[0] : keys);
    return typeof res === 'number' ? res : 0;
  }

  async ping(): Promise<string> {
    return await this.client.ping();
  }

  async expire(key: string, seconds: number): Promise<number | boolean> {
    return await this.client.expire(key, seconds);
  }

  async incr(key: string): Promise<number> {
    return await this.client.incr(key);
  }

  async eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown> {
    if (typeof this.client.sendCommand === 'function') {
      return await this.client.sendCommand([
        'EVAL',
        script,
        String(numkeys),
        ...args.map(String),
      ]);
    }
    if (typeof this.client.eval === 'function') {
      const keys = args.slice(0, numkeys).map(String);
      const scriptArgs = args.slice(numkeys).map(String);
      return await this.client.eval(script, {
        keys,
        arguments: scriptArgs,
      });
    }
    throw new Error('Redis client does not support EVAL or sendCommand');
  }

  multi(): IRedisPipeline {
    const multiInstance = this.client.multi();
    return new NodeRedisPipelineAdapter(multiInstance);
  }

  pipeline(): IRedisPipeline {
    return this.multi();
  }

  async smembers(key: string): Promise<string[]> {
    if (typeof this.client.sMembers === 'function') {
      return await this.client.sMembers(key);
    }
    if (typeof this.client.smembers === 'function') {
      return await this.client.smembers(key);
    }
    return [];
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    if (typeof this.client.sAdd === 'function') {
      return await this.client.sAdd(key, members.length === 1 ? members[0] : members);
    }
    if (typeof this.client.sadd === 'function') {
      return await this.client.sadd(key, ...members);
    }
    return 0;
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return [];
    if (typeof this.client.mGet === 'function') {
      return await this.client.mGet(keys);
    }
    if (typeof this.client.mget === 'function') {
      return await this.client.mget(keys);
    }
    return [];
  }

  async hset(key: string, value: Record<string, string>): Promise<unknown> {
    if (typeof this.client.hSet === 'function') {
      return await this.client.hSet(key, value);
    }
    if (typeof this.client.hset === 'function') {
      return await this.client.hset(key, value);
    }
    return undefined;
  }

  async publish(channel: string, message: string): Promise<number> {
    return await this.client.publish(channel, message);
  }

  async subscribe(...channels: string[]): Promise<unknown> {
    if (channels.length === 0) return undefined;
    return await this.client.subscribe(channels);
  }

  scanStream(options?: { match?: string; count?: number }): EventEmitter {
    const ee = new EventEmitter();
    const pattern = options?.match ?? '*';
    const count = options?.count ?? 100;

    queueMicrotask(async () => {
      try {
        if (typeof this.client.scanIterator === 'function') {
          const batch: string[] = [];
          for await (const key of this.client.scanIterator({ MATCH: pattern, COUNT: count })) {
            batch.push(key);
            if (batch.length >= count) {
              ee.emit('data', [...batch]);
              batch.length = 0;
            }
          }
          if (batch.length > 0) {
            ee.emit('data', batch);
          }
          ee.emit('end');
        } else if (typeof this.client.sendCommand === 'function') {
          let cursor = '0';
          do {
            const raw = await this.client.sendCommand([
              'SCAN',
              cursor,
              'MATCH',
              pattern,
              'COUNT',
              String(count),
            ]);
            cursor = String(raw[0]);
            const batch = raw[1] as string[];
            if (batch?.length) {
              ee.emit('data', batch);
            }
          } while (cursor !== '0');
          ee.emit('end');
        } else {
          ee.emit('end');
        }
      } catch (err) {
        ee.emit('error', err);
      }
    });

    return ee;
  }

  duplicate(): IRedisDriver {
    if (typeof this.client.duplicate === 'function') {
      return new NodeRedisAdapter(this.client.duplicate());
    }
    return this;
  }

  on(event: string, listener: (...args: any[]) => void): this {
    if (typeof this.client.on === 'function') {
      this.client.on(event, listener);
    }
    return this;
  }

  once(event: string, listener: (...args: any[]) => void): this {
    if (typeof this.client.once === 'function') {
      this.client.once(event, listener);
    }
    return this;
  }
}

/**
 * Creates a pluggable `IRedisDriver` adapter wrapping an existing `@redis/client` instance.
 *
 * @example
 * import { createClient } from 'redis';
 * import { CacheService, createNodeRedisAdapter } from 'tricache';
 *
 * const client = createClient({ url: 'redis://localhost:6379' });
 * await client.connect();
 *
 * const cache = CacheService.create({
 *   redisClient: createNodeRedisAdapter(client),
 * });
 */
export function createNodeRedisAdapter(client: any): IRedisDriver {
  if (client instanceof NodeRedisAdapter) return client;
  return new NodeRedisAdapter(client);
}

function parseSetArgs(args: (string | number)[]): Record<string, any> | undefined {
  if (args.length === 0) return undefined;
  const opts: Record<string, any> = {};
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]).toUpperCase();
    if (a === 'EX' && i + 1 < args.length) {
      opts.EX = Number(args[++i]);
    } else if (a === 'PX' && i + 1 < args.length) {
      opts.PX = Number(args[++i]);
    } else if (a === 'NX') {
      opts.NX = true;
    } else if (a === 'XX') {
      opts.XX = true;
    }
  }
  return Object.keys(opts).length > 0 ? opts : undefined;
}
