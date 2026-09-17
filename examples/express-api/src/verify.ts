/**
 * Smoke-checks the demo the same way the README curl -i walkthrough does:
 * weak ETag, 304, sorted query keys, accept-language, skipCache for Authorization.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.VERIFY_PORT) || 34567;
const base = `http://127.0.0.1:${port}`;

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

async function request(urlPath: string, headers: Record<string, string> = {}): Promise<Probe> {
  const started = Date.now();
  const res = await fetch(base + urlPath, { headers });
  const body = await res.text();
  let json: Record<string, unknown> | null = null;
  if (body) {
    try {
      json = JSON.parse(body) as Record<string, unknown>;
    } catch {
      json = null;
    }
  }
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body,
    json,
    ms: Date.now() - started,
  };
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
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
      lastError = new Error(`healthz ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await delay(100);
  }
  throw new Error(`server did not become healthy: ${String(lastError)}`);
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
        HOST: '127.0.0.1',
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
    assert(miss.status === 200, `cold GET expected 200, got ${miss.status}`);
    assert(etag?.startsWith('W/"'), `expected weak ETag, got ${etag}`);
    assert(header(miss, 'x-tricache-demo') === 'origin', 'cold GET should hit origin');
    assert(typeof miss.json?.generatedAt === 'string', 'cold GET missing generatedAt');
    const generatedAt = miss.json?.generatedAt as string;
    console.log(`1. cold miss  ${miss.status}  ${etag}  ${miss.ms}ms`);

    const swapped = await request('/api/products?page=2&limit=5', {
      'accept-language': 'en',
    });
    assert(swapped.status === 200, `sorted-query GET expected 200, got ${swapped.status}`);
    assert(header(swapped, 'etag') === etag, 'query order must share ETag');
    assert(swapped.json?.generatedAt === generatedAt, 'query order must share generatedAt');
    assert(header(swapped, 'x-tricache-demo') !== 'origin', 'sorted-query GET should be a cache hit');
    console.log(`2. query sort ${swapped.status}  same ETag + generatedAt  ${swapped.ms}ms`);

    const notModified = await request('/api/products?limit=5&page=2', {
      'accept-language': 'en',
      'if-none-match': etag ?? '',
    });
    assert(notModified.status === 304, `If-None-Match expected 304, got ${notModified.status}`);
    assert(notModified.body === '', `304 should have an empty body, got ${notModified.body.slice(0, 80)}`);
    assert(header(notModified, 'etag') === etag, '304 should echo the weak ETag');
    console.log(`3. 304        ${notModified.status}  empty body  ${notModified.ms}ms`);

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
    console.log(`4. language   ${french.status}  lang=fr  ${header(french, 'etag')}  ${french.ms}ms`);

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
    console.log(`5. skipCache  ${authA.status}/${authB.status}  distinct generatedAt  ${authA.ms}ms/${authB.ms}ms`);

    console.log('\nAll Express demo checks passed.');
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
