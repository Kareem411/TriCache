/**
 * Smoke-checks the Worker the same way the README curl -i walkthrough does:
 * weak ETag, 304, sorted query keys, accept-language, skipCache, Bloom skip.
 *
 * Uses node:http (not fetch). Undici fetch can add Cache-Control on conditional
 * GETs, and honoEdgeCache treats no-cache / no-store as a bypass.
 *
 * This script runs in Node. The Worker itself stays on Web Standards only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const exampleRoot = path.join(root, '..');
const port = Number(process.env.VERIFY_PORT) || 18787;
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

async function waitForHealth(timeoutMs = 60_000): Promise<void> {
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
    await delay(250);
  }
  throw new Error(`wrangler dev did not become healthy: ${String(lastError)}`);
}

function spawnWrangler(): ChildProcess {
  return spawn(
    'pnpm',
    [
      'exec',
      'wrangler',
      'dev',
      '--ip',
      host,
      '--port',
      String(port),
      '--inspector-port',
      '0',
    ],
    {
      cwd: exampleRoot,
      env: {
        ...process.env,
        CI: 'true',
        WRANGLER_SEND_METRICS: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

async function main(): Promise<void> {
  const child = spawnWrangler();

  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  const exitError = new Promise<never>((_, reject) => {
    child.on('exit', (code) => {
      reject(new Error(`wrangler dev exited early with code ${code}`));
    });
    child.on('error', reject);
  });

  try {
    await Promise.race([waitForHealth(), exitError]);

    const miss = await request('/api/feed?limit=5&page=2', {
      'accept-language': 'en',
    });
    const etag = header(miss, 'etag');
    assert(miss.status === 200, `cold GET expected 200, got ${miss.status}`);
    assert(etag?.startsWith('W/"'), `expected weak ETag, got ${etag}`);
    assert(header(miss, 'x-tricache-demo') === 'origin', 'cold GET should hit origin');
    assert(typeof miss.json?.generatedAt === 'string', 'cold GET missing generatedAt');
    const generatedAt = miss.json?.generatedAt as string;
    console.log(`1. cold miss  ${miss.status}  ${etag}  ${miss.ms}ms`);

    const swapped = await request('/api/feed?page=2&limit=5', {
      'accept-language': 'en',
    });
    assert(swapped.status === 200, `sorted-query GET expected 200, got ${swapped.status}`);
    assert(header(swapped, 'etag') === etag, 'query order must share ETag');
    assert(swapped.json?.generatedAt === generatedAt, 'query order must share generatedAt');
    assert(header(swapped, 'x-tricache-demo') !== 'origin', 'sorted-query GET should be a cache hit');
    console.log(`2. query sort ${swapped.status}  same ETag + generatedAt  ${swapped.ms}ms`);

    const notModified = await request('/api/feed?limit=5&page=2', {
      'accept-language': 'en',
      'if-none-match': etag ?? '',
    });
    assert(notModified.status === 304, `If-None-Match expected 304, got ${notModified.status}`);
    assert(notModified.body === '', `304 should have an empty body, got ${notModified.body.slice(0, 80)}`);
    assert(header(notModified, 'etag') === etag, '304 should echo the weak ETag');
    console.log(`3. 304        ${notModified.status}  empty body  ${notModified.ms}ms`);

    const french = await request('/api/feed?limit=5&page=2', {
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
    console.log(`4. language   ${french.status}  lang=fr  ${header(french, 'etag')}  ${french.ms}ms`);

    const authA = await request('/api/feed?limit=5&page=2', {
      'accept-language': 'en',
      authorization: 'Bearer demo',
    });
    const authB = await request('/api/feed?limit=5&page=2', {
      'accept-language': 'en',
      authorization: 'Bearer demo',
    });
    assert(authA.status === 200 && authB.status === 200, 'auth GET should be 200');
    assert(authA.json?.cacheBypassed === true && authB.json?.cacheBypassed === true, 'auth responses should set cacheBypassed');
    assert(header(authA, 'x-tricache-demo') === 'origin' && header(authB, 'x-tricache-demo') === 'origin', 'auth should skip cache');
    assert(!header(authA, 'etag') && !header(authB, 'etag'), 'skipCache should not attach an ETag');
    assert(authA.json?.generatedAt !== authB.json?.generatedAt, 'auth requests must not reuse generatedAt');
    console.log(`5. skipCache  ${authA.status}/${authB.status}  distinct generatedAt  ${authA.ms}ms/${authB.ms}ms`);

    const stats = await request('/stats');
    assert(stats.status === 200, `stats expected 200, got ${stats.status}`);
    const bloom = stats.json?.bloom as { insertions?: number } | undefined;
    assert((bloom?.insertions ?? 0) > 0, `expected bloom insertions after cached feed, got ${String(bloom?.insertions)}`);

    const probe = await request('/stats/bloom-probe');
    assert(probe.status === 200, `bloom-probe expected 200, got ${probe.status}`);
    assert(probe.json?.bloomMightContain === false, 'unknown key should be a definite Bloom miss');
    assert(probe.json?.remoteGetSkipped === true, 'Bloom miss should skip remote L2 get');
    console.log(`6. bloom skip remoteGetSkipped=${String(probe.json?.remoteGetSkipped)}  insertions=${String(bloom?.insertions)}`);

    console.log('\nAll Hono edge demo checks passed.');
  } finally {
    child.kill('SIGTERM');
    await delay(500);
    if (child.exitCode === null && child.killed === false) {
      child.kill('SIGKILL');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
