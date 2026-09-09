import { describe, it, expect, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import {
  createMemorySnapshotAdapter,
  createHttpSnapshotAdapter,
  createCustomSnapshotAdapter,
} from '../src/remote-snapshot.js';
import http from 'http';
import type { AddressInfo } from 'net';

describe('Remote Blob Storage Cold-Start Hydration (Gap 3)', () => {
  let instances: CacheService[] = [];

  const track = (c: CacheService): CacheService => {
    instances.push(c);
    return c;
  };

  afterEach(async () => {
    for (const inst of instances) {
      await inst.destroy();
    }
    instances = [];
  });

  it('persists L1 memory to remote memory adapter and hydrates a new stateless instance', async () => {
    const memoryAdapter = createMemorySnapshotAdapter();

    // Instance 1: write items and upload remote snapshot
    const cache1 = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      remoteSnapshot: {
        adapter: memoryAdapter,
      },
    }));

    await cache1.set('user:42', { name: 'Ada Lovelace', role: 'Pioneer' }, 3600);
    await cache1.set('config:flags', ['beta_mode', 'perf_tracing'], 3600);
    await cache1.set('counter:bootstraps', 12345, 3600);

    const uploaded = await cache1.writeRemoteSnapshot();
    expect(uploaded).toBe(true);
    expect(memoryAdapter.getBuffer()).not.toBeNull();
    expect(memoryAdapter.getBuffer()!.length).toBeGreaterThan(0);

    const m1 = cache1.metrics();
    expect(m1.remoteSnapshot?.enabled).toBe(true);
    expect(m1.remoteSnapshot?.uploads).toBe(1);
    expect(m1.remoteSnapshot?.lastUploadedAt).toBeGreaterThan(0);

    // Instance 2: new stateless container starting cold
    const cache2 = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      remoteSnapshot: {
        adapter: memoryAdapter,
      },
    }));

    // Wait for hydration via cache.ready()
    await cache2.ready();

    const m2 = cache2.metrics();
    expect(m2.remoteSnapshot?.enabled).toBe(true);
    expect(m2.remoteSnapshot?.downloads).toBe(1);
    expect(m2.remoteSnapshot?.lastDownloadedAt).toBeGreaterThan(0);

    // Reads should be served directly from L1 (no fetch miss)
    let fetched = false;
    const user = await cache2.get('user:42', async () => {
      fetched = true;
      return null;
    });
    expect(fetched).toBe(false);
    expect(user).toEqual({ name: 'Ada Lovelace', role: 'Pioneer' });

    const flags = await cache2.get('config:flags', async () => {
      fetched = true;
      return null;
    });
    expect(fetched).toBe(false);
    expect(flags).toEqual(['beta_mode', 'perf_tracing']);

    const counter = await cache2.get('counter:bootstraps', async () => {
      fetched = true;
      return null;
    });
    expect(fetched).toBe(false);
    expect(counter).toBe(12345);
  });

  it('rejects stale remote snapshots beyond maxAgeMs', async () => {
    const memoryAdapter = createMemorySnapshotAdapter();

    const cache1 = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      remoteSnapshot: {
        adapter: memoryAdapter,
      },
    }));

    await cache1.set('app:version', '1.0.0', 3600);
    await cache1.writeRemoteSnapshot();

    // Instance 2 specifies a negative or 0-ms maxAge
    const cache2 = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      remoteSnapshot: {
        adapter: memoryAdapter,
        maxAgeMs: 0, // already expired
      },
    }));

    const imported = await cache2.loadRemoteSnapshot();
    expect(imported).toBe(0);

    let fetchCalled = false;
    const val = await cache2.get('app:version', async () => {
      fetchCalled = true;
      return 'fresh';
    });
    expect(fetchCalled).toBe(true);
    expect(val).toBe('fresh');
  });

  it('gracefully handles empty/missing remote storage (first deployment)', async () => {
    const memoryAdapter = createMemorySnapshotAdapter();

    const cache = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      remoteSnapshot: {
        adapter: memoryAdapter,
      },
    }));

    await cache.ready();

    expect(cache.metrics().remoteSnapshot?.downloads).toBe(0);
    expect(cache.metrics().remoteSnapshot?.errors).toBe(0);
  });

  it('gracefully handles corrupted data in remote storage without crashing', async () => {
    const memoryAdapter = createMemorySnapshotAdapter();
    await memoryAdapter.put(Buffer.from('corrupted-non-msgpack-garbage-data-XYZ'));

    const cache = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      remoteSnapshot: {
        adapter: memoryAdapter,
      },
    }));

    await cache.ready();

    const m = cache.metrics();
    expect(m.remoteSnapshot?.errors).toBeGreaterThan(0);

    // Cache operates normally despite remote corrupt payload
    await cache.set('live:key', 'working', 60);
    const read = await cache.get('live:key', async () => 'miss');
    expect(read).toBe('working');
  });

  it('works with AES-256-GCM encryption at rest for remote blob storage', async () => {
    const memoryAdapter = createMemorySnapshotAdapter();
    const encKey = Buffer.alloc(32, 0x5a).toString('base64');

    const cache1 = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      encryptionKey: encKey,
      encryptionMode: 'aes-256-gcm',
      remoteSnapshot: {
        adapter: memoryAdapter,
      },
    }));

    await cache1.set('secure:token', 'secret_token_value_abc', 3600);
    await cache1.writeRemoteSnapshot();

    const rawBlob = memoryAdapter.getBuffer()!;
    // Stored blob must NOT contain the plaintext secret string
    expect(rawBlob.toString('utf8')).not.toContain('secret_token_value_abc');

    // Instance 2 with matching key hydrates successfully
    const cache2 = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      encryptionKey: encKey,
      encryptionMode: 'aes-256-gcm',
      remoteSnapshot: {
        adapter: memoryAdapter,
      },
    }));

    await cache2.ready();
    const token = await cache2.get('secure:token', async () => 'miss');
    expect(token).toBe('secret_token_value_abc');

    // Instance 3 with WRONG key fails decryption gracefully and starts cold
    const wrongKey = Buffer.alloc(32, 0x99).toString('base64');
    const cache3 = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      encryptionKey: wrongKey,
      encryptionMode: 'aes-256-gcm',
      remoteSnapshot: {
        adapter: memoryAdapter,
      },
    }));

    await cache3.ready();
    expect(cache3.metrics().remoteSnapshot?.errors).toBeGreaterThan(0);
    const token3 = await cache3.get('secure:token', async () => 'fallback');
    expect(token3).toBe('fallback');
  });

  it('supports createHttpSnapshotAdapter with a real HTTP endpoint', async () => {
    let storedHttpData: Buffer | null = null;

    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/snapshot') {
        if (!storedHttpData) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(storedHttpData);
        return;
      }
      if (req.method === 'PUT' && req.url === '/snapshot') {
        const chunks: Buffer[] = [];
        req.on('data', chunk => chunks.push(Buffer.from(chunk)));
        req.on('end', () => {
          storedHttpData = Buffer.concat(chunks);
          res.writeHead(200);
          res.end('OK');
        });
        return;
      }
      res.writeHead(400);
      res.end();
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/snapshot`;

    try {
      const httpAdapter = createHttpSnapshotAdapter({
        getUrl: url,
        putUrl: url,
        headers: { 'X-Auth': 'test-secret' },
      });

      // Instance 1 uploads via HTTP PUT
      const cache1 = track(new CacheService({
        disableRedis: true,
        disableDisk: true,
        remoteSnapshot: {
          adapter: httpAdapter,
        },
      }));

      await cache1.set('profile:100', { handle: 'dev', org: 'tricache' }, 3600);
      const written = await cache1.writeRemoteSnapshot();
      expect(written).toBe(true);
      expect(storedHttpData).not.toBeNull();

      // Instance 2 downloads via HTTP GET
      const cache2 = track(new CacheService({
        disableRedis: true,
        disableDisk: true,
        remoteSnapshot: {
          adapter: httpAdapter,
        },
      }));

      await cache2.ready();
      let dbHit = false;
      const profile = await cache2.get('profile:100', async () => {
        dbHit = true;
        return null;
      });
      expect(dbHit).toBe(false);
      expect(profile).toEqual({ handle: 'dev', org: 'tricache' });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('exports metrics to Prometheus format', async () => {
    const memoryAdapter = createMemorySnapshotAdapter();
    const cache = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      remoteSnapshot: {
        adapter: memoryAdapter,
      },
    }));

    await cache.set('item:1', 'val', 60);
    await cache.writeRemoteSnapshot();
    await cache.loadRemoteSnapshot();

    const prom = CacheService.toPrometheusText(cache.metrics());
    expect(prom).toContain('tricache_remote_snapshot_uploads_total');
    expect(prom).toContain('tricache_remote_snapshot_downloads_total');
    expect(prom).toContain('tricache_remote_snapshot_errors_total');
  });

  it('supports periodic background snapshot upload via intervalMs', async () => {
    const memoryAdapter = createMemorySnapshotAdapter();
    const cache = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      remoteSnapshot: {
        adapter: memoryAdapter,
        intervalMs: 40,
      },
    }));

    await cache.set('periodic:key', 'auto-uploaded-value', 3600);
    expect(cache.metrics().remoteSnapshot?.uploads).toBe(0);

    // Wait for the background timer to fire
    await new Promise(r => setTimeout(r, 100));

    expect(cache.metrics().remoteSnapshot?.uploads).toBeGreaterThanOrEqual(1);
    expect(memoryAdapter.getBuffer()).not.toBeNull();
  });

  it('supports createCustomSnapshotAdapter helper', () => {
    const custom = createCustomSnapshotAdapter({
      get: async () => null,
      put: async () => {},
    });
    expect(typeof custom.get).toBe('function');
    expect(typeof custom.put).toBe('function');
  });
});
