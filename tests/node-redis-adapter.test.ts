import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  NodeRedisAdapter,
  createNodeRedisAdapter,
} from '../src/adapters/node-redis';
import { CacheService } from '../src/cache-service';

/**
 * Creates a faithful in-memory mock of `@redis/client` (node-redis v4/v5/v6).
 * Follows node-redis camelCase conventions (`sAdd`, `sMembers`, `setEx`, `mGet`, `sendCommand`).
 */
function createMockNodeRedisClient() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  const sets = new Map<string, Set<string>>();
  const ee = new EventEmitter();

  const client = {
    isOpen: true,
    async connect() {
      client.isOpen = true;
      ee.emit('ready');
    },
    async disconnect() {
      client.isOpen = false;
      ee.emit('end');
    },
    async quit() {
      client.isOpen = false;
      ee.emit('end');
    },
    async ping() {
      return 'PONG';
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string, options?: { EX?: number; PX?: number; NX?: boolean; XX?: boolean }) {
      if (options?.NX && store.has(key)) {
        return null;
      }
      if (options?.XX && !store.has(key)) {
        return null;
      }
      store.set(key, value);
      if (options?.EX) {
        ttls.set(key, options.EX);
      }
      return 'OK';
    },
    async setEx(key: string, seconds: number, value: string) {
      store.set(key, value);
      ttls.set(key, seconds);
      return 'OK';
    },
    async del(keys: string | string[]) {
      const arr = Array.isArray(keys) ? keys : [keys];
      let count = 0;
      for (const k of arr) {
        if (store.delete(k)) count++;
        ttls.delete(k);
        sets.delete(k);
      }
      return count;
    },
    async incr(key: string) {
      const cur = parseInt(store.get(key) ?? '0', 10) || 0;
      const next = cur + 1;
      store.set(key, String(next));
      return next;
    },
    async expire(key: string, seconds: number) {
      if (!store.has(key)) return 0;
      ttls.set(key, seconds);
      return 1;
    },
    async sAdd(key: string, members: string | string[]) {
      let s = sets.get(key);
      if (!s) {
        s = new Set<string>();
        sets.set(key, s);
      }
      const arr = Array.isArray(members) ? members : [members];
      let added = 0;
      for (const m of arr) {
        if (!s.has(m)) {
          s.add(m);
          added++;
        }
      }
      return added;
    },
    async sMembers(key: string) {
      const s = sets.get(key);
      return s ? Array.from(s) : [];
    },
    async mGet(keys: string[]) {
      return keys.map(k => store.get(k) ?? null);
    },
    async hSet(key: string, value: Record<string, string>) {
      store.set(key, JSON.stringify(value));
      return Object.keys(value).length;
    },
    async sendCommand(args: string[]) {
      const cmd = (args[0] || '').toUpperCase();
      if (cmd === 'EVAL') {
        const script = args[1];
        const numKeys = parseInt(args[2], 10) || 0;
        const keys = args.slice(3, 3 + numKeys);
        const scriptArgs = args.slice(3 + numKeys);

        // Lua lock release script emulation
        if (script.includes('redis.call("get", KEYS[1]) == ARGV[1]')) {
          const storedToken = store.get(keys[0]);
          if (storedToken === scriptArgs[0]) {
            store.delete(keys[0]);
            return 1;
          }
          return 0;
        }

        // Lua compare and delete emulation
        if (script.includes("redis.call('HGET', KEYS[1], 't')")) {
          store.delete(keys[0]);
          return 1;
        }

        return 'OK';
      }

      if (cmd === 'SCAN') {
        const pattern = args[2] === 'MATCH' ? args[3] : '*';
        const allKeys = Array.from(store.keys());
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        const matched = allKeys.filter(k => regex.test(k));
        return ['0', matched];
      }

      return 'OK';
    },
    async *scanIterator(options?: { MATCH?: string; COUNT?: number }) {
      const pattern = options?.MATCH ?? '*';
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      for (const k of store.keys()) {
        if (regex.test(k)) yield k;
      }
    },
    duplicate() {
      return createMockNodeRedisClient();
    },
    on(event: string, listener: (...args: any[]) => void) {
      ee.on(event, listener);
      return client;
    },
    once(event: string, listener: (...args: any[]) => void) {
      ee.once(event, listener);
      return client;
    },
    multi() {
      const queue: Array<() => any> = [];
      const multi = {
        get(key: string) {
          queue.push(() => client.get(key));
          return multi;
        },
        set(key: string, value: string, opts?: any) {
          queue.push(() => client.set(key, value, opts));
          return multi;
        },
        setEx(key: string, sec: number, val: string) {
          queue.push(() => client.setEx(key, sec, val));
          return multi;
        },
        del(keys: string | string[]) {
          queue.push(() => client.del(keys));
          return multi;
        },
        expire(key: string, sec: number) {
          queue.push(() => client.expire(key, sec));
          return multi;
        },
        incr(key: string) {
          queue.push(() => client.incr(key));
          return multi;
        },
        sAdd(key: string, members: string | string[]) {
          queue.push(() => client.sAdd(key, members));
          return multi;
        },
        sMembers(key: string) {
          queue.push(() => client.sMembers(key));
          return multi;
        },
        hSet(key: string, value: Record<string, string>) {
          queue.push(() => client.hSet(key, value));
          return multi;
        },
        async exec() {
          const results: any[] = [];
          for (const fn of queue) {
            results.push(await fn());
          }
          return results;
        },
      };
      return multi;
    },
  };

  return { client, store, ttls, sets, ee };
}

describe('NodeRedisAdapter — Command & Pipeline Translation', () => {
  let mock: ReturnType<typeof createMockNodeRedisClient>;
  let adapter: NodeRedisAdapter;

  beforeEach(() => {
    mock = createMockNodeRedisClient();
    adapter = new NodeRedisAdapter(mock.client);
  });

  it('translates get, set, and setex operations', async () => {
    await adapter.set('item:1', 'alpha');
    expect(await adapter.get('item:1')).toBe('alpha');

    await adapter.setex('item:2', 120, 'beta');
    expect(await adapter.get('item:2')).toBe('beta');
    expect(mock.ttls.get('item:2')).toBe(120);
  });

  it('translates set with EX and NX options into node-redis object parameter', async () => {
    const res1 = await adapter.set('idempotent:key', 'first', 'EX', 30, 'NX');
    expect(res1).toBe('OK');
    expect(mock.ttls.get('idempotent:key')).toBe(30);

    // Second write with NX must return null (not overwritten)
    const res2 = await adapter.set('idempotent:key', 'second', 'EX', 30, 'NX');
    expect(res2).toBeNull();
    expect(await adapter.get('idempotent:key')).toBe('first');
  });

  it('translates del across single and multi-key signatures', async () => {
    await adapter.set('d1', 'val1');
    await adapter.set('d2', 'val2');
    const count = await adapter.del('d1', 'd2');
    expect(count).toBe(2);
    expect(await adapter.get('d1')).toBeNull();
  });

  it('translates atomic incr and expire', async () => {
    const val = await adapter.incr('counter:hits');
    expect(val).toBe(1);
    const exp = await adapter.expire('counter:hits', 60);
    expect(exp).toBe(1);
    expect(mock.ttls.get('counter:hits')).toBe(60);
  });

  it('translates Set operations (sadd and smembers)', async () => {
    await adapter.sadd('tag:orders', 'order:1', 'order:2');
    const members = await adapter.smembers('tag:orders');
    expect(members).toContain('order:1');
    expect(members).toContain('order:2');
  });

  it('translates pipeline/multi calls into tuple responses ([null, result])', async () => {
    await adapter.set('p1', 'alpha');
    await adapter.set('p2', 'beta');

    const pl = adapter.pipeline();
    pl.get('p1');
    pl.get('p2');
    const results = await pl.exec();

    expect(results).toEqual([
      [null, 'alpha'],
      [null, 'beta'],
    ]);
  });

  it('streams matching keys via scanStream', async () => {
    await adapter.set('tenant:1:user:1', 'data1');
    await adapter.set('tenant:1:user:2', 'data2');
    await adapter.set('tenant:2:user:1', 'data3');

    const stream = adapter.scanStream({ match: 'tenant:1:*' });
    const collected: string[] = [];

    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: string[]) => collected.push(...chunk));
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    expect(collected).toContain('tenant:1:user:1');
    expect(collected).toContain('tenant:1:user:2');
    expect(collected).not.toContain('tenant:2:user:1');
  });

  it('implements duplicate() returning an adapted client', () => {
    const dup = adapter.duplicate();
    expect(dup).toBeInstanceOf(NodeRedisAdapter);
    expect((dup as NodeRedisAdapter).client).not.toBe(adapter.client);
  });
});

describe('CacheService Integration with NodeRedisAdapter', () => {
  let mock: ReturnType<typeof createMockNodeRedisClient>;
  let cache: CacheService;

  beforeEach(() => {
    mock = createMockNodeRedisClient();
    const adapter = createNodeRedisAdapter(mock.client);

    cache = CacheService.create({
      namespace: `test_node_redis_${Date.now()}_${Math.random()}`,
      redisClient: adapter,
      disableDisk: true,
      invalidationBackplane: false, // keep standalone in test
    });
  });

  afterEach(async () => {
    await cache.destroy();
  });

  it('reads and writes through to node-redis L2 tier', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ id: 101, username: 'dev_user' });

    // 1. Initial fetch on cold cache
    const user1 = await cache.get('user:101', fetchFn, 300);
    expect(user1).toEqual({ id: 101, username: 'dev_user' });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // 2. Clear L1 memory to verify L2 persistence
    (cache as any).l1.clear();

    // 3. Second get should be served from adapted node-redis without invoking fetcher
    const user2 = await cache.get('user:101', fetchFn, 300);
    expect(user2).toEqual({ id: 101, username: 'dev_user' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('propagates deletes to adapted node-redis driver', async () => {
    await cache.set('profile:12', { theme: 'dark' }, 300);
    (cache as any).l1.clear();

    // Verify present in L2
    const peeked = await cache.peek('profile:12');
    expect(peeked).toEqual({ theme: 'dark' });

    // Delete key
    await cache.delete('profile:12');

    // Verify removed from L2
    const afterDel = await cache.peek('profile:12');
    expect(afterDel).toBeNull();
  });

  it('executes distributed rate limit counter on adapted driver', async () => {
    const c1 = await cache.increment('rate:api:client_a', 60);
    const c2 = await cache.increment('rate:api:client_a', 60);
    const c3 = await cache.increment('rate:api:client_a', 60);

    expect(c1).toBe(1);
    expect(c2).toBe(2);
    expect(c3).toBe(3);
  });

  it('acquires and safely releases distributed lock via Lua EVAL script', async () => {
    let executed = false;

    const result = await cache.lock(
      'sync:job',
      async () => {
        executed = true;
        return 'DONE';
      },
      { ttl: 10, acquireTimeout: 2_000 },
    );

    expect(result).toBe('DONE');
    expect(executed).toBe(true);

    // Verify lock token was cleaned up from L2
    const lockKey = (cache as any).nk('lock:sync:job');
    expect(mock.store.get(lockKey)).toBeUndefined();
  });

  it('executes atomic setIfAbsent using node-redis NX parameter', async () => {
    const ok1 = await cache.setIfAbsent('job:run_once', { started: true }, 60);
    expect(ok1).toBe(true);

    // Second writer must fail
    const ok2 = await cache.setIfAbsent('job:run_once', { started: true }, 60);
    expect(ok2).toBe(false);
  });

  it('warms L1 from L2 using adapter scanStream and pipeline', async () => {
    // Populate keys in adapter storage directly
    const ns = (cache as any).nk('');
    mock.store.set(`${ns}cached:item_1`, JSON.stringify('val_1'));
    mock.store.set(`${ns}cached:item_2`, JSON.stringify('val_2'));

    const loaded = await cache.warmFromL2('cached:*');
    expect(loaded).toBe(2);

    // Verify L1 is now warm without network hop
    expect(cache.getIfFresh('cached:item_1')).toBe('val_1');
    expect(cache.getIfFresh('cached:item_2')).toBe('val_2');
  });

  it('does not disconnect caller client on destroy()', async () => {
    await cache.destroy();
    // The external client remains open so other parts of the caller service stay healthy
    expect(mock.client.isOpen).toBe(true);
  });
});
