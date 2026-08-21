import { describe, it, expect } from 'vitest';
import { CacheService } from '../src/cache-service';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

function makeSvc(options: Record<string, unknown> = {}) {
  const diskDir = mkdtempSync(path.join(os.tmpdir(), 'tricache-protocol-test-'));
  const svc = new CacheService({
    diskCacheDir: diskDir,
    disableRedis: true,
    ...options,
  });
  return { svc, diskDir };
}

describe('Redis protocol option (RESP2 / RESP3)', () => {
  describe('Options storage', () => {
    it('stores redisProtocol: 2 in options', () => {
      const { svc, diskDir } = makeSvc({ redisProtocol: 2 });
      try {
        const opts = (svc as unknown as { opts: { redisProtocol?: number } }).opts;
        expect(opts.redisProtocol).toBe(2);
      } finally {
        svc.destroy();
        try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
      }
    });

    it('stores redisProtocol: 3 in options', () => {
      const { svc, diskDir } = makeSvc({ redisProtocol: 3 });
      try {
        const opts = (svc as unknown as { opts: { redisProtocol?: number } }).opts;
        expect(opts.redisProtocol).toBe(3);
      } finally {
        svc.destroy();
        try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
      }
    });

    it('defaults redisProtocol to undefined (ioredis v6 defaults to RESP3)', () => {
      const { svc, diskDir } = makeSvc({});
      try {
        const opts = (svc as unknown as { opts: { redisProtocol?: number } }).opts;
        expect(opts.redisProtocol).toBeUndefined();
      } finally {
        svc.destroy();
        try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
      }
    });
  });

  describe('Real ioredis client protocol configuration inspection', () => {
    it('configures protocol: 2 on single-node subscriber client', () => {
      const { svc, diskDir } = makeSvc({
        redisHost: '127.0.0.1',
        redisPort: 6379,
        disableRedis: false,
        invalidationBackplane: true,
        redisProtocol: 2,
      });

      try {
        const subClient = (svc as unknown as { subClient: { options?: { protocol?: number } } | null }).subClient;
        expect(subClient).not.toBeNull();
        expect(subClient?.options?.protocol).toBe(2);
      } finally {
        svc.destroy();
        try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
      }
    });

    it('configures protocol: 2 on Sentinel subscriber client', () => {
      const { svc, diskDir } = makeSvc({
        redisSentinel: {
          name: 'mymaster',
          sentinels: [{ host: '127.0.0.1', port: 26379 }],
        },
        disableRedis: false,
        invalidationBackplane: true,
        redisProtocol: 2,
      });

      try {
        const subClient = (svc as unknown as { subClient: { options?: { protocol?: number; name?: string } } | null }).subClient;
        expect(subClient).not.toBeNull();
        expect(subClient?.options?.name).toBe('mymaster');
        expect(subClient?.options?.protocol).toBe(2);
      } finally {
        svc.destroy();
        try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
      }
    });

    it('configures protocol: 2 inside redisOptions on Cluster subscriber client', () => {
      const { svc, diskDir } = makeSvc({
        redisClusterNodes: [{ host: '127.0.0.1', port: 6379 }],
        disableRedis: false,
        invalidationBackplane: true,
        redisProtocol: 2,
      });

      try {
        const subClient = (svc as unknown as {
          subClient: { options?: { redisOptions?: { protocol?: number } } } | null;
        }).subClient;
        expect(subClient).not.toBeNull();
        expect(subClient?.options?.redisOptions?.protocol).toBe(2);
      } finally {
        svc.destroy();
        try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
      }
    });

    it('configures protocol: 3 when explicitly specified', () => {
      const { svc, diskDir } = makeSvc({
        redisHost: '127.0.0.1',
        redisPort: 6379,
        disableRedis: false,
        invalidationBackplane: true,
        redisProtocol: 3,
      });

      try {
        const subClient = (svc as unknown as { subClient: { options?: { protocol?: number } } | null }).subClient;
        expect(subClient).not.toBeNull();
        expect(subClient?.options?.protocol).toBe(3);
      } finally {
        svc.destroy();
        try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
      }
    });
  });
});
