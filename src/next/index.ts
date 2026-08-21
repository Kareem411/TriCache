export {
  TriCacheHandler,
  PRESET_CACHE_LIFE_PROFILES,
  resolveCacheLife,
  default,
} from './cache-handler';
export { TriCacheISRHandler } from './isr-handler';
export type {
  CacheHandlerValue,
  StoredNextCacheEntry,
  CacheHandlerContext,
  NextCacheHandlerOptions,
  IncrementalCacheValue,
  IncrementalCacheEntry,
  CacheLifePreset,
  CacheLifeProfile,
} from './types';

import { TriCacheHandler } from './cache-handler';
import type { NextCacheHandlerOptions } from './types';

/**
 * Factory helper for creating custom configured Next.js cache handler instances.
 *
 * @example
 * // next.config.mjs
 * export default {
 *   cacheHandler: require.resolve('tricache/next'),
 * };
 */
export function createNextCacheHandler(options: NextCacheHandlerOptions = {}): typeof TriCacheHandler {
  return class ConfiguredTriCacheHandler extends TriCacheHandler {
    constructor() {
      super(options);
    }
  };
}
