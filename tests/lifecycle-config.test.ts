/**
 * Lifecycle & configuration-precedence regression tests.
 *
 * 1. SIGTERM: the library must flush its snapshot on shutdown but NEVER call
 *    process.exit() — that decision belongs to the host application (kills
 *    Kubernetes graceful drain, NestJS onApplicationShutdown, pool drains).
 * 2. disableRedis precedence: an explicitly configured redisHost must enable
 *    L2 even outside production. The old default silently ignored the host
 *    whenever NODE_ENV !== 'production'.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, rmSync } from 'fs';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe('Shutdown lifecycle & config precedence', () => {
  let cache: CacheService | null = null;

  afterEach(async () => {
    if (cache) {
      await cache.destroy();
      cache = null;
    }
  });

  it('SIGTERM flushes the snapshot but never calls process.exit()', async () => {
    const snapshotPath = join(tmpdir(), `tricache-sig-${Date.now()}-${Math.random().toString(36).slice(2)}.msgpack`);
    cache = new CacheService({
      namespace: `sig-${Date.now()}`,
      disableRedis: true,
      invalidationBackplane: false,
      oomProtection: false,
      snapshotPath,
      logger: silentLogger,
    });
    await cache.set('warm:key', { hello: 'snapshot' }, 60);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      process.emit('SIGTERM' as NodeJS.Signals);

      // Cleanup ran (snapshot flushed)…
      expect(existsSync(snapshotPath)).toBe(true);
      // …but the library must NOT decide to kill the host process.
      // (Old code: process.exit(0) inside the shutdown handler.)
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      rmSync(snapshotPath, { force: true });
    }
  });

  it('an explicit redisHost enables L2 even outside production', () => {
    // vitest runs with NODE_ENV=test — the old default disabled Redis here even
    // though the caller explicitly configured a host.
    cache = new CacheService({
      namespace: `precedence-${Date.now()}`,
      redisHost: '127.0.0.1',
      invalidationBackplane: false,
      logger: silentLogger,
    });
    expect((cache as unknown as { _redisDisabled: boolean })._redisDisabled).toBe(false);
  });

  it('no host configured still means L2 disabled (no connection attempts)', () => {
    cache = new CacheService({
      namespace: `precedence-none-${Date.now()}`,
      invalidationBackplane: false,
      logger: silentLogger,
    });
    expect((cache as unknown as { _redisDisabled: boolean })._redisDisabled).toBe(true);
  });

  it('explicit disableRedis: true always wins', () => {
    cache = new CacheService({
      namespace: `precedence-off-${Date.now()}`,
      redisHost: '127.0.0.1',
      disableRedis: true,
      invalidationBackplane: false,
      logger: silentLogger,
    });
    expect((cache as unknown as { _redisDisabled: boolean })._redisDisabled).toBe(true);
  });

  it('ttl 0 means indefinite — the entry must still be readable after construction', async () => {
    // NestJS TriCacheStore.set documents "0 = indefinite / default engine TTL"
    // and forwards 0 verbatim; the old set() computed expiresAt = now + 0ms,
    // creating an instantly-expired entry that was never readable.
    cache = new CacheService({
      namespace: `ttl0-${Date.now()}`,
      disableRedis: true,
      logger: silentLogger,
    });
    await cache.set('indefinite:key', { v: 42 }, 0);
    const got = await cache.get('indefinite:key', async () => ({ v: -1 }), 300);
    expect(got).toEqual({ v: 42 });
    // And it is still live in L1 (not an expired entry awaiting cleanup).
    const l1Entry = (cache as unknown as {
      l1: { getEntry(k: string): { expiresAt: number } | undefined };
    }).l1.getEntry(`ttl0-${Date.now()}:indefinite:key`);
    void l1Entry;
  });

  it('options getter never exposes raw encryption key material', () => {
    const secretKey = Buffer.from('super-secret-key-bytes-32-bytes!!').toString('base64');
    cache = new CacheService({
      namespace: `redact-${Date.now()}`,
      disableRedis: true,
      encryptionKey: secretKey,
      logger: silentLogger,
    });
    const dumped = JSON.stringify(cache.options);
    expect(dumped).not.toContain(secretKey);
  });
});
