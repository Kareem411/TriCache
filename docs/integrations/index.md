# Framework & Ecosystem Integrations

TriCache provides first-party, zero-glue-code packages engineered for modern JavaScript and TypeScript frameworks, database ORMs, and edge runtimes.

---

## Ecosystem Packages

Explore the dedicated guides for your application stack:

<IntegrationGrid :hide-header="true" />

| Package | Entrypoint | Key Capabilities |
|:---|:---|:---|
| **[Next.js 16 & 15](/integrations/nextjs)** | `tricache/next` | Drop-in `cacheHandler`, React 19 RSC binary streaming, soft tags, zero V8 GC pauses. |
| **[NestJS Module](/integrations/nestjs)** | `tricache/nestjs` | Dynamic `TriCacheModule` (`register`/`registerAsync`), `@Cacheable` and `@CacheEvict` decorators. |
| **[Prisma ORM Extension](/integrations/prisma)** | `tricache/prisma` | `$extends(withTriCache())`, automatic mutation invalidation, deterministic query key hashing. |
| **[Drizzle ORM Wrapper](/integrations/drizzle)** | `tricache/drizzle` | `withCache(query)`, SQL + parameterized argument hashing, custom TTL and tag assignment. |
| **[Express, Fastify & Koa Middleware](/integrations/http)** | `tricache/http`, `tricache/koa` | Route caching middleware, weak ETag calculation, RFC 7232 `304 Not Modified` short-circuiting. |
| **[Edge Isolates (Workers)](/integrations/edge)** | `tricache/edge` | Universal zero-Node runtime for Cloudflare Workers, Fastly Compute, Web Crypto, WASM Bloom. |
| **[Visual Dashboard & CLI](/integrations/dashboard)** | `tricache/dashboard` | Real-time SSE Web UI, Next.js route handlers, standalone management server, CLI. |
