# TriCache NestJS Microservice Demo

Minimal NestJS 11 TypeScript app that uses the official [`tricache/nestjs`](https://kareem411.github.io/TriCache/integrations/nestjs) entry:

| Surface | What to look for |
|---|---|
| `TriCacheModule.register({ ... })` | Wired in `AppModule` with in-process L1 options (Redis optional) |
| `@Cacheable({ ttl: 120, tags: ['items'] })` | `GET /items` and `GET /items/:id` reuse `computedAt` + `originReads` |
| `@CacheEvict({ tags: ['items'] })` | `POST` / `PATCH` / `DELETE` invalidate the `items` tag |
| `CACHE_MANAGER` / `TriCacheStore` | `PUT`/`GET`/`DELETE /store/notes/:id` — Nest cache-manager store contract |

The published decorator option is **`ttl` (seconds by default)**, plus optional `ttlUnit`. It is not `ttlSeconds` / `ttlSec`. Decorators resolve the engine from `this.cacheService` / `this.cache` / `this.cacheStore.cache`, so `ItemsService` injects `TRICACHE_SERVICE` onto `cacheService`.

Origin work is a simulated **250ms** catalog read. Cache hits replay the stored JSON and skip that delay.

Redis is not required. The demo uses an in-process L1 cache (`disableRedis: true`, `disableDisk: true`) unless `REDIS_HOST` is set.

---

## Run locally

From the **repository root**, build the local `tricache` package (the example links to `../..`):

```bash
pnpm install
pnpm build
```

Then start the demo:

```bash
cd examples/nestjs-microservice
pnpm install
pnpm dev
```

`pnpm start` is the same command. The process listens on `http://127.0.0.1:3000`. Override with `PORT` / `HOST` / `ORIGIN_LATENCY_MS`. Optional L2: `REDIS_HOST` / `REDIS_PORT`.

If you installed `tricache` from npm instead of the repo link, `node --import tsx src/main.ts` (or `pnpm dev`) is enough — no root build step.

---

## Try it with `curl`

Keep the server running in another terminal.

### 1. Cold miss — `@Cacheable`

```bash
curl -s 'http://127.0.0.1:3000/items/1'
```

Expect `originReads: 1`, a `computedAt` timestamp, and ~250ms. The service method ran.

### 2. Repeat GET — cache hit

```bash
curl -s 'http://127.0.0.1:3000/items/1'
```

Expect the **same** `computedAt` and `originReads: 1`, and a much faster response. `@Cacheable` served `item:1` from TriCache.

`GET /items` is a second key (`items:list`) with the same `items` tag.

### 3. Mutation — `@CacheEvict({ tags: ['items'] })`

```bash
curl -s -X PATCH 'http://127.0.0.1:3000/items/1' \
  -H 'content-type: application/json' \
  -d '{"name":"Ortho Keyboard","price":149}'
```

Expect `evictedTags: ["items"]`.

### 4. GET after eviction — miss and refill

```bash
curl -s 'http://127.0.0.1:3000/items/1'
```

Expect a **new** `computedAt`, `originReads: 2` (or higher if you also fetched the list), and `data.name: "Ortho Keyboard"`.

`GET /items` also misses — tag invalidation drops every key tagged `items`.

### 5. `@nestjs/cache-manager` store (`CACHE_MANAGER` → `TriCacheStore`)

`set` / `ttl` use **milliseconds**, matching cache-manager v5/v6:

```bash
curl -s 'http://127.0.0.1:3000/store/notes/n1'
# {"key":"note:n1","note":null,"cache":"miss"}

curl -s -X PUT 'http://127.0.0.1:3000/store/notes/n1' \
  -H 'content-type: application/json' \
  -d '{"body":"session-token","ttlMs":60000}'

curl -s 'http://127.0.0.1:3000/store/notes/n1'
# {"cache":"hit","note":{"id":"n1","body":"session-token",...},"ttlMs":...}

curl -s -X DELETE 'http://127.0.0.1:3000/store/notes/n1'
curl -s 'http://127.0.0.1:3000/store/notes/n1'
# {"cache":"miss"}
```

`GET /store/keys` lists keys currently resident in `TriCacheStore`.

---

## Automated check

```bash
pnpm verify
```

Starts the server on port `34568` and asserts cacheable hit/miss, tag eviction, and the store read/write path.

```bash
pnpm typecheck
```

---

## How the module is wired

```typescript
import { Module } from '@nestjs/common';
import { TriCacheModule } from 'tricache/nestjs';

@Module({
  imports: [
    TriCacheModule.register({
      namespace: 'nestjs-microservice-demo',
      disableRedis: true,
      disableDisk: true,
      invalidationBackplane: false,
    }),
  ],
})
export class AppModule {}
```

`register()` accepts `CacheOptions` and calls `CacheService.create(options)`. The dynamic module is always `global: true` and exports:

`tricache/nestjs` types a structural `DynamicModule` so `@nestjs/common` can stay an optional peer. The example casts that object to Nest's `DynamicModule` at the `AppModule` boundary — runtime shape is unchanged.

- `TRICACHE_SERVICE` — `CacheService` instance
- `CACHE_MANAGER` — `TriCacheStore` (same token string as `@nestjs/cache-manager`)

```typescript
@Inject(TRICACHE_SERVICE) readonly cacheService: CacheService
@Inject(CACHE_MANAGER) readonly cacheStore: TriCacheStore
```

```typescript
@Cacheable({ key: (id: string) => `item:${id}`, ttl: 120, ttlUnit: 'seconds', tags: ['items'] })
async findOne(id: string) { /* origin read */ }

@CacheEvict({ tags: ['items'] })
async update(id: string, patch: ItemMutation) { /* mutation */ }

await this.cacheStore.set('note:n1', note, 60_000); // milliseconds
await this.cacheStore.get('note:n1');
```

`registerAsync({ useFactory, inject })` is available for `ConfigService`; this demo uses `register()` so it runs without extra Nest config modules.
