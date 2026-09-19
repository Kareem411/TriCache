import { Hono } from 'hono';
import {
  EdgeCacheService,
  Murmur3BloomFilter,
  honoEdgeCache,
} from 'tricache/edge';
import { paginateCatalog, resolveLanguage } from './catalog.js';
import { MemoryRemoteStorage } from './memory-remote.js';

/**
 * Isolate-scoped singletons. A Worker isolate may handle many requests;
 * constructing these per-request would wipe L1, Bloom, and L2 on every hit.
 *
 * Published exports used here (see `src/edge/index.ts`):
 * - `EdgeCacheService`
 * - `honoEdgeCache`  (docs historically said `createHonoEdgeMiddleware` — that name is not exported)
 * - `Murmur3BloomFilter`
 */
const NAMESPACE = 'edge-hono-demo';
const bloom = new Murmur3BloomFilter();
const remote = new MemoryRemoteStorage();
const cache = new EdgeCacheService({
  namespace: NAMESPACE,
  maxKeys: 2_000,
  defaultTtlSeconds: 60,
  bloomFilter: bloom,
  remoteStorage: remote,
});

const feedCache = honoEdgeCache({
  cache,
  ttl: 60,
  swr: 30,
  etag: true,
  tags: ['feed'],
  /** `en` vs `fr` become distinct keys; `User-Agent` / other headers do not. */
  headerWhitelist: ['accept-language'],
  /** Authenticated traffic is user-specific — never store it. */
  skipCache: (c) => Boolean(c.req.header('authorization')),
});

type Bindings = {
  ORIGIN_LATENCY_MS?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get('/', (c) => {
  return c.json({
    name: 'TriCache Hono + Cloudflare Workers edge demo',
    runtime: 'workerd',
    import: 'tricache/edge',
    middleware: 'honoEdgeCache',
    docs: 'See README.md for wrangler dev and curl -i walkthroughs',
    routes: {
      feed: 'GET /api/feed?page=1&limit=5',
      health: 'GET /healthz',
      stats: 'GET /stats',
      bloomProbe: 'GET /stats/bloom-probe',
    },
    try: {
      etag: 'GET /api/feed — look for ETag: W/"..."',
      notModified: 'repeat with If-None-Match',
      querySort: '/api/feed?limit=5&page=2 vs ?page=2&limit=5',
      language: 'Accept-Language: en | fr | es',
      skipAuth: 'Authorization: Bearer demo',
      bloom: 'GET /stats/bloom-probe after a cached /api/feed',
    },
  });
});

app.get('/healthz', (c) => c.json({ ok: true }));

app.get('/stats', (c) => {
  return c.json({
    cache: cache.stats(),
    bloom: {
      insertions: bloom.insertions,
      maxCapacity: bloom.maxCapacity,
      ...bloom.stats,
    },
    remote: {
      getCount: remote.getCount,
    },
    note: 'Bloom insertions increment on cache.set. Unknown keys return mightContain=false and skip remote L2.',
  });
});

/**
 * Observable cold-miss defense: probe a never-seen key.
 * `EdgeCacheService.get` consults the Bloom filter before `remoteStorage.get`.
 */
app.get('/stats/bloom-probe', async (c) => {
  const probeKey = `scanner:${crypto.randomUUID()}`;
  const namespaced = `${NAMESPACE}:${probeKey}`;
  const remoteGetsBefore = remote.getCount;
  const bloomMightContain = bloom.mightContain(namespaced);
  const value = await cache.get(probeKey);
  const remoteGetsAfter = remote.getCount;

  return c.json({
    probeKey,
    namespaced,
    bloomMightContain,
    cacheValue: value,
    remoteGetsBefore,
    remoteGetsAfter,
    remoteGetSkipped: remoteGetsAfter === remoteGetsBefore,
    note: 'Unknown keys are definite MurmurHash3 Bloom misses. EdgeCacheService skips remote L2 (remoteGetSkipped: true).',
  });
});

app.get('/api/feed', feedCache, async (c) => {
  const started = Date.now();
  const latencyMs = Number(c.env?.ORIGIN_LATENCY_MS) || 250;
  await sleep(latencyMs);

  const page = parsePositiveInt(c.req.query('page'), 1, 50);
  const limit = parsePositiveInt(c.req.query('limit'), 5, 50);
  const lang = resolveLanguage(c.req.header('accept-language'));
  const { items, total } = paginateCatalog(lang, page, limit);
  const authorized = Boolean(c.req.header('authorization'));

  // Present on origin (cache miss / skipCache) only. Cache hits replay JSON + ETag.
  c.header('X-TriCache-Demo', 'origin');
  return c.json({
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

function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default app;
