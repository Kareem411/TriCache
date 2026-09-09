import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SigV4SnapshotAdapter,
  createSigV4SnapshotAdapter,
  createS3SnapshotAdapter,
  createR2SnapshotAdapter,
} from '../src/sigv4-snapshot-adapter.js';
import { CacheService } from '../src/cache-service.js';

describe('Zero-Dependency AWS SigV4 Snapshot Adapter', () => {
  const credentials = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };

  it('throws descriptive error when AWS credentials are missing', () => {
    const oldKey = process.env.AWS_ACCESS_KEY_ID;
    const oldSecret = process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;

    try {
      expect(() => {
        createSigV4SnapshotAdapter({
          bucket: 'my-bucket',
          key: 'snapshots/prod.snap',
        });
      }).toThrow(/AWS credentials missing/);
    } finally {
      if (oldKey) process.env.AWS_ACCESS_KEY_ID = oldKey;
      if (oldSecret) process.env.AWS_SECRET_ACCESS_KEY = oldSecret;
    }
  });

  it('correctly constructs virtual-hosted URLs for AWS S3', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init.headers as Record<string, string>;
      return Promise.resolve(new Response(Buffer.from('snapshot-bytes'), { status: 200 }));
    });

    const adapter = createS3SnapshotAdapter({
      bucket: 'prod-cache-backups',
      key: 'cluster-l1.snap',
      region: 'us-west-2',
      ...credentials,
      fetch: mockFetch as unknown as typeof globalThis.fetch,
    });

    const result = await adapter.get();
    expect(result).not.toBeNull();
    expect(result?.toString()).toBe('snapshot-bytes');

    expect(capturedUrl).toBe('https://prod-cache-backups.s3.us-west-2.amazonaws.com/cluster-l1.snap');
    expect(capturedHeaders['host']).toBe('prod-cache-backups.s3.us-west-2.amazonaws.com');
    expect(capturedHeaders['x-amz-content-sha256']).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(capturedHeaders['Authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-west-2\/s3\/aws4_request/);
    expect(capturedHeaders['Authorization']).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date');
    expect(capturedHeaders['Authorization']).toMatch(/Signature=[a-f0-9]{64}$/);
  });

  it('correctly supports Cloudflare R2 endpoints with auto region', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init.headers as Record<string, string>;
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    const adapter = createR2SnapshotAdapter({
      accountId: 'cf123456789abcdef',
      bucket: 'r2-cache-bucket',
      key: 'eu-west/node-l1.snap',
      ...credentials,
      fetch: mockFetch as unknown as typeof globalThis.fetch,
    });

    const result = await adapter.get();
    expect(result).toBeNull(); // 404 returns null cleanly on cold start

    expect(capturedUrl).toBe('https://cf123456789abcdef.r2.cloudflarestorage.com/r2-cache-bucket/eu-west/node-l1.snap');
    expect(capturedHeaders['host']).toBe('cf123456789abcdef.r2.cloudflarestorage.com');
    expect(capturedHeaders['Authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/auto\/s3\/aws4_request/);
  });

  it('signs PUT uploads with SHA-256 payload hash and binary body', async () => {
    let capturedBody: unknown = null;
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = init.body;
      capturedHeaders = init.headers as Record<string, string>;
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    const adapter = new SigV4SnapshotAdapter({
      bucket: 'my-bucket',
      key: 'test.snap',
      region: 'us-east-1',
      ...credentials,
      fetch: mockFetch as unknown as typeof globalThis.fetch,
    });

    const payload = Buffer.from('hello-world-encrypted-snapshot-data');
    await adapter.put(payload);

    expect(capturedBody).toBe(payload);
    expect(capturedHeaders['content-type']).toBe('application/octet-stream');
    expect(capturedHeaders['x-amz-content-sha256']).not.toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(capturedHeaders['Authorization']).toContain('Signature=');
  });

  it('throws descriptive error when S3 returns non-2xx status code', async () => {
    const mockFetch = vi.fn().mockImplementation(() => {
      return Promise.resolve(new Response('<Error><Code>AccessDenied</Code></Error>', {
        status: 403,
        statusText: 'Forbidden',
      }));
    });

    const adapter = createSigV4SnapshotAdapter({
      bucket: 'restricted-bucket',
      key: 'test.snap',
      ...credentials,
      fetch: mockFetch as unknown as typeof globalThis.fetch,
    });

    await expect(adapter.get()).rejects.toThrow(/SigV4SnapshotAdapter: GET \/test\.snap failed with status 403 Forbidden/);
    await expect(adapter.put(Buffer.from('data'))).rejects.toThrow(/SigV4SnapshotAdapter: PUT \/test\.snap failed with status 403 Forbidden/);
  });

  describe('Integration with CacheService', () => {
    let instances: CacheService[] = [];
    const track = (c: CacheService) => {
      instances.push(c);
      return c;
    };

    afterEach(async () => {
      for (const inst of instances) {
        await inst.destroy();
      }
      instances = [];
    });

    it('round-trips L1 snapshot export and hydration through SigV4 adapter', async () => {
      let storedRemoteBuffer: Buffer | null = null;

      const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        if (init.method === 'PUT') {
          storedRemoteBuffer = init.body as Buffer;
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        if (init.method === 'GET') {
          if (!storedRemoteBuffer) return Promise.resolve(new Response(null, { status: 404 }));
          return Promise.resolve(new Response(storedRemoteBuffer as unknown as BodyInit, { status: 200 }));
        }
        return Promise.reject(new Error('unhandled'));
      });

      const adapter = createSigV4SnapshotAdapter({
        bucket: 'fleet-l1-snapshots',
        key: 'prod-app.snap',
        region: 'us-east-1',
        ...credentials,
        fetch: mockFetch as unknown as typeof globalThis.fetch,
      });

      // Pod 1 writes L1 data and triggers snapshot
      const cache1 = track(new CacheService({
        disableRedis: true,
        disableDisk: true,
        remoteSnapshot: { adapter },
      }));

      await cache1.set('order:1001', { total: 49.99, status: 'paid' }, 3600);
      await cache1.set('settings:theme', 'dark', 3600);

      const saved = await cache1.writeRemoteSnapshot();
      expect(saved).toBe(true);
      expect(storedRemoteBuffer).not.toBeNull();

      // Pod 2 starts cold, hydrates from SigV4 S3 adapter
      const cache2 = track(new CacheService({
        disableRedis: true,
        disableDisk: true,
        remoteSnapshot: { adapter },
      }));

      await cache2.ready();

      const order = await cache2.get('order:1001', async () => null);
      expect(order).toEqual({ total: 49.99, status: 'paid' });

      const theme = await cache2.get('settings:theme', async () => null);
      expect(theme).toBe('dark');
    });
  });
});
