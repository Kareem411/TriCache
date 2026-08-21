import { CacheService, type CacheOptions } from '../index.js';
import { TriCacheStore } from './tricache.store.js';
import {
  TRICACHE_SERVICE,
  CACHE_MANAGER,
  type DynamicModule,
  type Provider,
  type TriCacheAsyncOptions,
  type TriCacheOptionsFactory,
} from './types.js';

/**
 * TriCacheModule — NestJS dynamic module providing TriCacheService and standard CacheStore.
 *
 * Can be registered synchronously via `TriCacheModule.register(options)`
 * or asynchronously via `TriCacheModule.registerAsync({ useFactory: ... })`.
 *
 * Exports:
 * - `TRICACHE_SERVICE` (`CacheService` instance)
 * - `CACHE_MANAGER` (`TriCacheStore` adapter conforming to @nestjs/cache-manager)
 */
export class TriCacheModule {
  /**
   * Register TriCache module synchronously with static configuration options.
   */
  static register(options: CacheOptions = {}): DynamicModule {
    const cache = CacheService.create(options);
    const store = new TriCacheStore(cache);

    return {
      module: TriCacheModule,
      global: true,
      providers: [
        { provide: TRICACHE_SERVICE, useValue: cache },
        { provide: CACHE_MANAGER, useValue: store },
      ],
      exports: [TRICACHE_SERVICE, CACHE_MANAGER],
    };
  }

  /**
   * Register TriCache module asynchronously with factory or class injection.
   */
  static registerAsync(asyncOptions: TriCacheAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(asyncOptions);

    return {
      module: TriCacheModule,
      global: true,
      imports: asyncOptions.imports || [],
      providers: [
        ...asyncProviders,
        {
          provide: CACHE_MANAGER,
          useFactory: (cache: any) => new TriCacheStore(cache as CacheService),
          inject: [TRICACHE_SERVICE],
        },
        ...(asyncOptions.extraProviders || []),
      ],
      exports: [TRICACHE_SERVICE, CACHE_MANAGER],
    };
  }

  private static createAsyncProviders(options: TriCacheAsyncOptions): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)];
    }

    if (options.useClass) {
      return [
        this.createAsyncOptionsProvider(options),
        {
          provide: options.useClass,
          useClass: options.useClass,
        },
      ];
    }

    return [];
  }

  private static createAsyncOptionsProvider(options: TriCacheAsyncOptions): Provider {
    if (options.useFactory) {
      return {
        provide: TRICACHE_SERVICE,
        useFactory: async (...args: any[]) => {
          const cacheOptions = await options.useFactory!(...args);
          return CacheService.create(cacheOptions);
        },
        inject: options.inject || [],
      };
    }

    const injectToken = options.useExisting || options.useClass!;
    return {
      provide: TRICACHE_SERVICE,
      useFactory: async (optionsFactory: any) => {
        const cacheOptions = await (optionsFactory as TriCacheOptionsFactory).createTriCacheOptions();
        return CacheService.create(cacheOptions);
      },
      inject: [injectToken],
    };
  }
}
