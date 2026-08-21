import { TriCacheModule } from './tricache.module.js';

export { TriCacheModule };
export { TriCacheStore } from './tricache.store.js';
export {
  Cacheable,
  CacheEvict,
  type CacheableOptions,
  type CacheEvictOptions,
} from './decorators.js';
export {
  TRICACHE_SERVICE,
  CACHE_MANAGER,
  type DynamicModule,
  type Provider,
  type InjectionToken,
  type Type,
  type TriCacheAsyncOptions,
  type TriCacheOptionsFactory,
  type NestCacheStore,
} from './types.js';

export default TriCacheModule;
