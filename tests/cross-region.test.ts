import { describe, it, expect, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import {
  createMemoryCrossRegionRelay,
  createHttpMeshRelay,
  createCustomCrossRegionRelay,
  createCrossRegionWebhookHandler,
  type CrossRegionInvalidationEvent,
} from '../src/cross-region.js';
import http from 'http';
import type { AddressInfo } from 'net';

describe('Multi-Cluster / Cross-Region Invalidation Relay (Gap 4)', () => {
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

  it('synchronizes exact key deletions across separate regions via memory mesh', async () => {
    const memoryRelay = createMemoryCrossRegionRelay();

    // Region 1: US East
    const cacheUS = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      crossRegion: {
        currentRegion: 'us-east-1',
        relay: memoryRelay,
      },
    }));

    // Region 2: EU Central
    const cacheEU = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      crossRegion: {
        currentRegion: 'eu-central-1',
        relay: memoryRelay,
      },
    }));

    // Wire relay listeners for both regions
    memoryRelay.register('us-east-1', event => cacheUS.receiveCrossRegionInvalidation(event));
    memoryRelay.register('eu-central-1', event => cacheEU.receiveCrossRegionInvalidation(event));

    // Warm both regional caches with the same key
    await cacheUS.set('product:101', { name: 'Super Laptop', price: 999 }, 3600);
    await cacheEU.set('product:101', { name: 'Super Laptop', price: 999 }, 3600);

    expect(await cacheUS.get('product:101', async () => null)).toEqual({ name: 'Super Laptop', price: 999 });
    expect(await cacheEU.get('product:101', async () => null)).toEqual({ name: 'Super Laptop', price: 999 });

    // An update occurs in US East, invalidating the key
    await cacheUS.delete('product:101');

    // US cache is evicted locally
    let usFetched = false;
    await cacheUS.get('product:101', async () => {
      usFetched = true;
      return null;
    });
    expect(usFetched).toBe(true);

    // EU cache must have received the cross-region invalidation and also evicted the key
    let euFetched = false;
    await cacheEU.get('product:101', async () => {
      euFetched = true;
      return { name: 'Super Laptop V2', price: 1099 };
    });
    expect(euFetched).toBe(true);

    // Metrics check
    const mUS = cacheUS.metrics();
    expect(mUS.crossRegion?.enabled).toBe(true);
    expect(mUS.crossRegion?.currentRegion).toBe('us-east-1');
    expect(mUS.crossRegion?.sent).toBe(1);

    const mEU = cacheEU.metrics();
    expect(mEU.crossRegion?.enabled).toBe(true);
    expect(mEU.crossRegion?.currentRegion).toBe('eu-central-1');
    expect(mEU.crossRegion?.received).toBe(1);
    expect(mEU.crossRegion?.deduplicated).toBe(0);
  });

  it('synchronizes generational tag invalidations across regions', async () => {
    const memoryRelay = createMemoryCrossRegionRelay();

    const cacheUS = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      tagStrategy: 'generational',
      crossRegion: {
        currentRegion: 'us-east-1',
        relay: memoryRelay,
      },
    }));

    const cacheEU = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      tagStrategy: 'generational',
      crossRegion: {
        currentRegion: 'eu-central-1',
        relay: memoryRelay,
      },
    }));

    memoryRelay.register('us-east-1', event => cacheUS.receiveCrossRegionInvalidation(event));
    memoryRelay.register('eu-central-1', event => cacheEU.receiveCrossRegionInvalidation(event));

    // Cache tagged items in EU
    await cacheEU.get('article:1', async () => 'Article Content', 3600, { tags: ['category:news'] });
    expect(await cacheEU.get('article:1', async () => 'stale')).toBe('Article Content');

    // Admin in US invalidates the tag
    await cacheUS.invalidateTag('category:news');

    // EU cache should detect the bumped tag version and re-fetch
    let recomputed = false;
    const fresh = await cacheEU.get('article:1', async () => {
      recomputed = true;
      return 'Fresh News Content';
    }, 3600, { tags: ['category:news'] });

    expect(recomputed).toBe(true);
    expect(fresh).toBe('Fresh News Content');
  });

  it('prevents invalidation loops by self-filtering origin region and deduplicating seen IDs', async () => {
    const memoryRelay = createMemoryCrossRegionRelay();

    const cacheUS = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      crossRegion: {
        currentRegion: 'us-east-1',
        relay: memoryRelay,
      },
    }));

    // 1. Sending an event where originRegion === currentRegion must be skipped as echo
    const echoEvent: CrossRegionInvalidationEvent = {
      id: 'echo-uuid-1',
      originRegion: 'us-east-1',
      originInstanceId: 'peer-us-pod-2',
      op: 'del',
      key: 'item:1',
      timestamp: Date.now(),
    };

    const acceptedEcho = await cacheUS.receiveCrossRegionInvalidation(echoEvent);
    expect(acceptedEcho).toBe(false);
    expect(cacheUS.metrics().crossRegion?.deduplicated).toBe(1);

    // 2. Sending a foreign event the first time is accepted
    const foreignEvent: CrossRegionInvalidationEvent = {
      id: 'foreign-uuid-2',
      originRegion: 'ap-southeast-1',
      originInstanceId: 'asia-pod-1',
      op: 'del',
      key: 'item:2',
      timestamp: Date.now(),
    };

    const acceptedFirst = await cacheUS.receiveCrossRegionInvalidation(foreignEvent);
    expect(acceptedFirst).toBe(true);
    expect(cacheUS.metrics().crossRegion?.received).toBe(1);

    // 3. Sending the SAME event ID again (e.g. duplicate retry) is deduplicated
    const acceptedDuplicate = await cacheUS.receiveCrossRegionInvalidation(foreignEvent);
    expect(acceptedDuplicate).toBe(false);
    expect(cacheUS.metrics().crossRegion?.deduplicated).toBe(2);
    expect(cacheUS.metrics().crossRegion?.received).toBe(1);
  });

  it('respects namespace boundaries and rejects mismatched namespaces', async () => {
    const memoryRelay = createMemoryCrossRegionRelay();

    const cacheTenantA = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      namespace: 'tenant_a',
      crossRegion: {
        currentRegion: 'us-east-1',
        relay: memoryRelay,
      },
    }));

    await cacheTenantA.set('key', 'Tenant A Secret', 3600);

    // Event targeting tenant_b
    const eventB: CrossRegionInvalidationEvent = {
      id: 'uuid-b-1',
      originRegion: 'eu-central-1',
      originInstanceId: 'eu-pod-1',
      op: 'del',
      key: 'tenant_b:key',
      namespace: 'tenant_b',
      timestamp: Date.now(),
    };

    const applied = await cacheTenantA.receiveCrossRegionInvalidation(eventB);
    expect(applied).toBe(false);

    // Tenant A key remains intact
    expect(await cacheTenantA.get('key', async () => 'miss')).toBe('Tenant A Secret');
  });

  it('supports createHttpMeshRelay and createCrossRegionWebhookHandler with authentication', async () => {
    // Setup destination cache in EU
    const cacheEU = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      crossRegion: {
        currentRegion: 'eu-central-1',
        relay: { broadcast: async () => {} },
      },
    }));

    await cacheEU.set('user:500', { username: 'jdoe' }, 3600);

    const webhookHandler = createCrossRegionWebhookHandler(cacheEU, {
      authSecret: 'mesh-bearer-secret-777',
    });

    // Create an HTTP server running the webhook handler
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', async () => {
        const bodyStr = Buffer.concat(chunks).toString('utf8');
        let body: unknown = null;
        try { body = JSON.parse(bodyStr); } catch {}

        const result = await webhookHandler({
          headers: req.headers,
          body,
        });

        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const webhookUrl = `http://127.0.0.1:${port}/cache/invalidation`;

    try {
      // Setup source cache in US with HttpMeshRelay pointing to EU server
      const httpRelay = createHttpMeshRelay({
        peerUrls: [webhookUrl],
        authSecret: 'mesh-bearer-secret-777',
      });

      const cacheUS = track(new CacheService({
        disableRedis: true,
        disableDisk: true,
        crossRegion: {
          currentRegion: 'us-east-1',
          relay: httpRelay,
        },
      }));

      // Invalidate on US cache -> should POST to EU webhook -> evicts on EU cache
      await cacheUS.delete('user:500');

      // Allow event loop ticks for HTTP dispatch
      for (let i = 0; i < 30; i++) {
        if ((cacheEU.metrics().crossRegion?.received ?? 0) >= 1) break;
        await new Promise(r => setTimeout(r, 25));
      }

      let euFetched = false;
      await cacheEU.get('user:500', async () => {
        euFetched = true;
        return null;
      });
      expect(euFetched).toBe(true);
      expect(cacheEU.metrics().crossRegion?.received).toBe(1);

      // Verify webhook security: bad secret returns 401
      const unauthorizedResp = await webhookHandler({
        headers: { authorization: 'Bearer wrong-secret' },
        body: { id: 'x', originRegion: 'us', op: 'del', key: 'k' },
      });
      expect(unauthorizedResp.status).toBe(401);
      expect(unauthorizedResp.body.ok).toBe(false);

      // Verify webhook bad request returns 400
      const badReqResp = await webhookHandler({
        headers: { authorization: 'Bearer mesh-bearer-secret-777' },
        body: 'non-json-string-garbage',
      });
      expect(badReqResp.status).toBe(400);
      expect(badReqResp.body.ok).toBe(false);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('exports cross-region counters to Prometheus format', async () => {
    const memoryRelay = createMemoryCrossRegionRelay();
    const cache = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      crossRegion: {
        currentRegion: 'us-east-1',
        relay: memoryRelay,
      },
    }));

    await cache.delete('some:key');

    const prom = CacheService.toPrometheusText(cache.metrics());
    expect(prom).toContain('tricache_cross_region_sent_total');
    expect(prom).toContain('tricache_cross_region_received_total');
    expect(prom).toContain('tricache_cross_region_deduplicated_total');
    expect(prom).toContain('tricache_cross_region_errors_total');
  });

  it('supports broadcastOnSet when explicitly enabled', async () => {
    const memoryRelay = createMemoryCrossRegionRelay();

    const cacheUS = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      crossRegion: {
        currentRegion: 'us-east-1',
        relay: memoryRelay,
        broadcastOnSet: true, // explicitly enabled
      },
    }));

    const cacheEU = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      crossRegion: {
        currentRegion: 'eu-central-1',
        relay: memoryRelay,
      },
    }));

    memoryRelay.register('us-east-1', event => cacheUS.receiveCrossRegionInvalidation(event));
    memoryRelay.register('eu-central-1', event => cacheEU.receiveCrossRegionInvalidation(event));

    await cacheEU.set('config:rate_limit', 100, 3600);

    // US updates the config with broadcastOnSet: true
    await cacheUS.set('config:rate_limit', 200, 3600);

    // EU cache should have received the invalidation
    expect(cacheEU.metrics().crossRegion?.received).toBe(1);
  });

  it('synchronizes glob pattern deletions across regions', async () => {
    const memoryRelay = createMemoryCrossRegionRelay();

    const cacheUS = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      crossRegion: {
        currentRegion: 'us-east-1',
        relay: memoryRelay,
      },
    }));

    const cacheEU = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      crossRegion: {
        currentRegion: 'eu-central-1',
        relay: memoryRelay,
      },
    }));

    memoryRelay.register('us-east-1', event => cacheUS.receiveCrossRegionInvalidation(event));
    memoryRelay.register('eu-central-1', event => cacheEU.receiveCrossRegionInvalidation(event));

    await cacheEU.set('users:1:profile', 'alice', 3600);
    await cacheEU.set('users:2:profile', 'bob', 3600);
    await cacheEU.set('orders:99', 'order_data', 3600);

    // US deletes pattern 'users:*'
    await cacheUS.delete('users:*');

    // EU cache should have deleted matching keys while leaving orders:99 intact
    let aliceMiss = false;
    await cacheEU.get('users:1:profile', async () => {
      aliceMiss = true;
      return 'alice_recomputed';
    });
    expect(aliceMiss).toBe(true);

    let orderMiss = false;
    const order = await cacheEU.get('orders:99', async () => {
      orderMiss = true;
      return null;
    });
    expect(orderMiss).toBe(false);
    expect(order).toBe('order_data');
  });

  it('fans out invalidations across a 3-region global mesh without loops', async () => {
    const memoryRelay = createMemoryCrossRegionRelay();

    const cacheUS = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      crossRegion: { currentRegion: 'us-east-1', relay: memoryRelay },
    }));

    const cacheEU = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      crossRegion: { currentRegion: 'eu-central-1', relay: memoryRelay },
    }));

    const cacheAP = track(new CacheService({
      disableRedis: true,
      disableDisk: true,
      crossRegion: { currentRegion: 'ap-southeast-1', relay: memoryRelay },
    }));

    memoryRelay.register('us-east-1', event => cacheUS.receiveCrossRegionInvalidation(event));
    memoryRelay.register('eu-central-1', event => cacheEU.receiveCrossRegionInvalidation(event));
    memoryRelay.register('ap-southeast-1', event => cacheAP.receiveCrossRegionInvalidation(event));

    await cacheUS.set('global:banner', 'Welcome', 3600);
    await cacheEU.set('global:banner', 'Welcome', 3600);
    await cacheAP.set('global:banner', 'Welcome', 3600);

    // Invalidation initiated in Asia-Pacific
    await cacheAP.delete('global:banner');

    // Both US and EU must have received the invalidation
    expect(cacheUS.metrics().crossRegion?.received).toBe(1);
    expect(cacheEU.metrics().crossRegion?.received).toBe(1);
    // AP should have sent 1, received 0
    expect(cacheAP.metrics().crossRegion?.sent).toBe(1);
    expect(cacheAP.metrics().crossRegion?.received).toBe(0);

    // Total broadcasts dispatched = 1
    expect(memoryRelay.getBroadcastCount()).toBe(1);
  });

  it('supports createCustomCrossRegionRelay helper', () => {
    const custom = createCustomCrossRegionRelay({
      broadcast: async () => {},
    });
    expect(typeof custom.broadcast).toBe('function');
  });
});
