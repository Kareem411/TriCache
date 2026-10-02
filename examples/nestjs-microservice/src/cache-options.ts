import type { CacheOptions } from 'tricache';

/**
 * Local smoke-demo defaults: L1 only (no Redis, no disk).
 * Set REDIS_HOST (and optional REDIS_PORT) to attach L2.
 *
 * `TriCacheModule.register()` forwards this object to `CacheService.create()`.
 * There is no `preset` / `isGlobal` field on CacheOptions — the Nest module is
 * already registered as `global: true`.
 */
export function createDemoCacheOptions(): CacheOptions {
  const redisHost = process.env.REDIS_HOST;
  return {
    namespace: 'nestjs-microservice-demo',
    disableRedis: !redisHost,
    disableDisk: true,
    invalidationBackplane: false,
    ...(redisHost
      ? {
          redisHost,
          redisPort: Number(process.env.REDIS_PORT ?? 6379),
        }
      : {}),
  };
}

export function originLatencyMs(): number {
  const n = Number(process.env.ORIGIN_LATENCY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 250;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
