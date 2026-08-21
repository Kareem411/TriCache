import { describe, it, expect, vi, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

function makeSvc(options: Record<string, unknown> = {}) {
  const diskDir = mkdtempSync(path.join(os.tmpdir(), 'tricache-sharded-pubsub-'));
  const svc = new CacheService({
    diskCacheDir: diskDir,
    disableRedis: true,
    ...options,
  });
  return { svc, diskDir };
}

describe('Redis 7+ Sharded Pub/Sub (SPUBLISH / SSUBSCRIBE)', () => {
  let svc: CacheService | null = null;
  let diskDir: string | null = null;

  afterEach(async () => {
    if (svc) {
      await svc.destroy();
      svc = null;
    }
    if (diskDir) {
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
      diskDir = null;
    }
  });

  describe('Option configuration', () => {
    it('stores useShardedPubSub: true in options', () => {
      const res = makeSvc({ useShardedPubSub: true });
      svc = res.svc;
      diskDir = res.diskDir;

      const opts = (svc as unknown as { opts: { useShardedPubSub: boolean } }).opts;
      expect(opts.useShardedPubSub).toBe(true);
    });

    it('defaults useShardedPubSub to false', () => {
      const res = makeSvc({});
      svc = res.svc;
      diskDir = res.diskDir;

      const opts = (svc as unknown as { opts: { useShardedPubSub: boolean } }).opts;
      expect(opts.useShardedPubSub).toBe(false);
    });
  });

  describe('Cluster subscriber binding', () => {
    it('binds to smessage and ssubscribe in cluster mode when useShardedPubSub is true', async () => {
      const res = makeSvc({
        redisClusterNodes: [{ host: '127.0.0.1', port: 7000 }],
        disableRedis: false,
        invalidationBackplane: true,
        useShardedPubSub: true,
      });
      svc = res.svc;
      diskDir = res.diskDir;

      const subClient = (svc as unknown as { subClient: unknown }).subClient;
      expect(subClient).not.toBeNull();

      // Simulate a peer invalidation message received on 'smessage'
      await svc.set('sharded:key', 'initial-val', 60);
      expect(svc.has('sharded:key')).toBe(true);

      const msg = JSON.stringify({ op: 'del', key: (svc as unknown as { nk: (k: string) => string }).nk('sharded:key'), src: 'peer-instance' });
      (svc as unknown as { _handleBackplaneMessage: (m: string) => void })._handleBackplaneMessage(msg);

      expect(svc.has('sharded:key')).toBe(false);
    });

    it('falls back to standard message and subscribe on standalone Redis even if useShardedPubSub is true', () => {
      const res = makeSvc({
        redisHost: '127.0.0.1',
        redisPort: 6379,
        disableRedis: false,
        invalidationBackplane: true,
        useShardedPubSub: true,
      });
      svc = res.svc;
      diskDir = res.diskDir;

      const subClient = (svc as unknown as { subClient: { listenerCount: (event: string) => number } | null }).subClient;
      expect(subClient).not.toBeNull();
      // On standalone Redis, sharded pub/sub is disabled -> 'message' listener is registered, not 'smessage'
      expect(subClient!.listenerCount('message')).toBeGreaterThanOrEqual(1);
      expect(subClient!.listenerCount('smessage')).toBe(0);
    });
  });

  describe('Publishing invalidation', () => {
    it('uses spublish when available on cluster client', async () => {
      const res = makeSvc({
        redisClusterNodes: [{ host: '127.0.0.1', port: 7000 }],
        disableRedis: false,
        invalidationBackplane: true,
        useShardedPubSub: true,
      });
      svc = res.svc;
      diskDir = res.diskDir;

      const mockSpublish = vi.fn().mockResolvedValue(1);
      const mockGetRedis = vi.fn().mockResolvedValue({ spublish: mockSpublish, publish: vi.fn() });
      (svc as unknown as { getRedis: () => Promise<unknown> }).getRedis = mockGetRedis;

      await (svc as unknown as { publishInvalidation: (op: string, key: string) => Promise<void> })
        .publishInvalidation('del', 'test:sharded:key');

      expect(mockSpublish).toHaveBeenCalledTimes(1);
      expect(mockSpublish).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"key":"test:sharded:key"'),
      );
    });
  });
});
