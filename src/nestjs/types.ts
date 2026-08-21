import type { CacheOptions } from '../index.js';

export const TRICACHE_SERVICE = 'TRICACHE_SERVICE';
export const CACHE_MANAGER = 'CACHE_MANAGER';

export type InjectionToken = string | symbol | Function | Type<unknown>;

export interface Type<T = unknown> extends Function {
  new (...args: unknown[]): T;
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
}

export interface ExistingProvider {
  provide: InjectionToken;
  useExisting: InjectionToken;
}

export interface FactoryProvider<T = unknown> {
  provide: InjectionToken;
  useFactory: (...args: any[]) => T | Promise<T>;
  inject?: Array<InjectionToken | any>;
}

export type Provider<T = unknown> =
  | Type<unknown>
  | ValueProvider<T>
  | ClassProvider<T>
  | ExistingProvider
  | FactoryProvider<T>;

export interface DynamicModule {
  module: Type<unknown>;
  providers?: Provider[];
  exports?: Array<DynamicModule | Promise<DynamicModule> | string | symbol | Provider | Function | unknown>;
  imports?: Array<Type<unknown> | DynamicModule | Promise<DynamicModule> | ForwardReference>;
  global?: boolean;
}

export interface TriCacheOptionsFactory {
  createTriCacheOptions(): Promise<CacheOptions> | CacheOptions;
}

export interface TriCacheAsyncOptions {
  imports?: Array<Type<unknown> | DynamicModule | Promise<DynamicModule> | ForwardReference>;
  useExisting?: Type<TriCacheOptionsFactory>;
  useClass?: Type<TriCacheOptionsFactory>;
  useFactory?: (...args: unknown[]) => Promise<CacheOptions> | CacheOptions;
  inject?: Array<InjectionToken | unknown>;
  extraProviders?: Provider[];
}

export interface NestCacheStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttl?: number): Promise<void>;
  del(key: string): Promise<void>;
  reset(): Promise<void>;
  mget<T>(...keys: string[]): Promise<(T | undefined)[]>;
  mset(entries: Array<{ key: string; value: unknown; ttl?: number }>): Promise<void>;
  mdel(...keys: string[]): Promise<void>;
  keys(pattern?: string): Promise<string[]>;
  ttl(key: string): Promise<number | undefined>;
}
