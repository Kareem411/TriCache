# NestJS Dynamic Module & Decorators

> Package entry: `tricache/nestjs`

TriCache provides an official NestJS dynamic module (`TriCacheModule`) and declarative method decorators (`@Cacheable`, `@CacheEvict`) for high-concurrency NestJS microservices.

### Ready-to-run NestJS 11 demo

A self-contained microservice lives at [`examples/nestjs-microservice`](https://github.com/Kareem411/TriCache/tree/main/examples/nestjs-microservice). It exercises `TriCacheModule.register()`, `@Cacheable({ ttl, tags })`, `@CacheEvict({ tags })`, and the exported `CACHE_MANAGER` / `TriCacheStore` cache-manager adapter.

```bash
pnpm install && pnpm build
cd examples/nestjs-microservice
pnpm install
pnpm dev
```

Then follow the curl walkthrough in that README (`GET /items/:id` hit vs `PATCH` eviction, plus `PUT`/`GET /store/notes/:id`).

---

## Installation & Module Registration

`TriCacheModule.register(options)` forwards `options` to `CacheService.create()` (`CacheOptions`). The dynamic module is always registered as `global: true` and exports `TRICACHE_SERVICE` (`CacheService`) plus `CACHE_MANAGER` (`TriCacheStore`). There is no `preset` or `isGlobal` field on this options object.

### Synchronous Registration

In your root `AppModule`:

```typescript
import { Module } from '@nestjs/common';
import { TriCacheModule } from 'tricache/nestjs';

@Module({
  imports: [
    TriCacheModule.register({
      namespace: 'orders-service',
      redisHost: process.env.REDIS_HOST,
      redisPort: Number(process.env.REDIS_PORT ?? 6379),
      disableRedis: !process.env.REDIS_HOST,
    }),
  ],
})
export class AppModule {}
```

### Asynchronous Registration (with `ConfigService`)

For injecting runtime environment variables:

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TriCacheModule } from 'tricache/nestjs';

@Module({
  imports: [
    TriCacheModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        namespace: 'orders-service',
        redisHost: config.get<string>('REDIS_HOST'),
        redisPort: config.get<number>('REDIS_PORT') ?? 6379,
        disableRedis: !config.get<string>('REDIS_HOST'),
      }),
    }),
  ],
})
export class AppModule {}
```

---

## Declarative Method Decorators

### `@Cacheable`
Automatically caches method return values with Singleflight coalescing and SWR:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import type { CacheService } from 'tricache';
import { Cacheable, TRICACHE_SERVICE } from 'tricache/nestjs';

@Injectable()
export class UserService {
  constructor(
    @Inject(TRICACHE_SERVICE) readonly cacheService: CacheService,
    private readonly prisma: PrismaService,
  ) {}

  @Cacheable({
    key: (userId: string) => `user:${userId}`,
    ttl: 300,
    swr: 60,
    tags: ['users'],
  })
  async getUserById(userId: string) {
    return await this.prisma.user.findUnique({ where: { id: userId } });
  }
}
```

`ttl` is seconds by default (`ttlUnit?: 'seconds' | 'milliseconds'`). Decorators look up the engine on `this.cacheService`, `this.cache`, or `this.cacheStore.cache`.

### `@CacheEvict`
Evicts specific keys or tags upon mutation:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import type { CacheService } from 'tricache';
import { CacheEvict, TRICACHE_SERVICE } from 'tricache/nestjs';

@Injectable()
export class UserService {
  constructor(
    @Inject(TRICACHE_SERVICE) readonly cacheService: CacheService,
  ) {}

  @CacheEvict({
    key: (userId: string) => `user:${userId}`,
    tags: ['users'],
  })
  async updateUser(userId: string, data: UpdateUserDto) {
    return await this.prisma.user.update({ where: { id: userId }, data });
  }
}
```

---

## Direct `CacheService` Injection

Inject the `TRICACHE_SERVICE` token (the module does not bind the `CacheService` class itself):

```typescript
import { Inject, Injectable } from '@nestjs/common';
import type { CacheService } from 'tricache';
import { TRICACHE_SERVICE } from 'tricache/nestjs';

@Injectable()
export class OrderService {
  constructor(
    @Inject(TRICACHE_SERVICE) private readonly cache: CacheService,
  ) {}

  async processOrder(orderId: string) {
    return await this.cache.lock(`order:${orderId}`, async () => {
      // Critical transactional logic executed under distributed mutex
      return await this.executePayment(orderId);
    });
  }
}
```

## `@nestjs/cache-manager` store (`CACHE_MANAGER`)

`TriCacheModule` also exports `CACHE_MANAGER` bound to `TriCacheStore`. That adapter implements the cache-manager v5/v6 `CacheStore` contract (`get` / `set` / `del` / `reset`, plus `mget` / `mset` / `mdel` / `keys` / `ttl`). `set(key, value, ttl)` and `ttl(key)` use **milliseconds**.

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER, type TriCacheStore } from 'tricache/nestjs';

@Injectable()
export class SessionService {
  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheStore: TriCacheStore,
  ) {}

  async save(id: string, value: unknown) {
    await this.cacheStore.set(`session:${id}`, value, 60_000);
  }

  async load(id: string) {
    return this.cacheStore.get(`session:${id}`);
  }
}
```
