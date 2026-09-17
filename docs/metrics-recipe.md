# Prometheus Metrics Recipe

> **Goal**: Expose TriCache metrics at a `/metrics` endpoint (Prometheus text format), scrape them with Prometheus, and visualize them in the bundled Grafana dashboard.
>
> **Scope of this guide**:
> 1. Three endpoint examples — Express, Fastify, Next.js App Router — using `CacheService.toPrometheusText(metrics)`
> 2. Example Prometheus scrape config (`dashboards/prometheus-scrape.yml`)
> 3. Local dev setup with one-command `docker compose -f docker-compose.metrics.yml up`
> 4. Verify against the existing [`dashboards/tricache-grafana.json`](../dashboards/tricache-grafana.json)
>
> **Already provided by TriCache** (do not duplicate):
> - Built-in HTML/SSE dashboard — see [`observability.md`](./observability.md) §1
> - Grafana dashboard JSON — [`dashboards/tricache-grafana.json`](../dashboards/tricache-grafana.json)
> - Prometheus alerts — [`dashboards/tricache-alerts.yaml`](../dashboards/tricache-alerts.yaml)
>
> **No mainnet / no wallet / no auth setup required.** This guide only reads from your local TriCache process.

---

## 1. The `/metrics` contract

`CacheService.toPrometheusText(m, prefix?, instanceName?)` returns a `text/plain; version=0.0.4` string that Prometheus can scrape directly. The string includes `# HELP` / `# TYPE` headers and the metric lines with optional namespace + instance labels.

```ts
import { CacheService } from 'tricache';
const text = CacheService.toPrometheusText(cache.metrics(), 'tricache', process.env.HOSTNAME);
```

Reference implementation: [`src/cache-service.ts`](../src/cache-service.ts) (`static toPrometheusText`).

---

## 2. Endpoint examples

### 2.1 Express / Connect

```ts
import express from 'express';
import { CacheService, type ICache } from 'tricache';

export function metricsRoute(cache: ICache) {
  const router = express.Router();
  router.get('/metrics', (_req, res) => {
    res
      .status(200)
      .set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(CacheService.toPrometheusText(cache.metrics(), 'tricache', process.env.HOSTNAME));
  });
  return router;
}

// app.ts
app.use(metricsRoute(cache));
```

> ⚠️ **Do NOT** put `/metrics` behind a public route without auth or IP allow-list in production. Bind it to an internal listener (e.g. `127.0.0.1`) or front it with mTLS / basic-auth at the proxy layer.

### 2.2 Fastify

```ts
import type { FastifyInstance } from 'fastify';
import { CacheService, type ICache } from 'tricache';

export async function registerMetrics(app: FastifyInstance, cache: ICache) {
  app.get('/metrics', async (_req, reply) => {
    reply
      .code(200)
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(CacheService.toPrometheusText(cache.metrics(), 'tricache', process.env.HOSTNAME));
  });
}

// server.ts
await registerMetrics(app, cache);
```

### 2.3 Next.js App Router

```ts
// app/api/metrics/route.ts
import { cache } from '@/lib/cache';
import { CacheService } from 'tricache';

export const dynamic = 'force-dynamic'; // never cache this route
export const runtime = 'nodejs';        // toPrometheusText is sync; edge runtime also works

export async function GET() {
  const body = CacheService.toPrometheusText(cache.metrics(), 'tricache', process.env.HOSTNAME);
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
  });
}
```

For Next.js, mount the dashboard's HTML/SSE UI under `app/admin/cache/[...slug]/route.ts` as shown in [`observability.md`](./observability.md) — the metrics endpoint here is **separate** from the dashboard UI.

---

## 3. Prometheus scrape config

A minimal config that scrapes a single local app on `127.0.0.1:3000`:

```yaml
# dashboards/prometheus-scrape.yml  (EXAMPLE)
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: tricache
    metrics_path: /metrics
    static_configs:
      - targets: ['host.docker.internal:3000']   # when Prometheus runs in docker
        labels:
          service: tricache
          env: dev
```

Use the same `metrics_path: /metrics` for production deployments. For multi-instance setups, replace `static_configs` with `file_sd_configs` or your service discovery backend.

For alert rules, see [`dashboards/tricache-alerts.yaml`](../dashboards/tricache-alerts.yaml) (ship with the repo).

---

## 4. One-command local dev stack

`docker-compose.metrics.yml` (this PR adds it at the repo root) brings up Prometheus + Grafana pre-wired to scrape the host's TriCache process:

```yaml
# docker-compose.metrics.yml  (TESTNET-LIKE — local-only dev, no external network)
services:
  prometheus:
    image: prom/prometheus:v2.55.0
    container_name: tricache-prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
    volumes:
      - ./dashboards/prometheus-scrape.yml:/etc/prometheus/prometheus.yml:ro
    ports:
      - '127.0.0.1:9090:9090'   # bind to loopback only
    extra_hosts:
      - 'host.docker.internal:host-gateway'

  grafana:
    image: grafana/grafana:11.4.0
    container_name: tricache-grafana
    depends_on: [prometheus]
    environment:
      GF_SECURITY_ADMIN_USER: ${GRAFANA_ADMIN_USER:-admin}
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD:-admin}  # CHANGE in any non-dev env
      GF_USERS_ALLOW_SIGN_UP: 'false'
    volumes:
      - ./dashboards/tricache-grafana.json:/var/lib/grafana/dashboards/tricache.json:ro
    ports:
      - '127.0.0.1:3001:3000'   # bind to loopback only
```

Bring it up:

```bash
# 1. Start your app exposing /metrics on 127.0.0.1:3000 (use examples above)
# 2. In this repo root:
docker compose -f docker-compose.metrics.yml up -d
# 3. Open:
#    Prometheus:  http://127.0.0.1:9090
#    Grafana:     http://127.0.0.1:3001  (login admin / admin — change immediately)
# 4. Grafana → Dashboards → Import → upload dashboards/tricache-grafana.json
#    Or use the pre-provisioned volume mount if you wire `provisioning/` (out of scope here).
```

---

## 5. Verifying the scrape

After Prometheus is up, hit:

- `curl -s http://127.0.0.1:9090/api/v1/targets | jq '.data.activeTargets[] | select(.labels.job=="tricache") | {url:.scrapeUrl, health:.health, lastError:.lastError}'`
- `curl -s http://127.0.0.1:9090/api/v1/query?query=tricache_l1_hit_rate | jq`

If `health != "up"`, check:
- App process is reachable from inside the Prometheus container (`host.docker.internal:3000`).
- `/metrics` returns 200 with `Content-Type: text/plain`.
- No proxy / auth in front of `/metrics` that breaks the scrape.

---

## 6. Metric names emitted

Names are prefixed with `tricache_` by default. Full list (defined in `CacheService.toPrometheusText`):

**Counters** (`_total` suffix): `tricache_gets_total`, `tricache_l1_hits_total`, `tricache_disk_hits_total`, `tricache_l2_hits_total`, `tricache_fetches_total`, `tricache_stampedes_prevented_total`, `tricache_sets_total`, `tricache_deletes_total`, `tricache_swr_revalidations_total`, `tricache_disk_spills_shed_total`, `tricache_disk_prune_rounds_total`, `tricache_disk_entries_pruned_total`, `tricache_disk_low_space_pauses_total`, `tricache_disk_bypassed_events_total`, `tricache_backplane_sent_total`, `tricache_backplane_received_total`, `tricache_oom_evictions_total`

**Gauges**: `tricache_l1_hit_rate`, `tricache_disk_hit_rate`, `tricache_l2_hit_rate`, `tricache_fetch_rate`, `tricache_l1_entries`, `tricache_l1_size_bytes`, `tricache_disk_files`, `tricache_disk_latency_bypass_stage`, `tricache_disk_p95_ms`, `tricache_redis_p95_ms`, `tricache_bloom_false_positive_rate`, `tricache_compression_bytes_saved`

Optional labels: `namespace` (from `CacheMetrics.namespace`) and `instance` (from the `instanceName` argument to `toPrometheusText`).

---

## 7. Cross-references

- [`observability.md`](./observability.md) — HTML/SSE dashboard, Next.js dashboard mount, OpenTelemetry tracing, terminal CLI
- [`dashboards/tricache-grafana.json`](../dashboards/tricache-grafana.json) — pre-built Grafana dashboard
- [`dashboards/tricache-alerts.yaml`](../dashboards/tricache-alerts.yaml) — Prometheus alert rules
- `src/cache-service.ts` — `toPrometheusText` implementation
