import { CacheService } from 'tricache';

export type CacheTier = 'l1' | 'disk' | 'l2';

export type CacheEvent =
  | { kind: 'hit'; key: string; tier: CacheTier }
  | { kind: 'miss'; key: string };

export const cacheEvents: CacheEvent[] = [];

/**
 * In-process L1 only so the demo runs without Redis or a writable disk tier.
 * `onHit` / `onMiss` are the CacheService hooks used for HIT/MISS output.
 */
export function createDemoCache(namespace: string): CacheService {
  cacheEvents.length = 0;
  return CacheService.create({
    namespace,
    disableRedis: true,
    disableDisk: true,
    invalidationBackplane: false,
    ttlJitterFactor: 0,
    onHit(key, tier) {
      cacheEvents.push({ kind: 'hit', key, tier });
    },
    onMiss(key) {
      cacheEvents.push({ kind: 'miss', key });
    },
  });
}

export function lastCacheEvent(): CacheEvent | undefined {
  return cacheEvents[cacheEvents.length - 1];
}
