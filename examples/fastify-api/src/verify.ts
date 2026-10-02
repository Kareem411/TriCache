/**
 * Smoke-checks the demo the same way the README curl -i walkthrough does:
 * global plugin (onRequest/onSend), route preHandler, weak ETag, 304,
 * sorted query keys, accept-language, skipCache for Authorization.
 *
 * Uses node:http (not fetch). Undici fetch adds Cache-Control on conditional
 * GETs, and tricache/http treats no-cache / no-store as a bypass.
 *
 * The Fastify plugin persists via fire-and-forget `cache.set` in `onSend`,
 * so this script polls briefly after a miss until the hit is observable.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.VERIFY_PORT) || 34568;
const host = '127.0.0.1';

interface Probe {
  status: number;
  headers: Record<string, string>;
  body: string;
  json: Record<string, unknown> | null;
  ms: number;
}

function header(res: Probe, name: string): string | undefined {
  return res.headers[name.toLowerCase()];
}

function request(urlPath: string, headers: Record<string, string> = {}): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.request(
      { host, port, path: urlPath, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown> | null = null;
          if (body) {
            try {
              json = JSON.parse(body) as Record<string, unknown>;
            } catch {
              json = null;
            }
          }
          const normalized: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') normalized[key.toLowerCase()] = value;
            else if (Array.isArray(value)) normalized[key.toLowerCase()] = value.join(', ');
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: normalized,
            body,
            json,
            ms: Date.now() - started,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForHealth(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await request('/healthz');
      if (res.status === 200) return;
      lastError = new Error(`healthz ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await delay(100);
  }
  throw new Error(`server did not become healthy: ${String(lastError)}`);
}

async function waitForHit(
  urlPath: string,
  headers: Record<string, string>,
  expectedGeneratedAt: string,
  timeoutMs = 2_000,
): Promise<Probe> {
  const deadline = Date.now() + timeoutMs;
  let last: Probe | undefined;
  while (Date.now() < deadline) {
    last = await request(urlPath, headers);
    const isHit =
      last.status === 200
      && header(last, 'x-tricache-demo') !== 'origin'
      && last.json?.generatedAt === expectedGeneratedAt;
    if (isHit) return last;
    await delay(25);
  }
  throw new Error(
    `did not observe a cache hit for ${urlPath}: status=${last?.status} origin=${header(last ?? { headers: {} } as Probe, 'x-tricache-demo')} generatedAt=${String(last?.json?.generatedAt)}`,
  );
}

async function main(): Promise<void> {
  const child: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(root, 'server.ts')],
    {
      cwd: path.join(root, '..'),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: host,
        ORIGIN_LATENCY_MS: process.env.ORIGIN_LATENCY_MS ?? '250',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  const exitError = new Promise<never>((_, reject) => {
    child.on('exit', (code) => {
      reject(new Error(`demo server exited early with code ${code}`));
    });
    child.on('error', reject);
  });

  try {
    await Promise.race([waitForHealth(), exitError]);

    const miss = await request('/api/products?limit=5&page=2', {
      'accept-language': 'en',
    });
    const etag = header(miss, 'etag');
    assert(miss.status === 200, `cold GET /api/products expected 200, got ${miss.status}`);
    assert(etag?.startsWith('W/"'), `expected weak ETag on products, got ${etag}`);
    assert(header(miss, 'x-tricache-demo') === 'origin', 'cold products GET should hit origin');
    assert(miss.json?.style === 'global-plugin', `expected style=global-plugin, got ${String(miss.json?.style)}`);
    assert(typeof miss.json?.generatedAt === 'string', 'cold products GET missing generatedAt');
    const generatedAt = miss.json?.generatedAt as string;
    console.log(`1. plugin miss   ${miss.status}  ${etag}  ${miss.ms}ms`);

    const swapped = await waitForHit('/api/products?page=2&limit=5', {
      'accept-language': 'en',
    }, generatedAt);
    assert(header(swapped, 'etag') === etag, 'query order must share ETag (onRequest hit)');
    assert(swapped.json?.generatedAt === generatedAt, 'query order must share generatedAt');
    assert(swapped.ms < 200, `plugin cache hit should skip origin latency, took ${swapped.ms}ms`);
    console.log(`2. plugin hit    ${swapped.status}  same ETag + generatedAt  ${swapped.ms}ms`);

    const notModified = await request('/api/products?limit=5&page=2', {
      'accept-language': 'en',
      'if-none-match': etag ?? '',
    });
    assert(notModified.status === 304, `If-None-Match expected 304, got ${notModified.status}`);
    assert(notModified.body === '', `304 should have an empty body, got ${notModified.body.slice(0, 80)}`);
    assert(header(notModified, 'etag') === etag, '304 should echo the weak ETag');
    console.log(`3. plugin 304    ${notModified.status}  empty body  ${notModified.ms}ms`);

    const french = await request('/api/products?limit=5&page=2', {
      'accept-language': 'fr',
    });
    assert(french.status === 200, `fr GET expected 200, got ${french.status}`);
    assert(header(french, 'etag') !== etag, 'Accept-Language must change the cache key / ETag');
    assert(french.json?.lang === 'fr', `expected lang=fr, got ${String(french.json?.lang)}`);
    assert(header(french, 'x-tricache-demo') === 'origin', 'first fr GET should hit origin');
    const frenchNames = ((french.json?.items as Array<{ name: string }> | undefined) ?? []).map((item) => item.name);
    assert(
      frenchNames.includes('Haut-parleurs de bureau'),
      `expected localized French catalog, got ${frenchNames.join(', ')}`,
    );
    console.log(`4. plugin lang   ${french.status}  lang=fr  ${header(french, 'etag')}  ${french.ms}ms`);

    const authA = await request('/api/products?limit=5&page=2', {
      'accept-language': 'en',
      authorization: 'Bearer demo',
    });
    const authB = await request('/api/products?limit=5&page=2', {
      'accept-language': 'en',
      authorization: 'Bearer demo',
    });
    assert(authA.status === 200 && authB.status === 200, 'auth GET should be 200');
    assert(authA.json?.cacheBypassed === true && authB.json?.cacheBypassed === true, 'auth responses should set cacheBypassed');
    assert(header(authA, 'x-tricache-demo') === 'origin' && header(authB, 'x-tricache-demo') === 'origin', 'auth should skip cache');
    assert(!header(authA, 'etag') && !header(authB, 'etag'), 'skipCache should not attach an ETag');
    assert(authA.json?.generatedAt !== authB.json?.generatedAt, 'auth requests must not reuse generatedAt');
    console.log(`5. plugin skip   ${authA.status}/${authB.status}  distinct generatedAt  ${authA.ms}ms/${authB.ms}ms`);

    const catalogMiss = await request('/api/catalog?limit=5&page=2', {
      'accept-language': 'en',
    });
    const catalogEtag = header(catalogMiss, 'etag');
    assert(catalogMiss.status === 200, `cold GET /api/catalog expected 200, got ${catalogMiss.status}`);
    assert(catalogEtag?.startsWith('W/"'), `expected weak ETag on catalog, got ${catalogEtag}`);
    assert(header(catalogMiss, 'x-tricache-demo') === 'origin', 'cold catalog GET should hit origin');
    assert(catalogMiss.json?.style === 'route-preHandler', `expected style=route-preHandler, got ${String(catalogMiss.json?.style)}`);
    assert(typeof catalogMiss.json?.generatedAt === 'string', 'cold catalog GET missing generatedAt');
    const catalogGeneratedAt = catalogMiss.json?.generatedAt as string;
    console.log(`6. preHandler miss  ${catalogMiss.status}  ${catalogEtag}  ${catalogMiss.ms}ms`);

    const catalogHit = await waitForHit('/api/catalog?page=2&limit=5', {
      'accept-language': 'en',
    }, catalogGeneratedAt);
    assert(header(catalogHit, 'etag') === catalogEtag, 'catalog query order must share ETag');
    assert(catalogHit.json?.generatedAt === catalogGeneratedAt, 'catalog query order must share generatedAt');
    assert(catalogHit.ms < 200, `preHandler cache hit should skip origin latency, took ${catalogHit.ms}ms`);
    console.log(`7. preHandler hit   ${catalogHit.status}  same ETag + generatedAt  ${catalogHit.ms}ms`);

    const catalog304 = await request('/api/catalog?limit=5&page=2', {
      'accept-language': 'en',
      'if-none-match': catalogEtag ?? '',
    });
    assert(catalog304.status === 304, `catalog If-None-Match expected 304, got ${catalog304.status}`);
    assert(catalog304.body === '', `catalog 304 should have an empty body, got ${catalog304.body.slice(0, 80)}`);
    assert(header(catalog304, 'etag') === catalogEtag, 'catalog 304 should echo the weak ETag');
    console.log(`8. preHandler 304   ${catalog304.status}  empty body  ${catalog304.ms}ms`);

    console.log('\nAll Fastify demo checks passed.');
  } finally {
    child.kill('SIGTERM');
    await delay(300);
    if (child.exitCode === null && child.killed === false) {
      child.kill('SIGKILL');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
