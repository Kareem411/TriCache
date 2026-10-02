import type { CacheService } from 'tricache';
import { queryLog } from './db.js';
import { cacheEvents, lastCacheEvent } from './cache.js';

export function snapshot(cache: CacheService) {
  const metrics = cache.metrics();
  return {
    selects: queryLog.selects,
    queries: queryLog.count,
    lastEvent: lastCacheEvent(),
    events: cacheEvents.slice(),
    gets: metrics.gets.total,
    l1Hits: metrics.gets.l1Hits,
    fetches: metrics.gets.fetches,
    revalidations: metrics.revalidations.total,
  };
}

export { sleep } from './time.js';
