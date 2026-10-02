import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { CacheService } from 'tricache';
import { createFastifyPlugin, fastifyCache } from 'tricache/http';
import { paginateCatalog, resolveLanguage } from './catalog.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST ?? '127.0.0.1';
const ORIGIN_LATENCY_MS = Number(process.env.ORIGIN_LATENCY_MS) || 350;

/**
 * In-process only so the demo runs without Redis or a writable disk tier.
 * Swap these flags (or use CacheService.preset('microservice')) for a clustered deploy.
 */
const cache = CacheService.create({
  namespace: 'fastify-api-demo',
  disableRedis: true,
  disableDisk: true,
  invalidationBackplane: false,
});

function requestPath(req: { url?: string }): string {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  return q >= 0 ? raw.slice(0, q) : raw;
}

/**
 * Shared options object. Official Fastify helpers take `{ cache?, ttl, ... }`,
 * not `createFastifyPlugin(cache, options)`.
 *
 * `fastifyCachePlugin` is `createFastifyPlugin()` with no preset options —
 * equivalent registration: `fastify.register(fastifyCachePlugin, productsCacheOptions)`.
 */
const productsCacheOptions = {
  cache,
  ttl: 120,
  swr: 30,
  etag: true,
  tags: ['products'],
  /** `en` vs `fr` become distinct keys; `User-Agent` / other headers do not. */
  headerWhitelist: ['accept-language'],
  /**
   * Limit the global `onRequest`/`onSend` plugin to `/api/products`.
   * `/api/catalog` is owned by the route `preHandler` below.
   * Authenticated traffic is user-specific — never store it.
   */
  skipCache: (req: { url?: string; headers?: Record<string, unknown> }) =>
    requestPath(req) !== '/api/products' || Boolean(req.headers?.authorization),
};

const catalogCacheOptions = {
  cache,
  ttl: 120,
  swr: 30,
  etag: true,
  tags: ['catalog'],
  headerWhitelist: ['accept-language'],
};

const app = Fastify({ logger: false });

// Style 1 — global plugin: early short-circuit in `onRequest`, capture in `onSend`.
await app.register(createFastifyPlugin(productsCacheOptions));

app.get('/', async () => ({
  name: 'TriCache Fastify API demo',
  docs: 'See README.md for curl -i walkthroughs',
  exports: {
    createFastifyPlugin: 'plugin factory — register(createFastifyPlugin({ cache, ttl, ... }))',
    fastifyCachePlugin: 'alias of createFastifyPlugin() with no preset options',
    fastifyCache: 'dual helper — register() plugin or route preHandler',
  },
  routes: {
    products: 'GET /api/products?page=1&limit=5  (global createFastifyPlugin)',
    catalog: 'GET /api/catalog?page=1&limit=5    (route preHandler: fastifyCache)',
    health: 'GET /healthz',
  },
  try: {
    etag: 'GET /api/products — look for ETag: W/"..."',
    notModified: 'repeat with If-None-Match',
    querySort: '/api/products?limit=5&page=2 vs ?page=2&limit=5',
    language: 'Accept-Language: en | fr | es',
    skipAuth: 'Authorization: Bearer demo on /api/products',
    preHandler: 'GET /api/catalog — same ETag/304 via fastifyCache preHandler',
  },
}));

app.get('/healthz', async () => ({ ok: true }));

app.get('/api/products', async (request: FastifyRequest, reply: FastifyReply) => {
  const started = Date.now();
  await sleep(ORIGIN_LATENCY_MS);

  const query = request.query as Record<string, unknown>;
  const page = parsePositiveInt(query.page, 1, 50);
  const limit = parsePositiveInt(query.limit, 5, 50);
  const lang = resolveLanguage(request.headers['accept-language']);
  const { items, total } = paginateCatalog(lang, page, limit);
  const authorized = Boolean(request.headers.authorization);

  // Origin-only. Cache hits short-circuit in onRequest and never reach this handler.
  reply.header('X-TriCache-Demo', 'origin');
  return {
    style: 'global-plugin',
    hook: 'onRequest + onSend',
    lang,
    page,
    limit,
    total,
    generatedAt: new Date().toISOString(),
    originLatencyMs: Date.now() - started,
    cacheBypassed: authorized,
    note: 'generatedAt is stamped by the origin. Identical values mean a cache hit. Query order is irrelevant; Accept-Language is part of the key; Authorization skips the cache.',
    items,
  };
});

// Style 2 — route-level dual handler: probe in preHandler, persist by wrapping reply.send.
app.get(
  '/api/catalog',
  { preHandler: fastifyCache(catalogCacheOptions) },
  async (request: FastifyRequest, reply: FastifyReply) => {
    const started = Date.now();
    await sleep(ORIGIN_LATENCY_MS);

    const query = request.query as Record<string, unknown>;
    const page = parsePositiveInt(query.page, 1, 50);
    const limit = parsePositiveInt(query.limit, 5, 50);
    const lang = resolveLanguage(request.headers['accept-language']);
    const { items, total } = paginateCatalog(lang, page, limit);

    reply.header('X-TriCache-Demo', 'origin');
    return {
      style: 'route-preHandler',
      hook: 'fastifyCache preHandler',
      lang,
      page,
      limit,
      total,
      generatedAt: new Date().toISOString(),
      originLatencyMs: Date.now() - started,
      cacheBypassed: false,
      note: 'This route is cached only by preHandler: fastifyCache({ cache, ttl, ... }). Hits never reach this handler.',
      items,
    };
  },
);

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function start(): Promise<void> {
  await app.listen({ port: PORT, host: HOST });
  console.log(`TriCache Fastify demo listening on http://${HOST}:${PORT}`);
}

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received, shutting down`);
  await app.close().catch(() => {});
  await cache.destroy().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

void start();
