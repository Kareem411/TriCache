import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { CacheService } from '../src/cache-service.js';
import {
  handleDashboardRequest,
  safeCompare,
  tricacheDashboard,
  createNextDashboardHandlers,
  startDashboardServer,
  DASHBOARD_HTML,
  DASHBOARD_GZIP_BUFFER,
  type DashboardActionEvent,
} from '../src/dashboard/index.js';

describe('Turnkey Visual Observability & Dashboard (Gap 1)', () => {
  let cache: CacheService;
  const createdCaches: CacheService[] = [];

  function makeCache(options = {}): CacheService {
    const c = CacheService.create({
      namespace: 'dash-test-' + Math.random().toString(36).slice(2, 8),
      disableRedis: true,
      disableDisk: true,
      ...options,
    });
    createdCaches.push(c);
    return c;
  }

  beforeEach(() => {
    cache = makeCache();
  });

  afterEach(async () => {
    for (const c of createdCaches) {
      await c.destroy();
    }
    createdCaches.length = 0;
  });

  // ── 1. Timing-Safe Comparison Unit Tests ─────────────────────────────────

  describe('Timing-Safe Comparison (safeCompare)', () => {
    it('returns true for identical strings', () => {
      expect(safeCompare('super-secret-123', 'super-secret-123')).toBe(true);
      expect(safeCompare('', '')).toBe(true);
    });

    it('returns false for different strings without throwing length mismatch errors', () => {
      // Buffer length differences must not throw RangeError
      expect(safeCompare('short', 'much-longer-string-with-different-length')).toBe(false);
      expect(safeCompare('a', 'b')).toBe(false);
      expect(safeCompare('password123', 'password124')).toBe(false);
    });

    it('handles non-string inputs safely', () => {
      // @ts-expect-error test non-string runtime resilience
      expect(safeCompare(null, 'test')).toBe(false);
      // @ts-expect-error test non-string runtime resilience
      expect(safeCompare(undefined, undefined)).toBe(false);
    });
  });

  // ── 2. Dashboard UI Serving & Gzip Optimization ──────────────────────────

  describe('Static UI Serving & Pre-Gzip Compression', () => {
    it('serves uncompressed HTML when Accept-Encoding does not include gzip', async () => {
      const req = new Request('http://localhost/cache/dashboard', {
        method: 'GET',
        headers: { 'Accept-Encoding': 'identity' },
      });

      const res = await handleDashboardRequest(req, {
        cache,
        basePath: '/cache/dashboard',
        title: 'Custom Title',
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/html');
      expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');

      const text = await res.text();
      expect(text).toContain('<!DOCTYPE html>');
      expect(text).toBe(DASHBOARD_HTML);
    });

    it('serves pre-compressed gzip buffer when client accepts gzip', async () => {
      const req = new Request('http://localhost/cache/dashboard/', {
        method: 'GET',
        headers: { 'Accept-Encoding': 'gzip, deflate, br' },
      });

      const res = await handleDashboardRequest(req, {
        cache,
        basePath: '/cache/dashboard',
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/html');
      expect(res.headers.get('Content-Encoding')).toBe('gzip');
      expect(res.headers.get('Content-Length')).toBe(String(DASHBOARD_GZIP_BUFFER.length));

      const arrayBuf = await res.arrayBuffer();
      const decompressed = gunzipSync(Buffer.from(arrayBuf)).toString('utf-8');
      expect(decompressed).toBe(DASHBOARD_HTML);
    });
  });

  // ── 3. Metrics API Snapshot ──────────────────────────────────────────────

  describe('GET /api/metrics Snapshot', () => {
    it('returns live metric payload and metadata with basePath stripping', async () => {
      await cache.set('user:1', { name: 'Alice' }, 3600);
      await cache.get('user:1', async () => null);

      const req = new Request('http://localhost/admin/cache/api/metrics', {
        method: 'GET',
      });

      const res = await handleDashboardRequest(req, {
        cache,
        basePath: '/admin/cache',
        title: 'Fleet Observability',
        instanceId: 'worker-pod-42',
        peerInstances: [{ name: 'Pod 2', url: 'http://pod-2:9090' }],
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/json');

      const data = await res.json() as Record<string, any>;
      expect(data.title).toBe('Fleet Observability');
      expect(data.instanceId).toBe('worker-pod-42');
      expect(data.readOnly).toBe(false);
      expect(data.peerInstances).toEqual([{ name: 'Pod 2', url: 'http://pod-2:9090' }]);
      expect(data.metrics.gets.total).toBe(1);
      expect(data.metrics.gets.l1Hits).toBe(1);
      expect(data.metrics.health.status).toBe('healthy');
    });
  });

  // ── 4. Server-Sent Events (SSE) Stream & Teardown ─────────────────────────

  describe('GET /api/stream Server-Sent Events', () => {
    it('opens text/event-stream, emits initial frame, and teardown cleanly on abort', async () => {
      const abortController = new AbortController();

      const req = new Request('http://localhost/api/stream', {
        method: 'GET',
        signal: abortController.signal,
      });

      const res = await handleDashboardRequest(req, {
        cache,
        streamIntervalMs: 50,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
      expect(res.headers.get('Cache-Control')).toContain('no-cache');

      const reader = res.body?.getReader();
      expect(reader).toBeDefined();

      const firstChunk = await reader!.read();
      expect(firstChunk.done).toBe(false);
      const decoded = new TextDecoder().decode(firstChunk.value);
      expect(decoded).toMatch(/^data: \{.*\}\n\n$/);

      // Trigger abort to verify teardown
      abortController.abort();
      await reader!.cancel().catch(() => {});
    });
  });

  // ── 5. Authentication Defense-in-Depth ───────────────────────────────────

  describe('Authentication Enforcement', () => {
    it('enforces Basic Auth with timing-safe comparison', async () => {
      const options = {
        cache,
        auth: { username: 'admin', password: 'secret-password-123' },
      };

      // 1. Missing credentials
      const reqMissing = new Request('http://localhost/api/metrics');
      const resMissing = await handleDashboardRequest(reqMissing, options);
      expect(resMissing.status).toBe(401);
      expect(resMissing.headers.get('WWW-Authenticate')).toContain('Basic');

      // 2. Wrong credentials
      const badCreds = Buffer.from('admin:wrong-password').toString('base64');
      const reqBad = new Request('http://localhost/api/metrics', {
        headers: { Authorization: `Basic ${badCreds}` },
      });
      const resBad = await handleDashboardRequest(reqBad, options);
      expect(resBad.status).toBe(401);

      // 3. Valid credentials
      const goodCreds = Buffer.from('admin:secret-password-123').toString('base64');
      const reqGood = new Request('http://localhost/api/metrics', {
        headers: { Authorization: `Basic ${goodCreds}` },
      });
      const resGood = await handleDashboardRequest(reqGood, options);
      expect(resGood.status).toBe(200);
    });

    it('enforces Bearer Token and URL query token authentication', async () => {
      const options = {
        cache,
        authSecret: 'bearer-secret-token-xyz',
      };

      // 1. Missing token
      const resMissing = await handleDashboardRequest(new Request('http://localhost/api/metrics'), options);
      expect(resMissing.status).toBe(401);

      // 2. Bearer Header
      const resBearer = await handleDashboardRequest(
        new Request('http://localhost/api/metrics', {
          headers: { Authorization: 'Bearer bearer-secret-token-xyz' },
        }),
        options
      );
      expect(resBearer.status).toBe(200);

      // 3. Query param ?token=...
      const resQuery = await handleDashboardRequest(
        new Request('http://localhost/api/metrics?token=bearer-secret-token-xyz'),
        options
      );
      expect(resQuery.status).toBe(200);
    });
  });

  // ── 6. Mutating Actions, CSRF & Read-Only Protection ──────────────────────

  describe('Mutating Actions, CSRF & Read-Only Guardrails', () => {
    it('blocks mutating actions without mandatory X-TriCache-Action header', async () => {
      const req = new Request('http://localhost/api/actions/invalidate-tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: 'products' }),
      });

      const res = await handleDashboardRequest(req, { cache });
      expect(res.status).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('CSRF');
    });

    it('blocks mutating actions with mismatched origin', async () => {
      const req = new Request('http://localhost/api/actions/invalidate-tag', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-TriCache-Action': '1',
          Host: 'internal.company.net',
          Origin: 'https://malicious-site.com',
        },
        body: JSON.stringify({ tag: 'products' }),
      });

      const res = await handleDashboardRequest(req, { cache });
      expect(res.status).toBe(403);
    });

    it('enforces readOnly: true and rejects mutating actions with 403 Forbidden', async () => {
      const req = new Request('http://localhost/api/actions/clear', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-TriCache-Action': '1',
        },
      });

      const res = await handleDashboardRequest(req, {
        cache,
        readOnly: true,
      });

      expect(res.status).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('read-only');
    });

    it('successfully invalidates tag and dispatches audit logging hook', async () => {
      let auditEvent: DashboardActionEvent | null = null;
      const tagCache = makeCache({ tagStrategy: 'generational' });

      await tagCache.get('item:1', async () => 'val1', 3600, { tags: ['catalog'] });
      expect(await tagCache.get('item:1', async () => 'stale')).toBe('val1');

      const req = new Request('http://localhost/api/actions/invalidate-tag', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-TriCache-Action': '1',
          'X-Forwarded-For': '10.0.1.45',
          Authorization: 'Bearer my-token',
        },
        body: JSON.stringify({ tag: 'catalog' }),
      });

      const res = await handleDashboardRequest(req, {
        cache: tagCache,
        authSecret: 'my-token',
        onAction: evt => { auditEvent = evt; },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; tag: string };
      expect(body.ok).toBe(true);
      expect(body.tag).toBe('catalog');

      // Entry tagged with 'catalog' must be invalidated and re-fetched
      let recomputed = false;
      const fresh = await tagCache.get('item:1', async () => {
        recomputed = true;
        return 'fresh';
      }, 3600, { tags: ['catalog'] });
      expect(recomputed).toBe(true);
      expect(fresh).toBe('fresh');

      // Verify audit event
      expect(auditEvent).not.toBeNull();
      expect(auditEvent!.action).toBe('invalidate-tag');
      expect(auditEvent!.target).toBe('catalog');
      expect(auditEvent!.success).toBe(true);
      expect(auditEvent!.ip).toBe('10.0.1.45');
    });

    it('successfully clears cache via POST /api/actions/clear', async () => {
      await cache.set('k1', 'v1', 3600);
      await cache.set('k2', 'v2', 3600);

      const req = new Request('http://localhost/api/actions/clear', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-TriCache-Action': '1',
        },
      });

      const res = await handleDashboardRequest(req, { cache });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean };
      expect(body.ok).toBe(true);

      expect(await cache.get('k1', async () => null)).toBeNull();
      expect(await cache.get('k2', async () => null)).toBeNull();
    });
  });

  // ── 7. Framework Adapters (Express & Next.js) ─────────────────────────────

  describe('Framework Adapters', () => {
    it('serves dashboard through tricacheDashboard Express middleware over native http', async () => {
      const middleware = tricacheDashboard({ cache });
      const server = http.createServer((req, res) => {
        middleware(req, res);
      });

      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/metrics`);
        expect(res.status).toBe(200);
        const data = await res.json() as { title: string };
        expect(data.title).toBe('TriCache Observability');
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });

    it('creates Next.js App Router handlers with createNextDashboardHandlers', async () => {
      const handlers = createNextDashboardHandlers({ cache, title: 'Next Dashboard' });
      expect(typeof handlers.GET).toBe('function');
      expect(typeof handlers.POST).toBe('function');

      const req = new Request('http://localhost/api/metrics');
      const res = await handlers.GET(req);
      expect(res.status).toBe(200);
      const data = await res.json() as { title: string };
      expect(data.title).toBe('Next Dashboard');
    });

    it('starts and closes a standalone management server cleanly', async () => {
      const mgmt = await startDashboardServer({
        cache,
        port: 0, // OS assigned ephemeral port
        host: '127.0.0.1',
      });

      expect(mgmt.port).toBeGreaterThan(0);
      expect(mgmt.host).toBe('127.0.0.1');

      try {
        const res = await fetch(`http://127.0.0.1:${mgmt.port}/api/metrics`);
        expect(res.status).toBe(200);
        const data = await res.json() as { metrics: any };
        expect(data.metrics).toBeDefined();
      } finally {
        await mgmt.close();
      }
    });
  });

  // ── 8. Grafana Dashboard JSON & Prometheus Alert Rules Validation ────────

  describe('Enterprise Grafana Assets & Alerts', () => {
    it('validates dashboards/tricache-grafana.json structure and templating variables', () => {
      const jsonPath = path.resolve(__dirname, '../dashboards/tricache-grafana.json');
      expect(fs.existsSync(jsonPath)).toBe(true);

      const raw = fs.readFileSync(jsonPath, 'utf-8');
      const dashboard = JSON.parse(raw);

      expect(dashboard.title).toContain('TriCache');
      expect(dashboard.schemaVersion).toBeGreaterThanOrEqual(38);
      expect(dashboard.panels.length).toBeGreaterThanOrEqual(8);

      // Verify templating variables: $datasource, $namespace, $pod
      const vars = dashboard.templating.list.map((v: any) => v.name);
      expect(vars).toContain('datasource');
      expect(vars).toContain('namespace');
      expect(vars).toContain('pod');

      // Verify core Prometheus metrics referenced in panel expressions
      const serialized = JSON.stringify(dashboard);
      expect(serialized).toContain('tricache_gets_total');
      expect(serialized).toContain('tricache_l1_hits_total');
      expect(serialized).toContain('tricache_disk_hits_total');
      expect(serialized).toContain('tricache_l2_hits_total');
      expect(serialized).toContain('tricache_stampedes_prevented_total');
      expect(serialized).toContain('tricache_oom_evictions_total');
    });

    it('validates dashboards/tricache-alerts.yaml contains required PrometheusRule alerts', () => {
      const yamlPath = path.resolve(__dirname, '../dashboards/tricache-alerts.yaml');
      expect(fs.existsSync(yamlPath)).toBe(true);

      const content = fs.readFileSync(yamlPath, 'utf-8');
      expect(content).toContain('kind: PrometheusRule');
      expect(content).toContain('TriCacheOOMWatermarkBreached');
      expect(content).toContain('TriCacheCircuitBreakerOpen');
      expect(content).toContain('TriCacheHitRatioDegraded');
      expect(content).toContain('TriCacheSingleflightSaturated');
    });
  });
});
