import express, { type Request, type Response } from 'express';
import { CacheService } from 'tricache';
import { createExpressMiddleware } from 'tricache/http';
import { paginateCatalog, resolveLanguage } from './catalog.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST ?? '127.0.0.1';
const ORIGIN_LATENCY_MS = Number(process.env.ORIGIN_LATENCY_MS) || 350;

/**
 * In-process only so the demo runs without Redis or a writable disk tier.
 * Swap these flags (or use CacheService.preset('microservice')) for a clustered deploy.
 */
const cache = CacheService.create({
  namespace: 'express-api-demo',
  disableRedis: true,
  disableDisk: true,
  invalidationBackplane: false,
});

const productsCache = createExpressMiddleware({
  cache,
  ttl: 120,
  swr: 30,
  etag: true,
  tags: ['products'],
  /** `en` vs `fr` become distinct keys; `User-Agent` / other headers do not. */
  headerWhitelist: ['accept-language'],
  /** Authenticated traffic is user-specific — never store it. */
  skipCache: (req) => Boolean(req.headers.authorization),
});

const app = express();
// Disable Express's own ETag so clients see only TriCache weak validators (`W/"…"`).
app.set('etag', false);

app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'TriCache Express API demo',
    docs: 'See README.md for curl -i walkthroughs',
    routes: {
      products: 'GET /api/products?page=1&limit=5',
      health: 'GET /healthz',
    },
    try: {
      etag: 'GET /api/products — look for ETag: W/"..."',
      notModified: 'repeat with If-None-Match',
      querySort: '/api/products?limit=5&page=2 vs ?page=2&limit=5',
      language: 'Accept-Language: en | fr | es',
      skipAuth: 'Authorization: Bearer demo',
    },
  });
});

app.get('/healthz', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get('/api/products', productsCache, async (req: Request, res: Response) => {
  const started = Date.now();
  await sleep(ORIGIN_LATENCY_MS);

  const page = parsePositiveInt(req.query.page, 1, 50);
  const limit = parsePositiveInt(req.query.limit, 5, 50);
  const lang = resolveLanguage(req.headers['accept-language']);
  const { items, total } = paginateCatalog(lang, page, limit);
  const authorized = Boolean(req.headers.authorization);

  // Present on origin (cache miss / skipCache) only. Cache hits replay JSON + ETag.
  res.setHeader('X-TriCache-Demo', 'origin');
  res.json({
    lang,
    page,
    limit,
    total,
    generatedAt: new Date().toISOString(),
    originLatencyMs: Date.now() - started,
    cacheBypassed: authorized,
    note: 'generatedAt is stamped by the origin. Identical values mean a cache hit. Query order is irrelevant; Accept-Language is part of the key; Authorization skips the cache.',
    items,
  });
});

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const server = app.listen(PORT, HOST, () => {
  console.log(`TriCache Express demo listening on http://${HOST}:${PORT}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received, shutting down`);
  server.close();
  await cache.destroy().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
