import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CacheService } from '../src/cache-service.js';

describe('Prometheus /metrics Scraping Recipe (docs/metrics-recipe.md)', () => {
  let cache: CacheService;
  const namespace = `prom_recipe_${Date.now()}`;

  beforeEach(() => {
    cache = CacheService.create({
      namespace,
      disableRedis: true,
      disableDisk: true,
      invalidationBackplane: false,
    });
  });

  afterEach(async () => {
    await cache.destroy();
  });

  it('generates valid Prometheus text conforming to the metrics recipe specification', async () => {
    // Record sample activity
    await cache.set('item:1', { name: 'widget' }, 60);
    await cache.get('item:1', () => Promise.resolve(null), 60); // L1 hit
    await cache.get('item:missing', () => Promise.resolve({ name: 'fresh' }), 60); // fetch

    const promText = CacheService.toPrometheusText(cache.metrics(), 'tricache', 'srv-node-1');

    // Must be formatted with Prometheus HELP and TYPE headers
    expect(promText).toContain('# HELP tricache_gets_total');
    expect(promText).toContain('# TYPE tricache_gets_total counter');
    expect(promText).toContain('# HELP tricache_l1_hit_rate');
    expect(promText).toContain('# TYPE tricache_l1_hit_rate gauge');

    // Must carry namespace and instance labels
    expect(promText).toContain(`namespace="${namespace}"`);
    expect(promText).toContain('instance="srv-node-1"');
  });

  it('implements the Express /metrics handler recipe cleanly with proper headers', async () => {
    // Simulate the Express endpoint recipe from docs/metrics-recipe.md §2.1
    let statusCode = 0;
    const responseHeaders: Record<string, string> = {};
    let responseBody = '';

    const mockRes = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      set(key: string, value: string) {
        responseHeaders[key.toLowerCase()] = value;
        return this;
      },
      send(body: string) {
        responseBody = body;
        return this;
      },
    };

    // Recipe handler implementation
    const handler = (_req: unknown, res: typeof mockRes) => {
      res
        .status(200)
        .set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
        .send(CacheService.toPrometheusText(cache.metrics(), 'tricache', 'express-host'));
    };

    handler({}, mockRes);

    expect(statusCode).toBe(200);
    expect(responseHeaders['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(responseBody).toContain('tricache_gets_total');
    expect(responseBody).toContain('instance="express-host"');
  });

  it('implements the Next.js App Router GET recipe cleanly returning Response', async () => {
    // Simulate Next.js App Router recipe from docs/metrics-recipe.md §2.3
    const nextRouteHandler = async () => {
      const body = CacheService.toPrometheusText(cache.metrics(), 'tricache', 'next-worker');
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
      });
    };

    const response = await nextRouteHandler();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    const text = await response.text();
    expect(text).toContain('tricache_l1_entries');
    expect(text).toContain('instance="next-worker"');
  });

  it('verifies Prometheus scrape config and loopback-only docker compose artifacts', () => {
    const scrapePath = resolve(__dirname, '../dashboards/prometheus-scrape.yml');
    const composePath = resolve(__dirname, '../docker-compose.metrics.yml');

    expect(existsSync(scrapePath)).toBe(true);
    expect(existsSync(composePath)).toBe(true);

    const scrapeContent = readFileSync(scrapePath, 'utf8');
    expect(scrapeContent).toContain('job_name: tricache');
    expect(scrapeContent).toContain('metrics_path: /metrics');

    const composeContent = readFileSync(composePath, 'utf8');
    // Security verification: verify loopback binding
    expect(composeContent).toContain('127.0.0.1:9090:9090');
    expect(composeContent).toContain('127.0.0.1:3001:3000');
    expect(composeContent).toContain('dashboards/tricache-grafana.json');
  });
});
