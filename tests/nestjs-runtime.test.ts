import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Controller, Get, Inject, Injectable, Module, type DynamicModule, type INestApplicationContext } from '@nestjs/common';
import { APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { CACHE_MANAGER as NATIVE_CACHE_MANAGER, CacheInterceptor, CacheModule, CacheTTL } from '@nestjs/cache-manager';
import { type Cache } from 'cache-manager';
import Keyv from 'keyv';
import { CacheService } from '../src/cache-service.js';
import type { CacheOptions } from '../src/types.js';
import { Cacheable, CacheEvict, CACHE_MANAGER, TRICACHE_SERVICE, TriCacheKeyvAdapter, TriCacheModule, TriCacheStore } from '../src/nestjs/index.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const options = (namespace = randomUUID()): CacheOptions => ({ namespace, disableRedis: true, disableDisk: true,
  invalidationBackplane: false, oomProtection: false, compression: 'none', logger });
const contexts: INestApplicationContext[] = [];
const engines: CacheService[] = [];

function apply(target: object, name: string, decorator: MethodDecorator): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, name)!;
  Object.defineProperty(target, name, decorator(target, name, descriptor) || descriptor);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(contexts.splice(0).map(context => context.close()));
  await Promise.all(engines.splice(0).map(engine => engine.destroy()));
});

describe('Actual NestJS 12 application compatibility', () => {
  it('accepts the module without casts and injects the engine, facade, and decorated service', async () => {
    const dynamic: DynamicModule = TriCacheModule.register(options());
    expect(CACHE_MANAGER).toBe(NATIVE_CACHE_MANAGER);
    class Catalog {
      reads = 0;
      constructor(readonly cacheService: CacheService) {}
      async read(id: string) { return { id, reads: ++this.reads }; }
      async update() { return 'updated'; }
    }
    Injectable()(Catalog);
    Inject(TRICACHE_SERVICE)(Catalog, undefined, 0);
    apply(Catalog.prototype, 'read', Cacheable({ key: id => `item:${id}`, ttl: 5000, ttlUnit: 'seconds', tags: ['items'] }));
    apply(Catalog.prototype, 'update', CacheEvict({ tags: ['items'] }));
    class Application {}
    Module({ imports: [dynamic], providers: [Catalog] })(Application);
    const context = await NestFactory.createApplicationContext(Application, { logger: false, abortOnError: false });
    contexts.push(context);
    const engine = context.get<CacheService>(TRICACHE_SERVICE);
    engines.push(engine);
    expect(context.get(CACHE_MANAGER)).toBeInstanceOf(TriCacheStore);
    const service = context.get(Catalog);
    expect(await service.read('1')).toEqual({ id: '1', reads: 1 });
    expect(await service.read('1')).toEqual({ id: '1', reads: 1 });
    await service.update();
    expect(await service.read('1')).toEqual({ id: '1', reads: 2 });
  });

  it.each(['useFactory', 'useClass', 'useExisting'] as const)('resolves real %s dependency injection', async mode => {
    const CONFIG = Symbol('configuration');
    const EXISTING = Symbol('existing-factory');
    const config = { namespace: randomUUID() };
    type Configuration = typeof config;
    class OptionsFactory {
      constructor(readonly configuration: Configuration) {}
      createTriCacheOptions() { return options(this.configuration.namespace); }
    }
    Injectable()(OptionsFactory);
    Inject(CONFIG)(OptionsFactory, undefined, 0);
    class ConfigurationModule {}
    Module({ providers: [{ provide: CONFIG, useValue: config }, { provide: EXISTING, useClass: OptionsFactory }],
      exports: [CONFIG, EXISTING] })(ConfigurationModule);
    const setup = mode === 'useFactory' ? { useFactory: (value: typeof config) => options(value.namespace), inject: [CONFIG] }
      : mode === 'useClass' ? { useClass: OptionsFactory } : { useExisting: EXISTING };
    const dynamic: DynamicModule = TriCacheModule.registerAsync({ imports: [ConfigurationModule], ...setup });
    class Application {}
    Module({ imports: [dynamic] })(Application);
    const context = await NestFactory.createApplicationContext(Application, { logger: false, abortOnError: false });
    contexts.push(context);
    const engine = context.get<CacheService>(TRICACHE_SERVICE);
    engines.push(engine);
    expect(engine.options.namespace).toBe(config.namespace);
    expect(context.get<TriCacheStore>(CACHE_MANAGER).cache).toBe(engine);
  });

  it('preserves explicit sub-second decorator TTLs', async () => {
    const engine = new CacheService(options());
    engines.push(engine);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    class Catalog {
      cacheService = engine;
      reads = 0;
      async read() { return ++this.reads; }
    }
    apply(Catalog.prototype, 'read', Cacheable({ key: 'short', ttl: 100, ttlUnit: 'milliseconds' }));
    const service = new Catalog();
    expect(await service.read()).toBe(1);
    expect(await service.read()).toBe(1);
    now += 101;
    expect(await service.read()).toBe(2);
  });

  it('runs Nest CacheModule, cache-manager 7 wrap/batches/TTL, and namespace isolation through Keyv', async () => {
    const engineOptions = options();
    const engine = CacheService.create(engineOptions);
    engines.push(engine);
    const adapter = new TriCacheKeyvAdapter(engine);
    const keyv = new Keyv({ store: adapter, namespace: 'runtime' });
    class Application {}
    const triCacheModule = TriCacheModule.register(engineOptions, { provideCacheManager: false });
    expect(triCacheModule.exports).toEqual([TRICACHE_SERVICE]);
    Module({ imports: [triCacheModule, CacheModule.register({ stores: [keyv], ttl: 5000 })] })(Application);
    const context = await NestFactory.createApplicationContext(Application, { logger: false, abortOnError: false });
    contexts.push(context);
    const cache = context.get<Cache>(NATIVE_CACHE_MANAGER);
    const fetch = vi.fn(async () => ({ version: 1 }));
    expect(await cache.wrap('item', fetch, 1000)).toEqual({ version: 1 });
    expect(await cache.wrap('item', fetch, 1000)).toEqual({ version: 1 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(await cache.ttl('item')).toBeGreaterThan(Date.now());
    await cache.mset([{ key: 'a', value: 1, ttl: 5000 }, { key: 'b', value: 2, ttl: 5000 }]);
    expect(await cache.mget(['a', 'b', 'missing'])).toEqual([1, 2, undefined]);
    await cache.mdel(['a']);
    expect(await cache.get('a')).toBeUndefined();
    const peer = new Keyv({ store: new TriCacheKeyvAdapter(engine), namespace: 'runtime-peer' });
    await peer.set('item', 'peer', 5000);
    await cache.clear();
    expect(await cache.get('item')).toBeUndefined();
    expect(await peer.get('item')).toBe('peer');
    await peer.disconnect();
    await context.close();
    await engine.set('caller-owned', 'still active');
    expect(engine.getIfFresh('caller-owned')).toBe('still active');
  });

  it('exercises the Nest 12 CacheInterceptor against TriCacheModule CACHE_MANAGER over HTTP', async () => {
    const dynamic: DynamicModule = TriCacheModule.register(options());
    let calls = 0;
    class Endpoint {
      getValue() { return { calls: ++calls }; }
    }
    Controller('native-cache')(Endpoint);
    apply(Endpoint.prototype, 'getValue', Get());
    apply(Endpoint.prototype, 'getValue', CacheTTL(500));
    class Application {}
    Module({ imports: [dynamic], controllers: [Endpoint],
      providers: [{ provide: APP_INTERCEPTOR, useClass: CacheInterceptor }] })(Application);
    const app = await NestFactory.create(Application, { logger: false, abortOnError: false });
    contexts.push(app);
    engines.push(app.get<CacheService>(TRICACHE_SERVICE));
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/native-cache`;
    expect(await (await fetch(url)).json()).toEqual({ calls: 1 });
    expect(await (await fetch(url)).json()).toEqual({ calls: 1 });
    expect(calls).toBe(1);
  });

  it('serves real HTTP cache hits/expiry and excludes streamed replies with the native interceptor', async () => {
    const dynamic: DynamicModule = TriCacheModule.register(options());
    class Endpoint {
      reads = 0;
      streams = 0;
      read() { return { reads: ++this.reads }; }
      stream() {
        const run = ++this.streams;
        return (async function* () { yield { run, chunk: 1 }; yield { run, chunk: 2 }; })();
      }
    }
    Controller('probe')(Endpoint);
    apply(Endpoint.prototype, 'read', Get());
    apply(Endpoint.prototype, 'read', CacheTTL(500));
    apply(Endpoint.prototype, 'stream', Get('stream'));
    class Application {}
    Module({ imports: [dynamic], controllers: [Endpoint], providers: [{ provide: APP_INTERCEPTOR, useClass: CacheInterceptor }] })(Application);
    const app = await NestFactory.create(Application, { logger: false, abortOnError: false });
    contexts.push(app);
    engines.push(app.get<CacheService>(TRICACHE_SERVICE));
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    const base = `http://127.0.0.1:${address.port}/probe`;
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const first = await fetch(base);
    expect(first.headers.get('x-cache')).toBe('MISS');
    expect(await first.json()).toEqual({ reads: 1 });
    const hit = await fetch(base);
    expect(hit.headers.get('x-cache')).toBe('HIT');
    expect(await hit.json()).toEqual({ reads: 1 });
    now += 501;
    expect(await (await fetch(base)).json()).toEqual({ reads: 2 });
    for (const run of [1, 2]) {
      const response = await fetch(`${base}/stream`);
      expect(response.status).toBe(200);
      expect((await response.text()).trim().split('\n').map(line => JSON.parse(line)))
        .toEqual([{ run, chunk: 1 }, { run, chunk: 2 }]);
    }
    expect(await app.get<TriCacheStore>(CACHE_MANAGER).get('/probe/stream')).toBeUndefined();
  });
});
