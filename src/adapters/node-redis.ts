import { EventEmitter } from 'node:events';
import type { IRedisDriver, IRedisPipeline } from '../types';

export type { IRedisDriver, IRedisPipeline };

/**
 * Pipeline adapter converting `@redis/client` (node-redis v4/v5/v6) chained multi calls
 * into the tuple response format (`Array<[Error | null, any]>`) expected by TriCache.
 */
export class NodeRedisPipelineAdapter implements IRedisPipeline {
  private readonly multiInstance: any;
  private readonly operations: Array<() => Promise<unknown>> = [];
  pttl?: (key: string) => this;
  eval?: (script: string, numkeys: number, ...args: (string | number)[]) => this;

  constructor(multiInstance: any, private readonly transactional = true) {
    this.multiInstance = multiInstance;
    if (typeof multiInstance.pTTL === 'function' || typeof multiInstance.pttl === 'function') {
      this.pttl = key => { this.queueCommand(typeof multiInstance.pTTL === 'function' ? 'pTTL' : 'pttl', [key]); return this; };
    }
    if (typeof multiInstance.eval === 'function' || typeof multiInstance.addCommand === 'function') {
      this.eval = (script, numkeys, ...args) => {
        if (typeof multiInstance.eval === 'function') {
          this.queueCommand('eval', [script, { keys: args.slice(0, numkeys).map(String), arguments: args.slice(numkeys).map(String) }]);
        } else this.queueCommand('addCommand', [['EVAL', script, String(numkeys), ...args.map(String)]]);
        return this;
      };
    }
  }

  private queueCommand(method: string, args: unknown[]): void {
    if (this.transactional) this.multiInstance[method](...args);
    else this.operations.push(() => this.multiInstance[method](...args));
  }

  get(key: string): this {
    this.queueCommand('get', [key]);
    return this;
  }

  set(key: string, value: string, ...args: (string | number)[]): this {
    const opts = parseSetArgs(args);
    if (opts) {
      this.queueCommand('set', [key, value, opts]);
    } else {
      this.queueCommand('set', [key, value]);
    }
    return this;
  }

  setex(key: string, seconds: number, value: string): this {
    if (typeof this.multiInstance.setEx === 'function') {
      this.queueCommand('setEx', [key, seconds, value]);
    } else if (typeof this.multiInstance.setex === 'function') {
      this.queueCommand('setex', [key, seconds, value]);
    } else {
      this.queueCommand('set', [key, value, { EX: seconds }]);
    }
    return this;
  }

  del(...keys: string[]): this {
    if (keys.length === 0) return this;
    this.queueCommand('del', [keys.length === 1 ? keys[0] : keys]);
    return this;
  }

  expire(key: string, seconds: number): this {
    this.queueCommand('expire', [key, seconds]);
    return this;
  }

  incr(key: string): this {
    this.queueCommand('incr', [key]);
    return this;
  }

  sadd(key: string, ...members: string[]): this {
    if (members.length === 0) return this;
    if (typeof this.multiInstance.sAdd === 'function') {
      this.queueCommand('sAdd', [key, members.length === 1 ? members[0] : members]);
    } else {
      this.queueCommand('sadd', [key, ...members]);
    }
    return this;
  }

  smembers(key: string): this {
    if (typeof this.multiInstance.sMembers === 'function') {
      this.queueCommand('sMembers', [key]);
    } else {
      this.queueCommand('smembers', [key]);
    }
    return this;
  }

  hset(key: string, value: Record<string, string>): this {
    if (typeof this.multiInstance.hSet === 'function') {
      this.queueCommand('hSet', [key, value]);
    } else {
      this.queueCommand('hset', [key, value]);
    }
    return this;
  }

  hgetall(key: string): this {
    if (typeof this.multiInstance.hGetAll === 'function') {
      this.queueCommand('hGetAll', [key]);
    } else {
      this.queueCommand('hgetall', [key]);
    }
    return this;
  }

  async exec(): Promise<Array<[Error | null, any]> | null> {
    let raw: any[] | null;
    if (!this.transactional) {
      // node-redis auto-pipelines same-tick commands. Observe every command
      // separately: execAsPipeline() can reject at the first error and discard
      // the successful replies, and retrying that pipeline could duplicate writes.
      const results = await Promise.allSettled(this.operations.splice(0).map(operation => Promise.resolve().then(operation)));
      return results.map(result => result.status === 'fulfilled' ? [null, result.value]
        : [result.reason instanceof Error ? result.reason : new Error(String(result.reason)), null]);
    }
    try {
      raw = await this.multiInstance.exec();
    } catch (error) {
      // node-redis rejects EXEC with MultiErrorReply, unlike ioredis tuples.
      const replies = (error as { replies?: unknown[] }).replies;
      if (!Array.isArray(replies)) throw error;
      raw = replies;
    }
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
export class NodeRedisAdapter extends EventEmitter implements IRedisDriver {
  readonly client: any;
  private connecting: Promise<unknown> | null = null;
  pttl?: (key: string) => Promise<number>;

  constructor(client: any) {
    super();
    if (!client) {
      throw new Error('NodeRedisAdapter requires an active @redis/client instance');
    }
    this.client = client;
    if (typeof client.pTTL === 'function' || typeof client.pttl === 'function') {
      this.pttl = key => (client.pTTL ?? client.pttl).call(client, key);
    }
  }

  get isOpen(): boolean {
    return this.client.isOpen !== false;
  }

  async connect(): Promise<unknown> {
    if (this.connecting) return this.connecting;
    if (typeof this.client.connect === 'function' && !this.client.isOpen) {
      this.connecting = Promise.resolve(this.client.connect());
      try { return await this.connecting; }
      finally { this.connecting = null; }
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
    return new NodeRedisPipelineAdapter(this.client, false);
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

  async hgetall(key: string): Promise<Record<string, string>> {
    if (typeof this.client.hGetAll === 'function') {
      return (await this.client.hGetAll(key)) ?? {};
    }
    if (typeof this.client.hgetall === 'function') {
      return (await this.client.hgetall(key)) ?? {};
    }
    return {};
  }

  async publish(channel: string, message: string): Promise<number> {
    return await this.client.publish(channel, message);
  }

  async subscribe(...channels: string[]): Promise<unknown> {
    if (channels.length === 0) return undefined;
    await this.connect();
    return await this.client.subscribe(channels, (message: string, channel: string) => this.emit('message', channel, message));
  }

  async unsubscribe(...channels: string[]): Promise<unknown> {
    if (!channels.length || !this.isOpen) return undefined;
    return this.client.unsubscribe(channels);
  }

  async xread(...args: (string | number)[]): Promise<Array<[string, Array<[string, string[]]>]> | null> {
    await this.connect();
    const raw = await this.client.sendCommand(['XREAD', ...args.map(String)]);
    if (raw == null) return null;
    if (raw instanceof Map) return [...raw.entries()];
    if (!Array.isArray(raw) && typeof raw === 'object') return Object.entries(raw);
    return raw;
  }

  async xadd(...args: (string | number)[]): Promise<unknown> {
    return this.client.sendCommand(['XADD', ...args.map(String)]);
  }

  async xrange(...args: (string | number)[]): Promise<Array<[string, string[]]>> {
    return this.client.sendCommand(['XRANGE', ...args.map(String)]);
  }

  async xrevrange(...args: (string | number)[]): Promise<Array<[string, string[]]>> {
    return this.client.sendCommand(['XREVRANGE', ...args.map(String)]);
  }

  scanStream(options?: { match?: string; count?: number }): EventEmitter {
    const ee = new EventEmitter();
    const pattern = options?.match ?? '*';
    const count = options?.count ?? 100;

    queueMicrotask(async () => {
      try {
        if (typeof this.client.scanIterator === 'function') {
          const batch: string[] = [];
          for await (const keys of this.client.scanIterator({ MATCH: pattern, COUNT: count })) {
            batch.push(...(Array.isArray(keys) ? keys : [keys]));
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
    if (event === 'message' || event === 'smessage') return super.on(event, listener);
    if (typeof this.client.on === 'function') {
      this.client.on(event === 'close' ? 'end' : event, listener);
    }
    return this;
  }

  once(event: string, listener: (...args: any[]) => void): this {
    if (event === 'message' || event === 'smessage') return super.once(event, listener);
    if (typeof this.client.once === 'function') {
      this.client.once(event === 'close' ? 'end' : event, listener);
    }
    return this;
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    super.removeListener(event, listener);
    this.client.removeListener?.(event === 'close' ? 'end' : event, listener);
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
