/**
 * Smoke-checks the demo the same way the README curl walkthrough does:
 * @Cacheable hit vs miss, @CacheEvict tag invalidation, CACHE_MANAGER / TriCacheStore.
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

function request(
  method: string,
  urlPath: string,
  opts: { headers?: Record<string, string>; json?: unknown } = {},
): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const payload = opts.json !== undefined ? Buffer.from(JSON.stringify(opts.json)) : undefined;
    const req = http.request(
      {
        host,
        port,
        method,
        path: urlPath,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
          ...opts.headers,
        },
      },
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
    if (payload) req.write(payload);
    req.end();
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForHealth(timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await request('GET', '/healthz');
      if (res.status === 200) return;
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
    ['--import', 'tsx', path.join(root, 'main.ts')],
    {
      cwd: path.join(root, '..'),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: host,
        ORIGIN_LATENCY_MS: process.env.ORIGIN_LATENCY_MS ?? '200',
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

    const miss = await request('GET', '/items/1');
    assert(miss.status === 200, `cold GET /items/1 expected 200, got ${miss.status} ${miss.body}`);
    assert(typeof miss.json?.computedAt === 'string', 'cold GET missing computedAt');
    assert(miss.json?.originReads === 1, `cold GET expected originReads=1, got ${String(miss.json?.originReads)}`);
    const computedAt = miss.json?.computedAt as string;
    const item = miss.json?.data as { id: string; name: string } | undefined;
    assert(item?.id === '1', `expected item 1, got ${JSON.stringify(item)}`);
    console.log(`1. @Cacheable miss   ${miss.status}  originReads=${String(miss.json?.originReads)}  ${miss.ms}ms`);

    const hit = await request('GET', '/items/1');
    assert(hit.status === 200, `repeat GET /items/1 expected 200, got ${hit.status}`);
    assert(hit.json?.computedAt === computedAt, 'cache hit must reuse computedAt');
    assert(hit.json?.originReads === 1, `cache hit must reuse originReads, got ${String(hit.json?.originReads)}`);
    assert(hit.ms < miss.ms, `cache hit should be faster than miss (${hit.ms}ms vs ${miss.ms}ms)`);
    console.log(`2. @Cacheable hit    ${hit.status}  same computedAt + originReads  ${hit.ms}ms`);

    const listMiss = await request('GET', '/items');
    assert(listMiss.status === 200, `GET /items expected 200, got ${listMiss.status}`);
    assert(listMiss.json?.originReads === 2, `list miss expected originReads=2, got ${String(listMiss.json?.originReads)}`);
    const listAt = listMiss.json?.computedAt as string;
    const listHit = await request('GET', '/items');
    assert(listHit.json?.computedAt === listAt, 'list cache hit must reuse computedAt');
    assert(listHit.json?.originReads === 2, 'list cache hit must reuse originReads');
    console.log(`3. list hit          ${listHit.status}  originReads=2  ${listHit.ms}ms`);

    const patch = await request('PATCH', '/items/1', {
      json: { name: 'Ortho Keyboard', price: 149 },
    });
    assert(patch.status === 200, `PATCH expected 200, got ${patch.status} ${patch.body}`);
    const patched = patch.json?.item as { name: string } | undefined;
    assert(patched?.name === 'Ortho Keyboard', `PATCH should rename item, got ${JSON.stringify(patched)}`);
    assert(JSON.stringify(patch.json?.evictedTags) === JSON.stringify(['items']), 'PATCH should evict tag items');
    console.log(`4. @CacheEvict       ${patch.status}  tags=['items']`);

    const refill = await request('GET', '/items/1');
    assert(refill.status === 200, `post-evict GET expected 200, got ${refill.status}`);
    assert(refill.json?.computedAt !== computedAt, 'eviction must recompute computedAt');
    assert(refill.json?.originReads === 3, `post-evict GET expected originReads=3, got ${String(refill.json?.originReads)}`);
    const refilled = refill.json?.data as { name: string } | undefined;
    assert(refilled?.name === 'Ortho Keyboard', `refill should see mutation, got ${JSON.stringify(refilled)}`);
    console.log(`5. refill after evict ${refill.status}  originReads=3  ${refill.ms}ms`);

    const listRefill = await request('GET', '/items');
    assert(listRefill.json?.computedAt !== listAt, 'tag eviction must also miss the list key');
    assert(listRefill.json?.originReads === 4, `list refill expected originReads=4, got ${String(listRefill.json?.originReads)}`);
    console.log(`6. list refill       ${listRefill.status}  originReads=4  ${listRefill.ms}ms`);

    const empty = await request('GET', '/store/notes/n1');
    assert(empty.status === 200, `GET note miss expected 200, got ${empty.status}`);
    assert(empty.json?.cache === 'miss', `expected cache=miss, got ${String(empty.json?.cache)}`);

    const stored = await request('PUT', '/store/notes/n1', {
      json: { body: 'session-token', ttlMs: 60_000 },
    });
    assert(stored.status === 200, `PUT note expected 200, got ${stored.status} ${stored.body}`);
    assert(stored.json?.cache === 'stored', `expected cache=stored, got ${String(stored.json?.cache)}`);
    assert(stored.json?.ttlMs === 60_000, `expected ttlMs=60000, got ${String(stored.json?.ttlMs)}`);

    const storeHit = await request('GET', '/store/notes/n1');
    assert(storeHit.json?.cache === 'hit', `expected cache=hit, got ${String(storeHit.json?.cache)}`);
    const note = storeHit.json?.note as { body: string } | undefined;
    assert(note?.body === 'session-token', `store hit body mismatch: ${JSON.stringify(note)}`);
    assert(typeof storeHit.json?.ttlMs === 'number', 'store hit should report remaining ttlMs');

    const keys = await request('GET', '/store/keys');
    const keyList = keys.json?.keys as string[] | undefined;
    assert(Array.isArray(keyList) && keyList.includes('note:n1'), `expected note:n1 in keys, got ${JSON.stringify(keyList)}`);

    const deleted = await request('DELETE', '/store/notes/n1');
    assert(deleted.json?.cache === 'deleted', `expected cache=deleted, got ${String(deleted.json?.cache)}`);
    const afterDel = await request('GET', '/store/notes/n1');
    assert(afterDel.json?.cache === 'miss', 'DELETE via TriCacheStore.del should miss');
    console.log('7. CACHE_MANAGER     miss → set → hit → del → miss');

    console.log('\nAll NestJS demo checks passed.');
  } finally {
    child.kill('SIGTERM');
    await delay(400);
    if (child.exitCode === null && child.killed === false) {
      child.kill('SIGKILL');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
