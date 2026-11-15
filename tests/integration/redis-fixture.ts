import { afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { createClient } from 'redis';
import { CacheService } from '../../src/cache-service.js';
import type { CacheOptions } from '../../src/types.js';

export const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
export const NS = `it-${randomUUID()}`;
export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
export const probe = createClient({ url: REDIS_URL, socket: { connectTimeout: 1500, reconnectStrategy: false } });
probe.on('error', () => {}); // A failed optional probe must not emit an unhandled error or retry forever.

export let redisUp = false;
try {
  await probe.connect();
  redisUp = true;
} catch {
  probe.destroy();
  if (process.env.TEST_REDIS_REQUIRED === '1' || process.env.TEST_REDIS_URL) {
    throw new Error('Required integration Redis is unreachable; verify TEST_REDIS_URL');
  }
}

const instances: CacheService[] = [];
const drivers: Redis[] = [];
export function makeSvc(extra: CacheOptions = {}): CacheService {
  const driver = new Redis(REDIS_URL, { lazyConnect: true, commandTimeout: 2500, maxRetriesPerRequest: 1 });
  driver.on('error', () => {});
  drivers.push(driver);
  const cache = new CacheService({ namespace: NS, disableDisk: true, disableRedis: false, redisClient: driver,
    invalidationBackplane: false, oomProtection: false, compression: 'none', logger: silentLogger, ...extra });
  instances.push(cache);
  return cache;
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map(cache => cache.destroy()));
  for (const driver of drivers.splice(0)) driver.disconnect();
});
afterAll(async () => {
  if (!probe.isOpen) return;
  try {
    for await (const keys of probe.scanIterator({ MATCH: `${NS}:*`, COUNT: 100 })) {
      if (keys.length) await probe.del(keys);
    }
    await probe.del(`tricache:stream:{${NS}}`);
  } finally { probe.destroy(); }
});

/** Bounded assertion wait for asynchronous transport delivery, not a fixed sleep. */
export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!await predicate()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for Redis integration assertion');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
