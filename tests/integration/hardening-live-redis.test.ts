import { describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeRedisAdapter } from '../../src/adapters/node-redis.js';
import { TriCacheStore } from '../../src/nestjs/tricache.store.js';
import { NS, REDIS_URL, makeSvc, probe, redisUp, waitFor } from './redis-fixture.js';

const d = redisUp ? describe : describe.skip;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { resolve, promise };
}

d('LIVE Redis — production hardening', () => {
  it('reads hashes/batches and streams with the built-in RESP3 client configuration', async () => {
    const url = new URL(REDIS_URL);
    const options = { redisClient: undefined, redisHost: url.hostname, redisPort: Number(url.port || 6379),
      redisProtocol: 3 as const, tagStrategy: 'generational' as const, invalidationBackplane: true,
      awaitInvalidationBackplane: true, backplaneMode: 'stream' as const, backplaneStreamBlockMs: 50 };
    const writer = makeSvc(options);
    const peer = makeSvc(options);
    await Promise.all([writer.ready(), peer.ready()]);
    await writer.set('resp3', 'value', 60, undefined, { tags: ['resp3-tag'] });
    await waitFor(async () => await peer.peek('resp3') === 'value');
    (peer as unknown as { l1: { clear(): void } }).l1.clear();
    expect(await peer.mget(['resp3', 'resp3-missing'])).toEqual(['value', undefined]);
    await writer.invalidateTag('resp3-tag');
    await waitFor(() => (peer.metrics().backplane.streamEntriesReceived ?? 0) >= 2);
    await waitFor(async () => await peer.peek('resp3') === null);
  });

  it('broadcasts set-based tag deletion to a peer with only a cold Redis promotion', async () => {
    const writer = makeSvc({ invalidationBackplane: true, awaitInvalidationBackplane: true });
    const peer = makeSvc({ invalidationBackplane: true, awaitInvalidationBackplane: true });
    await Promise.all([writer.ready(), peer.ready()]);
    await writer.set('tagged', 'old', 60, undefined, { tags: ['live-items'] });
    await waitFor(async () => await peer.peek('tagged') === 'old');
    await writer.invalidateTag('live-items');
    await waitFor(() => peer.getIfFresh('tagged') === null);
    expect(await probe.exists(`${NS}:tagged`)).toBe(0);
    expect(await peer.peek('tagged')).toBeNull();
  });

  it('deletes regional L2 data and evicts local peers on a cross-region event', async () => {
    const destination = makeSvc({ invalidationBackplane: true, awaitInvalidationBackplane: true,
      crossRegion: { currentRegion: 'region-b', relay: { async broadcast() {} } } });
    const peer = makeSvc({ invalidationBackplane: true });
    await Promise.all([destination.ready(), peer.ready()]);
    await destination.set('regional', 'old', 60);
    await waitFor(async () => await peer.peek('regional') === 'old');
    expect(await destination.receiveCrossRegionInvalidation({ id: 'regional-delete', op: 'del', key: `${NS}:regional`,
      namespace: NS, originRegion: 'region-a', originInstanceId: 'foreign', timestamp: Date.now() })).toBe(true);
    await waitFor(() => peer.getIfFresh('regional') === null);
    expect(await probe.exists(`${NS}:regional`)).toBe(0);
    expect(await peer.peek('regional')).toBeNull();
  });

  it('advances regional generations even when the incoming region has a smaller counter', async () => {
    await probe.set(`${NS}:tag_ver:regional-tag`, '7');
    const destination = makeSvc({ invalidationBackplane: true, awaitInvalidationBackplane: true, tagStrategy: 'generational',
      crossRegion: { currentRegion: 'region-b', relay: { async broadcast() {} } } });
    const peer = makeSvc({ invalidationBackplane: true, tagStrategy: 'generational' });
    await Promise.all([destination.ready(), peer.ready()]);
    await destination.set('regional-tagged', 'old', 60, undefined, { tags: ['regional-tag'] });
    await waitFor(async () => await peer.peek('regional-tagged') === 'old');
    await destination.receiveCrossRegionInvalidation({ id: 'regional-generation', op: 'tag_incr', key: 'regional-tag', tagVersion: 3,
      namespace: NS, originRegion: 'region-a', originInstanceId: 'foreign', timestamp: Date.now() });
    expect(Number(await probe.get(`${NS}:tag_ver:regional-tag`))).toBeGreaterThanOrEqual(8);
    await waitFor(async () => await peer.peek('regional-tagged') === null);
  });

  it('detects a real trimmed-stream gap without relying on Redis to throw', async () => {
    const streamKey = `tricache:stream:{${NS}}`;
    await probe.xAdd(streamKey, '*', { op: 'del', key: `${NS}:bootstrap`, src: 'foreign' });
    const cache = makeSvc({ invalidationBackplane: true, backplaneMode: 'stream', backplaneStreamBlockMs: 50 });
    await cache.ready();
    await cache.set('trimmed', 'old', 60);
    const stream = (cache as unknown as { streamClient: any }).streamClient;
    const xrange = stream.xrange.bind(stream);
    const paused = deferred();
    const release = deferred();
    stream.xrange = async (...args: unknown[]) => {
      paused.resolve();
      await release.promise;
      return xrange(...args);
    };
    try {
      await paused.promise;
      await probe.del(`${NS}:trimmed`);
      await probe.xAdd(streamKey, '*', { op: 'del', key: `${NS}:trimmed`, src: 'foreign' });
      await probe.xAdd(streamKey, '*', { op: 'del', key: `${NS}:later`, src: 'foreign' });
      await probe.sendCommand(['XTRIM', streamKey, 'MAXLEN', '=', '1']);
      release.resolve();
      await waitFor(() => (cache.metrics().backplane.streamGaps ?? 0) > 0);
      expect(cache.getIfFresh('trimmed')).toBeNull();
      expect(await cache.peek('trimmed')).toBeNull();
      expect((cache as unknown as { _lastStreamId: string })._lastStreamId).not.toBe('$');
    } finally { release.resolve(); stream.xrange = xrange; }
  });

  it('replays a saved stream cursor before exposing restored snapshot entries', async () => {
    const tempRoot = process.platform === 'win32' && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
    const dir = fs.mkdtempSync(path.join(tempRoot, 'tricache-live-snapshot-'));
    const snapshotPath = path.join(dir, 'snapshot');
    const streamKey = `tricache:stream:{${NS}}`;
    try {
      await probe.xAdd(streamKey, '*', { op: 'del', key: `${NS}:bootstrap-snapshot`, src: 'foreign' });
      const writer = makeSvc({ invalidationBackplane: true, backplaneMode: 'stream', backplaneStreamBlockMs: 50 });
      await writer.ready();
      await writer.set('snapshot-item', 'old', 60);
      writer.writeSnapshot(snapshotPath);
      await writer.destroy();
      await probe.del(`${NS}:snapshot-item`);
      await probe.xAdd(streamKey, '*', { op: 'del', key: `${NS}:snapshot-item`, src: 'foreign' });
      const restored = makeSvc({ disableDisk: false, diskCacheDir: path.join(dir, 'spill'), snapshotPath,
        invalidationBackplane: true, backplaneMode: 'stream', backplaneStreamBlockMs: 50 });
      await restored.ready();
      expect(await restored.peek('snapshot-item')).toBeNull();
      expect(restored.metrics().backplane.streamEntriesReceived).toBeGreaterThan(0);
      await restored.destroy();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves remaining TTL across single, batch, and SCAN warm promotions', async () => {
    const single = makeSvc();
    const batch = makeSvc();
    const warm = makeSvc();
    await Promise.all([single.ping(), batch.ping(), warm.ping()]);
    for (const key of ['ttl-single', 'ttl-batch', 'ttl-warm']) await probe.set(`${NS}:${key}`, JSON.stringify('old'), { PX: 500 });
    expect(await single.get('ttl-single', async () => 'unexpected', 300)).toBe('old');
    expect(await batch.mget(['ttl-batch'])).toEqual(['old']);
    expect(await warm.warmFromL2('ttl-warm')).toBe(1);
    await waitFor(async () => await probe.exists(`${NS}:ttl-warm`) === 0);
    expect(single.getIfFresh('ttl-single')).toBeNull();
    expect(batch.getIfFresh('ttl-batch')).toBeNull();
    expect(warm.getIfFresh('ttl-warm')).toBeNull();
  });

  it('touches a generational hash without leaving its encoded expiry behind', async () => {
    const writer = makeSvc({ tagStrategy: 'generational' });
    const peer = makeSvc({ tagStrategy: 'generational' });
    await writer.set('hash-touch', 'value', 1, undefined, { tags: ['touch'] });
    const oldExpiry = Number(await probe.hGet(`${NS}:hash-touch`, 'e'));
    expect(await writer.touch('hash-touch', 5)).toBe(true);
    expect(Number(await probe.hGet(`${NS}:hash-touch`, 'e'))).toBeGreaterThan(oldExpiry);
    await waitFor(() => Date.now() > oldExpiry);
    expect(await peer.peek('hash-touch')).toBe('value');
  });

  it('honors a sub-second NestJS TTL in Redis and on a cold read', async () => {
    const cache = makeSvc();
    await cache.ping();
    const store = new TriCacheStore(cache);
    await store.set('short-nest', 'value', 100);
    expect(await store.get('short-nest')).toBe('value');
    await waitFor(async () => await probe.exists(`${NS}:short-nest`) === 0);
    expect(await makeSvc().peek('short-nest')).toBeNull();
  });

  it('uses real node-redis scanning, mixed-type batch Lua, and subscription callbacks', async () => {
    const client = createClient({ url: REDIS_URL, socket: { connectTimeout: 1500, reconnectStrategy: false } });
    client.on('error', () => {});
    await client.connect();
    try {
      const adapter = new NodeRedisAdapter(client);
      const cache = makeSvc({ redisClient: adapter, invalidationBackplane: true, awaitInvalidationBackplane: true, tagStrategy: 'generational' });
      const peer = makeSvc({ invalidationBackplane: true, awaitInvalidationBackplane: true });
      await Promise.all([cache.ready(), peer.ready()]);
      await probe.set(`${NS}:node-scan:string`, JSON.stringify('legacy'), { PX: 60000 });
      await probe.hSet(`${NS}:node-scan:hash`, { d: JSON.stringify('hash'), t: String(Date.now()), tv: '{}', e: String(Date.now() + 60000) });
      expect(await cache.mget(['node-scan:string', 'node-scan:hash', 'node-scan:absent'])).toEqual(['legacy', 'hash', undefined]);
      expect(await cache.warmFromL2('node-scan:*')).toBe(2);
      const pipeline = adapter.pipeline();
      pipeline.get(`${NS}:node-scan:hash`).get(`${NS}:node-scan:string`);
      const replies = await pipeline.exec();
      expect(replies?.[0][0]).toBeInstanceOf(Error);
      expect(replies?.[1]).toEqual([null, JSON.stringify('legacy')]);
      await peer.delete('node-scan:string');
      await waitFor(() => cache.getIfFresh('node-scan:string') === null);
      await cache.destroy();
    } finally { client.destroy(); }
  });
});
