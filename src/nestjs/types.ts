import type { CacheOptions } from '../index.js';

export const TRICACHE_SERVICE = 'TRICACHE_SERVICE';
export const CACHE_MANAGER = 'CACHE_MANAGER';

export type InjectionToken = string | symbol | Function | Type<any>;

export interface Type<T = unknown> extends Function {
  new (...args: any[]): T;
}

export interface ForwardReference<T = unknown> {
  forwardRef: () => T;
}

export interface Abstract<T> extends Function {
  prototype: T;
}

export interface ValueProvider<T = unknown> {
  provide: InjectionToken;
  useValue: T;
}

export interface ClassProvider<T = unknown> {
  provide: InjectionToken;
  useClass: Type<T>;
  scope?: 0 | 1 | 2;
  durable?: boolean;
}

export interface ExistingProvider {
  provide: InjectionToken;
  useExisting: InjectionToken;
}

export interface FactoryProvider<T = unknown> {
  provide: InjectionToken;
  useFactory: (...args: any[]) => T | Promise<T>;
  inject?: Array<InjectionToken | { token: InjectionToken; optional: boolean }>;
  scope?: 0 | 1 | 2;
  durable?: boolean;
}

export type Provider<T = unknown> =
  | Type<unknown>
  | ValueProvider<T>
  | ClassProvider<T>
  | ExistingProvider
  | FactoryProvider<T>;

export interface DynamicModule {
  module: Type<any>;
  providers?: Provider[];
  exports?: Array<DynamicModule | string | symbol | Provider | ForwardReference | Abstract<any> | Function>;
  imports?: Array<Type<any> | DynamicModule | ForwardReference>;
  controllers?: Type<any>[];
  global?: boolean;
}

export interface TriCacheOptionsFactory {
  createTriCacheOptions(): Promise<CacheOptions> | CacheOptions;
}

export interface TriCacheAsyncOptions {
  imports?: Array<Type<any> | DynamicModule | ForwardReference>;
  useExisting?: InjectionToken;
  useClass?: Type<TriCacheOptionsFactory>;
  useFactory?: (...args: any[]) => Promise<CacheOptions> | CacheOptions;
  inject?: Array<InjectionToken | { token: InjectionToken; optional: boolean }>;
  extraProviders?: Provider[];
  /** Whether to bind CACHE_MANAGER to TriCacheStore. Default: true. */
  provideCacheManager?: boolean;
}

export interface TriCacheModuleOptions {
  /** Set false when importing @nestjs/cache-manager CacheModule in the same application. Default: true. */
  provideCacheManager?: boolean;
}

export interface NestCacheStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttl?: number): Promise<T>;
  del(key: string): Promise<boolean>;
  reset(): Promise<boolean>;
  mget<T>(keys: string[]): Promise<(T | undefined)[]>;
  mget<T>(...keys: string[]): Promise<(T | undefined)[]>;
  mset(entries: Array<{ key: string; value: unknown; ttl?: number }>): Promise<Array<{ key: string; value: unknown; ttl?: number }>>;
  mdel(keys: string[]): Promise<boolean>;
  mdel(...keys: string[]): Promise<boolean>;
  keys(pattern?: string): Promise<string[]>;
  ttl(key: string): Promise<number | undefined>;
}
