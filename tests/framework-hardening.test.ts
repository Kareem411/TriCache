import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import { metrics, trace } from '@opentelemetry/api';
import type { CacheEntry, CacheHandler } from 'next/cache';
import { CacheService } from '../src/cache-service.js';
import { TriCacheHandler } from '../src/next/cache-handler.js';
import { EdgeCacheService } from '../src/edge/cache.js';
import { type IEdgeRemoteStorage } from '../src/edge/types.js';
import { createExpressMiddleware } from '../src/http/express.js';
import { cacheMiddleware } from '../src/hono/index.js';
import type { ICacheMeter, ICacheTracer } from '../src/types.js';
import { MemoryRedis } from './helpers/memory-redis.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const caches: CacheService[] = [];
function handler(options: ConstructorParameters<typeof TriCacheHandler>[0] = {}) {
  const value = new TriCacheHandler({ namespace: `next-hardening-${randomUUID()}`, disableRedis: true, disableDisk: true, oomProtection: false, compression: 'none', logger, ...options });
  caches.push((value as unknown as { cache: CacheService }).cache);
  return value;
}
function entry(value = 'rsc', tags = ['items']): CacheEntry {
  return { value: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(value)); controller.close(); } }),
    tags, timestamp: Date.now(), stale: 5, revalidate: 60, expire: 3600 };
}
async function text(value: ReadableStream<Uint8Array>): Promise<string> { return new Response(value).text(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { resolve, promise };
}
function remote() {
  const data = new Map<string, string>();
  const versions = new Map<string, number>();
  const calls: string[] = [];
  const storage: IEdgeRemoteStorage = {
    async get(key) { calls.push(`get ${key}`); return data.get(key) ?? null; },
    async set(key, value) { calls.push(`set ${key}`); data.set(key, value); },
    async delete(key) { data.delete(key); },
    async getTagVersion(tag) { return versions.get(tag) ?? 1; },
    async incrementTagVersion(tag) { const value = (versions.get(tag) ?? 0) + 1; versions.set(tag, value); return value; },
    async clear(prefix) { for (const key of data.keys()) if (!prefix || key.startsWith(prefix)) data.delete(key); },
  };
  return { storage, data, versions, calls };
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(caches.splice(0).map(cache => cache.destroy()));
});

describe('Native Next.js CacheHandler contract', () => {
  it('implements the installed Next.js interface and preserves all CacheEntry timings', async () => {
    const native: CacheHandler = handler();
    const value = entry();
    await native.set('rsc', Promise.resolve(value));
    const result = await native.get('rsc', []);
    expect(result).toMatchObject({ tags: ['items'], stale: 5, revalidate: 60, expire: 3600, timestamp: value.timestamp });
    expect(await text(result!.value)).toBe('rsc');
  });

  it('waits for a pending set before returning a miss', async () => {
    const native: CacheHandler = handler();
    const ready = deferred<CacheEntry>();
    const writing = native.set('rsc', ready.promise);
    let finished = false;
    const reading = native.get('rsc', []).then(value => { finished = true; return value; });
    await Promise.resolve();
    expect(finished).toBe(false);
    ready.resolve(entry());
    await writing;
    expect(await text((await reading)!.value)).toBe('rsc');
  });

  it('restores a real unlocked stream from a cold Redis-backed entry', async () => {
    const redis = new MemoryRedis();
    const value = handler({ disableRedis: false, redisClient: redis, invalidationBackplane: false });
    await value.set('rsc', Promise.resolve(entry()));
    const cache = (value as unknown as { cache: CacheService }).cache;
    (cache as unknown as { l1: { clear(): void } }).l1.clear();
    const first = await value.get('rsc', []);
    const second = await value.get('rsc', []);
    expect(await text(first!.value)).toBe('rsc');
    expect(await text(second!.value)).toBe('rsc');
  });

  it('honors delayed tag expiration with revalidate:-1, then expires the entry', async () => {
    vi.useFakeTimers();
    const native: CacheHandler = handler();
    await native.set('rsc', Promise.resolve(entry('old')));
    await native.updateTags(['items'], { expire: 5 });
    const stale = await native.get('rsc', []);
    expect(stale?.revalidate).toBe(-1);
    expect(await text(stale!.value)).toBe('old');
    await vi.advanceTimersByTimeAsync(6000);
    expect(await native.get('rsc', [])).toBeUndefined();
  });

  it('allows freshly computed entries after a hard tag invalidation', async () => {
    vi.useFakeTimers();
    const native: CacheHandler = handler();
    await native.set('rsc', Promise.resolve(entry('old')));
    await native.updateTags(['items']);
    await native.set('rsc', Promise.resolve(entry('fresh')));
    expect(await text((await native.get('rsc', []))!.value)).toBe('fresh');
  });

  it('treats a present duration without expire as stale rather than immediately expired', async () => {
    vi.useFakeTimers();
    const native: CacheHandler = handler();
    await native.set('rsc', Promise.resolve(entry('old')));
    await native.updateTags(['items'], {});
    await vi.advanceTimersByTimeAsync(1000);
    expect((await native.get('rsc', []))?.revalidate).toBe(-1);
  });

  it('drops a computation invalidated while its RSC stream is still being written', async () => {
    const native: CacheHandler = handler();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const started = deferred<void>();
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { started.resolve(); } });
    const writing = native.set('rsc', Promise.resolve({ ...entry(), value: stream }));
    await started.promise;
    await native.updateTags(['items']);
    controller.enqueue(new TextEncoder().encode('old'));
    controller.close();
    await writing;
    expect(await native.get('rsc', [])).toBeUndefined();
  });

  it('bounds stream buffering and uses the explicit soft-tag delegation sentinel', async () => {
    const native: CacheHandler = handler({ maxStreamBytes: 4 });
    await native.set('rsc', Promise.resolve(entry('too-large')));
    expect(await native.get('rsc', [])).toBeUndefined();
    expect(await native.getExpiration(['layout'])).toBe(Infinity);
    expect(await native.getExpiration([])).toBe(0);
  });
});

describe('Edge cache production hardening', () => {
  it('does not use an isolate-local Bloom filter to reject peer-written remote keys', async () => {
    const { storage, data, calls } = remote();
    data.set('external', JSON.stringify('peer-value'));
    const cache = new EdgeCacheService({ remoteStorage: storage, bloomFilter: true });
    expect(await cache.get('external')).toBe('peer-value');
    expect(calls).toContain('get external');
  });

  it('only trusts Bloom negatives after an explicit complete-keyset opt-in', async () => {
    const { storage, calls } = remote();
    const cache = new EdgeCacheService({ remoteStorage: storage, bloomFilter: true, bloomFilterAuthoritative: true });
    expect(await cache.get('missing')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('preserves tag metadata without rewriting the remote entry during promotion', async () => {
    vi.useFakeTimers();
    const { storage, calls } = remote();
    const writer = new EdgeCacheService({ remoteStorage: storage });
    await writer.set('item', 'old', 60, { tags: ['items'] });
    const before = calls.filter(call => call.startsWith('set')).length;
    const reader = new EdgeCacheService({ remoteStorage: storage });
    expect(await reader.get('item')).toBe('old');
    expect(calls.filter(call => call.startsWith('set')).length).toBe(before);
    await writer.invalidateTag('items');
    await vi.advanceTimersByTimeAsync(900);
    expect(await reader.get('item')).toBeNull();
  });

  it('preserves the stored expiry when a second isolate promotes a value', async () => {
    vi.useFakeTimers();
    const { storage } = remote();
    const writer = new EdgeCacheService({ remoteStorage: storage });
    await writer.set('item', 'old', 1);
    await vi.advanceTimersByTimeAsync(800);
    const reader = new EdgeCacheService({ remoteStorage: storage });
    expect(await reader.get('item')).toBe('old');
    await vi.advanceTimersByTimeAsync(300);
    expect(await reader.get('item')).toBeNull();
  });

  it('does not resurrect a key deleted during a fetch', async () => {
    const { storage } = remote();
    const cache = new EdgeCacheService({ remoteStorage: storage });
    const result = deferred<string>();
    const started = deferred<void>();
    const reading = cache.get('item', () => { started.resolve(); return result.promise; });
    await started.promise;
    await cache.delete('item');
    result.resolve('old');
    await reading;
    expect(await cache.get('item')).toBeNull();
  });

  it('does not overflow the byte cap with one oversized value', async () => {
    const cache = new EdgeCacheService({ maxBytes: 100 });
    await cache.set('item', 'x'.repeat(1000));
    expect(cache.stats().bytes).toBeLessThanOrEqual(100);
    expect(await cache.get('item')).toBeNull();
  });

  it('keeps prefix-overlapping namespaces isolated during clear', async () => {
    const { storage } = remote();
    const first = new EdgeCacheService({ namespace: 'a', remoteStorage: storage });
    const second = new EdgeCacheService({ namespace: 'ab', remoteStorage: storage });
    await first.set('item', 'a');
    await second.set('item', 'ab');
    await first.clear();
    expect(await second.get('item')).toBe('ab');
  });
});

describe('Shared HTTP response privacy', () => {
  it('works with real Hono and runs response refresh entirely inside the current request', async () => {
    vi.useFakeTimers();
    const cache = new CacheService({ disableRedis: true, disableDisk: true, oomProtection: false, logger });
    caches.push(cache);
    const middleware: MiddlewareHandler = cacheMiddleware({ cache, ttl: 1, swr: 60 });
    const app = new Hono();
    const started = deferred<void>();
    const finish = deferred<void>();
    let calls = 0;
    app.get('/refresh', middleware, async c => {
      calls++;
      if (calls === 2) { started.resolve(); await finish.promise; }
      return c.json({ calls });
    });
    expect(await (await app.request('/refresh')).json()).toEqual({ calls: 1 });
    await vi.advanceTimersByTimeAsync(1100);
    let replied = false;
    const refreshing = Promise.resolve(app.request('/refresh')).then(response => { replied = true; return response; });
    await started.promise;
    expect(replied).toBe(false); // No stale reply followed by background next()/double-send.
    finish.resolve();
    expect(await (await refreshing).json()).toEqual({ calls: 2 });
    expect(await (await app.request('/refresh')).json()).toEqual({ calls: 2 });
    expect(calls).toBe(2);
  });

  it('never caches only the final chunk of an Express streamed response', async () => {
    const cache = new CacheService({ disableRedis: true, disableDisk: true, oomProtection: false, logger });
    caches.push(cache);
    const middleware = createExpressMiddleware({ cache });
    let calls = 0;
    const request = async () => {
      let body = '';
      const response = { statusCode: 200, headersSent: false,
        write(chunk: string) { body += chunk; }, end(chunk: string) { body += chunk; this.headersSent = true; } };
      await middleware({ method: 'GET', url: '/chunks', headers: {} }, response, () => {
        calls++;
        response.write('first');
        response.end('last');
      });
      return body;
    };
    expect(await request()).toBe('firstlast');
    expect(await request()).toBe('firstlast');
    expect(calls).toBe(2);
  });

  it('never stores explicitly private or no-store responses', async () => {
    const cache = new CacheService({ namespace: randomUUID(), disableRedis: true, disableDisk: true, compression: 'none', oomProtection: false, logger });
    caches.push(cache);
    const middleware = createExpressMiddleware({ cache });
    let calls = 0;
    const request = async () => {
      const headers: Record<string, string> = {};
      let body: unknown;
      const response = { statusCode: 200, headersSent: false, getHeader: (key: string) => headers[key.toLowerCase()],
        setHeader: (key: string, value: string) => { headers[key.toLowerCase()] = value; },
        json(value: unknown) { body = value; this.headersSent = true; }, send(value: unknown) { body = value; this.headersSent = true; }, end() {} };
      await middleware({ method: 'GET', url: '/private', headers: {} }, response, () => {
        response.setHeader('cache-control', 'private, no-store');
        response.json({ caller: ++calls });
      });
      return body;
    };
    expect(await request()).toEqual({ caller: 1 });
    expect(await request()).toEqual({ caller: 2 });
  });
});

describe('Actual OpenTelemetry API compatibility', () => {
  it('accepts real Meter/Tracer objects and removes observable callbacks at shutdown', async () => {
    const meter: ICacheMeter = metrics.getMeter('tricache-hardening');
    const tracer: ICacheTracer = trace.getTracer('tricache-hardening');
    const add = vi.spyOn(meter, 'addBatchObservableCallback');
    const remove = vi.spyOn(meter, 'removeBatchObservableCallback');
    const cache = new CacheService({ meter, tracer, disableRedis: true, disableDisk: true, oomProtection: false, logger });
    caches.push(cache);
    await cache.get('otel', async () => 'value');
    expect(add).toHaveBeenCalledOnce();
    const [callback, observables] = add.mock.calls[0];
    await cache.destroy();
    expect(remove).toHaveBeenCalledWith(callback, observables);
    const observe = vi.fn();
    await callback({ observe });
    expect(observe).not.toHaveBeenCalled();
  });
});
