import { createNextCacheHandler } from "tricache/next";
import type { CacheHandler } from "next/cache";

const Handler = createNextCacheHandler({
    namespace: "nextjs-demo",
    tagStrategy: "generational",
    backplaneMode: "stream",
    redisHost: process.env.REDIS_HOST,
    disableRedis: !process.env.REDIS_HOST,
    encryptionKey: process.env.TRICACHE_ENCRYPTION_KEY,
    maxStreamBytes: 16 * 1024 * 1024,
});

/**
 * cacheHandlers (plural) expects a handler *instance* with get/set methods.
 * cacheHandler (singular) expects a *class* — don't use the same export for both.
 */
export default new Handler() satisfies CacheHandler;
