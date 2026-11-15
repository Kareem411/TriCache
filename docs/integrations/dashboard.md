# Visual Dashboard & Terminal CLI

> Package entry: `tricache/dashboard` and CLI binary `npx tricache`

TriCache includes an enterprise visual administration suite with **zero external CDN dependencies** (100% air-gappable), plus a command-line interface for terminal workflows.

---

## 1. Embedded Single-Page Web UI

Mount the real-time Server-Sent Events (SSE) administration dashboard into any Node.js web server:

![Visual Single-Page Web Dashboard](/docs/Cache_observability_dashboard_di…_20260910213742.jpeg)

```typescript
import { tricacheDashboard } from 'tricache/dashboard';
import { cache } from './cache';

const password = process.env.DASHBOARD_PASSWORD;
if (!password) throw new Error('DASHBOARD_PASSWORD is required');

// Express / Connect (for Fastify, wrap its raw request/response in a route)
app.use(
  '/admin/cache',
  tricacheDashboard({
    cache,
    basePath: '/admin/cache',
    title: 'Fleet Cache Console',
    auth: {
      username: 'admin',
      password,
    },
    readOnly: true, // Default. Set false only on an authenticated, private admin endpoint.
  })
);
```

---

## 2. Next.js 16 App Router

Mount the dashboard inside a Next.js App Router project:

```typescript
// app/admin/cache/[...slug]/route.ts
import { createNextDashboardHandlers } from 'tricache/dashboard';
import { cache } from '@/lib/cache';

const secret = process.env.MANAGEMENT_SECRET;
if (!secret) throw new Error('MANAGEMENT_SECRET is required');

export const { GET, POST } = createNextDashboardHandlers({
  cache,
  basePath: '/admin/cache',
  authSecret: secret,
  readOnly: true,
});
```

---

## 3. Standalone Management Server (Kubectl Port-Forwarding)

For backend microservices and container pods that do not expose public HTTP endpoints:

```typescript
import { startDashboardServer } from 'tricache/dashboard';
import { cache } from './cache';

const server = await startDashboardServer({
  cache,
  port: 9090,
  host: '127.0.0.1',
  authSecret: process.env.MANAGEMENT_SECRET,
});

console.log(`Cache management server listening on port ${server.port}`);
```

Access securely via Kubernetes without opening public ingress routes:
```bash
kubectl port-forward pod/api-service-pod 9090:9090
# Open in browser: http://localhost:9090?token=<MANAGEMENT_SECRET>
```

---

## 4. Terminal CLI (`npx tricache`)

Manage and inspect active instances directly from your terminal:

```bash
# Display the running process's live ASCII dashboard (requires enableIpc: true)
npx tricache top --pid <pid>

# Export the running process's snapshot as JSON
npx tricache top --pid <pid> --once --json

# Measure 3-tier round-trip latency
npx tricache ping --redis redis://127.0.0.1:6379

# Clear shared keys for an explicitly chosen namespace/prefix
npx tricache clear --namespace my-app --prefix products: --redis redis://127.0.0.1:6379
```

`inspect` creates a separate diagnostic cache instance; it does not inspect another process's L1. CLI tag invalidation and a `metrics --prometheus` command are not implemented. Use `cache.invalidateTag()` and `CacheService.toPrometheusText(cache.metrics())` in the application instead.

The UI carries a URL token into its own API/SSE requests and suppresses referrers, but tokens can still appear in browser history and proxy logs. Prefer HTTP Basic auth or a protected reverse proxy. Request bodies default to a 64 KiB limit (`maxRequestBytes`). Slow/disconnected SSE readers do not accumulate unbounded snapshots.
