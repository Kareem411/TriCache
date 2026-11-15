import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { CacheService } from '../src/cache-service.js';
import { SmartMemoryCache } from '../src/smart-memory-cache.js';
import { BoundedDiskQueue, DiskTier } from '../src/disk-tier.js';
import { CachePriority, type CacheOptions } from '../src/types.js';
import { IpcTelemetryServer, resolveIpcSocketPath } from '../src/ipc-telemetry.js';
import { generatePrismaCacheKey, withTriCache } from '../src/prisma/index.js';
import { TriCacheStore } from '../src/nestjs/tricache.store.js';
import { MemoryRedis } from './helpers/memory-redis.js';
import { redactDiagnostics } from '../src/utils/diagnostics.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const caches: CacheService[] = [];
const disks: DiskTier[] = [];
const directories: string[] = [];
const servers: IpcTelemetryServer[] = [];
const localOptions = { disableRedis: true, disableDisk: true, compression: 'none' as const, oomProtection: false, logger };

function cache(options: CacheOptions = {}): CacheService {
  const instance = new CacheService({ ...localOptions, namespace: `hardening-${randomUUID()}`, ...options });
  caches.push(instance);
  return instance;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function directory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tricache-hardening-'));
  directories.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(caches.splice(0).map(instance => instance.destroy()));
  await Promise.all(servers.splice(0).map(server => server.close()));
  for (const disk of disks.splice(0)) disk.close();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Production hardening: cache consistency', () => {
  it('recovers after a fetcher throws synchronously', async () => {
    const instance = cache();
    await expect(instance.get('item', () => { throw new Error('transient'); })).rejects.toThrow('transient');
    expect(await instance.get('item', async () => 'recovered')).toBe('recovered');
  });

  it('does not delete a replacement singleflight when an older fetch completes', async () => {
    const instance = cache();
    const old = deferred<string>();
    const fresh = deferred<string>();
    const first = instance.get('item', () => old.promise);
    await instance.delete('item');
    const second = instance.get('item', () => fresh.promise);
    old.resolve('old');
    await first;
    const unexpected = vi.fn(async () => 'duplicate');
    const third = instance.get('item', unexpected);
    fresh.resolve('fresh');
    expect(await Promise.all([second, third])).toEqual(['fresh', 'fresh']);
    expect(unexpected).not.toHaveBeenCalled();
  });

  it('does not repopulate a deleted key after batch fetching', async () => {
    const instance = cache();
    const result = deferred<Record<string, string>>();
    const pending = instance.mget(['item'], () => result.promise);
    await instance.delete('item');
    result.resolve({ item: 'old' });
    await pending;
    expect(instance.has('item')).toBe(false);
  });

  it('does not stamp old fetched data with a newer tag generation', async () => {
    const instance = cache({ tagStrategy: 'generational' });
    const result = deferred<string>();
    const started = deferred<void>();
    const pending = instance.get('item', () => { started.resolve(); return result.promise; }, 60, { tags: ['items'] });
    await started.promise;
    await instance.invalidateTag('items');
    result.resolve('old');
    await pending;
    expect(await instance.get('item', async () => 'fresh', 60, { tags: ['items'] })).toBe('fresh');
  });

  it('broadcasts set-based tag invalidations to peers with cold-read promotions', async () => {
    const redis = new MemoryRedis();
    const namespace = `tags-${randomUUID()}`;
    const writer = cache({ namespace, disableRedis: false, redisClient: redis, awaitInvalidationBackplane: true });
    const peer = cache({ namespace, disableRedis: false, redisClient: redis.duplicate(), awaitInvalidationBackplane: true });
    await writer.set('item', 'old', 60, undefined, { tags: ['items'] });
    expect(await peer.get('item', async () => 'unexpected')).toBe('old');
    await writer.invalidateTag('items');
    expect(await peer.get('item', async () => 'fresh')).toBe('fresh');
  });

  it('does not mutate Redis through read-only get, touch, or tag invalidation', async () => {
    const redis = new MemoryRedis();
    const instance = cache({ disableRedis: false, redisClient: redis, invalidationBackplane: false, l2WriteMode: 'read-only' });
    await instance.get('item', async () => 'v', 60, { tags: ['items'] });
    await instance.touch('item', 120);
    await instance.invalidateTag('items');
    expect(redis.commands.filter(command => /^(set|expire|del|incr|eval|publish)\b/.test(command))).toEqual([]);
  });

  it('preserves the remaining Redis TTL on cold promotion', async () => {
    vi.useFakeTimers();
    const redis = new MemoryRedis();
    const instance = cache({ namespace: 'ttl-hardening', disableRedis: false, redisClient: redis, invalidationBackplane: false });
    await redis.set('ttl-hardening:item', JSON.stringify('old'), 'PX', 1000);
    expect(await instance.get('item', async () => 'unexpected', 300)).toBe('old');
    await vi.advanceTimersByTimeAsync(1100);
    expect(await instance.get('item', async () => 'fresh', 300)).toBe('fresh');
  });

  it('updates both hash expiry metadata and the Redis TTL when touching an entry', async () => {
    vi.useFakeTimers();
    const redis = new MemoryRedis();
    const namespace = `touch-${randomUUID()}`;
    const writer = cache({ namespace, disableRedis: false, redisClient: redis, invalidationBackplane: false, tagStrategy: 'generational' });
    await writer.set('item', 'value', 1, undefined, { tags: ['items'] });
    await writer.touch('item', 5);
    await vi.advanceTimersByTimeAsync(2000);
    const reader = cache({ namespace, disableRedis: false, redisClient: redis.duplicate(), invalidationBackplane: false, tagStrategy: 'generational' });
    expect(await reader.peek('item')).toBe('value');
  });

  it('recovers from a transient failure during initial stream cursor setup', async () => {
    vi.useFakeTimers();
    const redis = new MemoryRedis();
    const stream = Object.assign(redis.duplicate(), {
      xrevrange: vi.fn().mockRejectedValueOnce(new Error('transient Redis disconnect')).mockResolvedValue([]),
      xrange: vi.fn(async () => []),
      xread: vi.fn(async () => null),
    });
    const instance = cache({ disableRedis: false, redisClient: redis, redisSubClient: stream,
      invalidationBackplane: true, backplaneMode: 'stream', backplaneStreamBlockMs: 10 });
    await instance.ready();
    await vi.advanceTimersByTimeAsync(220);
    expect(stream.xrevrange.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(instance.health().details?.backplaneReady).toBe(true);
  });

  it('honors wrap dependency options', async () => {
    const instance = cache();
    await instance.wrap('dependent', async () => 'v', { dependsOn: ['source'] });
    await instance.delete('source');
    expect(instance.has('dependent')).toBe(false);
  });

  it('preserves tags and dependencies on keys outside a middle-wildcard deletion', async () => {
    const instance = cache();
    await instance.set('item:keep:other', 'tagged', 60, undefined, { tags: ['items'] });
    await instance.set('item:keep:dependent', 'dependent', 60, undefined, { dependsOn: ['source'] });
    await instance.set('item:gone:profile', 'matching', 60, undefined, { tags: ['items'] });
    await instance.delete('item:*:profile');
    expect(instance.has('item:keep:other')).toBe(true);
    expect(instance.has('item:keep:dependent')).toBe(true);
    await instance.invalidateTag('items');
    expect(instance.has('item:keep:other')).toBe(false);
    await instance.delete('source');
    expect(instance.has('item:keep:dependent')).toBe(false);
  });

  it('returns decoded large values from scan', async () => {
    const instance = cache();
    const value = { payload: 'x'.repeat(17000) };
    await instance.set('item', value);
    const values: unknown[] = [];
    instance.scan((_key, entry) => values.push(entry));
    expect(Buffer.isBuffer(values[0])).toBe(false);
    expect((values[0] as { payload: string }).payload).toBe(value.payload);
  });

  it('counts batch requests in the hit-rate denominator', async () => {
    const instance = cache();
    await instance.set('item', 'v');
    await instance.mget(['item', 'item', 'item']);
    await instance.get('item', async () => 'v');
    expect(instance.metrics().gets).toMatchObject({ total: 4, l1Hits: 4, l1HitRate: 1 });
  });
});

describe('Production hardening: admission and disk bounds', () => {
  it('enforces count and byte ceilings during snapshot import', () => {
    const source = new SmartMemoryCache({ maxEntries: 10, maxBytes: 100000, categories: { default: { maxEntries: 10, maxSizeBytes: 100000 } }, logger });
    for (let i = 0; i < 5; i++) source.set(`k${i}`, { payload: 'x'.repeat(100) }, 60000);
    const target = new SmartMemoryCache({ maxEntries: 1, maxBytes: 1, categories: { default: { maxEntries: 1, maxSizeBytes: 1 } }, logger });
    target.importEntries(source.exportEntries([]), []);
    expect(target.size).toBeLessThanOrEqual(1);
    expect(target.memoryUsage).toBeLessThanOrEqual(1);
  });

  it('enforces TinyLFU category counts', async () => {
    const instance = cache({ l1AdmissionPolicy: 'wtinylfu', l1MaxEntries: 100, categoryLimits: { default: { maxEntries: 2, maxSizeBytes: 100000 } } });
    for (let i = 0; i < 10; i++) await instance.set(`k${i}`, 'v');
    expect(instance.stats().l1.entries).toBeLessThanOrEqual(2);
  });

  it('protects critical entries without overflowing TinyLFU capacity', () => {
    const instance = new SmartMemoryCache({ admissionPolicy: 'wtinylfu', maxEntries: 3, maxBytes: 100000, categories: { default: { maxEntries: 3, maxSizeBytes: 100000 } }, logger });
    instance.set('auth', 'token', 60000, CachePriority.CRITICAL);
    for (let i = 0; i < 30; i++) instance.set(`k${i}`, 'v', 60000);
    expect(instance.has('auth')).toBe(true);
    expect(instance.size).toBeLessThanOrEqual(3);
  });

  it('does not keep an old value when an oversized replacement is rejected', () => {
    const instance = new SmartMemoryCache({ maxEntries: 10, maxBytes: 1000, categories: { default: { maxEntries: 10, maxSizeBytes: 1000 } }, logger });
    instance.set('item', 'old', 60000);
    instance.set('item', 'x'.repeat(2000), 60000);
    expect(instance.has('item')).toBe(false);
  });

  it('retains the physical concurrency reservation after a caller timeout', async () => {
    vi.useFakeTimers();
    const queue = new BoundedDiskQueue(1, 3, 10, 99, 0);
    const work = deferred<boolean>();
    const first = queue.schedule(() => work.promise);
    await vi.advanceTimersByTimeAsync(20);
    expect(await first).toBeNull();
    expect(queue.getStats().activeWrites).toBe(1);
    const later = vi.fn(async () => true);
    const second = queue.schedule(later);
    await vi.advanceTimersByTimeAsync(20);
    expect(later).not.toHaveBeenCalled();
    work.resolve(true);
    expect(await second).toBe(true);
    expect(queue.getStats().activeWrites).toBe(0);
  });

  it('never resurrects a superseded disk spill after a shorter replacement expires', async () => {
    const dir = directory();
    const instance = cache({ disableDisk: false, diskCacheDir: dir, snapshotPath: path.join(dir, 'snapshot') });
    const internals = instance as unknown as { l1: SmartMemoryCache; disk: DiskTier };
    await instance.set('item', 'old', 300);
    let spilled: Promise<void> | undefined;
    const save = internals.disk.save.bind(internals.disk);
    vi.spyOn(internals.disk, 'save').mockImplementation((key, entry) => { spilled = save(key, entry); return spilled; });
    internals.l1.evictPercentage(1);
    await new Promise<void>(r => setImmediate(r));
    await spilled;
    await instance.set('item', 'new', 0.05);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    expect(await instance.get('item', async () => 'fresh')).toBe('fresh');
  });

  it('selects the newest file-only write, even when its TTL is shorter', async () => {
    const disk = new DiskTier({ dir: directory(), maxBytes: 1000000, entryMaxBytes: 100000, logger });
    disks.push(disk);
    (disk as unknown as { _initSqlite(): void })._initSqlite = () => {};
    const now = Date.now();
    const entry = (data: string, ttl: number, setAt: number) => ({ data: JSON.stringify(data), isCompressed: false, expiresAt: now + ttl, setAt, size: data.length, hits: 1, lastAccess: now, priority: 2 });
    await disk.save('item', entry('old', 60000, now));
    await disk.save('item', entry('new', 30000, now + 1));
    expect(disk.load('item')?.data).toBe(JSON.stringify('new'));
  });

  it('does not resurrect old disk data when bounded pattern tombstones are compacted', async () => {
    vi.useFakeTimers();
    const dir = directory();
    const instance = cache({ disableDisk: false, diskCacheDir: dir, snapshotPath: path.join(dir, 'snapshot') });
    const disk = (instance as unknown as { disk: DiskTier }).disk;
    const now = Date.now();
    await disk.save(`${instance.options.namespace}:old:item`, { data: JSON.stringify('old'), isCompressed: false,
      expiresAt: now + 3 * 3600000, setAt: now, size: 5, hits: 1, lastAccess: now, priority: 2 });
    await instance.delete('old:*');
    await vi.advanceTimersByTimeAsync(3600001);
    await instance.delete('unrelated:*'); // Drops the old detailed tombstone but must retain a conservative cutoff.
    expect(await instance.get('old:item', async () => 'fresh')).toBe('fresh');
  });
});

describe('Production hardening: adapters and process ownership', () => {
  it('redacts URL credentials and does not preserve an opaque credential-bearing toJSON', () => {
    const diagnostics = redactDiagnostics({ adapter: { url: 'redis://user:password@cache.internal/0?token=secret',
      privateKey: 'private-bytes', toJSON: () => 'hidden-secret' } });
    const text = JSON.stringify(diagnostics);
    for (const secret of ['user:', 'password@', 'token=secret', 'private-bytes', 'hidden-secret']) expect(text).not.toContain(secret);
  });

  it('distinguishes Date and bigint query filters from each other and from strings', () => {
    const key = (value: unknown) => generatePrismaCacheKey('Event', 'findMany', { where: { value } });
    expect(key(new Date('2025-01-01'))).not.toBe(key(new Date('2026-01-01')));
    expect(key(10n)).not.toBe(key('10'));
  });

  it('honors an explicit Prisma cache:false override', async () => {
    const instance = cache();
    const extension = withTriCache({ cache: instance, autoCache: true });
    const query = vi.fn(async () => 'v');
    const request = { model: 'Item', operation: 'findMany', args: { cache: false }, query };
    await extension.query.$allModels.$allOperations(request);
    await extension.query.$allModels.$allOperations(request);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith({});
  });

  it('preserves sub-second NestJS store TTLs rather than mapping them to indefinite', async () => {
    const instance = cache();
    const store = new TriCacheStore(instance);
    await store.set('item', 'v', 100);
    expect(instance.ttl('item')).toBe(1);
  });

  it('does not terminate the host when IPC receives a shutdown signal', async () => {
    const instance = cache();
    const server = new IpcTelemetryServer(instance, resolveIpcSocketPath(`hardening-${randomUUID()}`));
    servers.push(server);
    await server.start();
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('Library attempted to exit'); });
    (server as unknown as { _sigtermHandler(): void })._sigtermHandler();
    expect(exit).not.toHaveBeenCalled();
  });

  it('coalesces IPC startup and closes idle clients without leaking a server', async () => {
    const instance = cache();
    const server = new IpcTelemetryServer(instance, resolveIpcSocketPath(`hardening-${randomUUID()}`));
    servers.push(server);
    await Promise.all([server.start(), server.start()]);
    const socket = net.createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    await server.close();
    await closed;
    expect(server.isListening).toBe(false);
    await server.start();
    expect(server.isListening).toBe(false);
    const cancelled = new IpcTelemetryServer(instance, resolveIpcSocketPath(`cancelled-${randomUUID()}`));
    servers.push(cancelled);
    const starting = cancelled.start();
    await cancelled.close();
    await starting;
    expect(cancelled.isListening).toBe(false);
  });
});
