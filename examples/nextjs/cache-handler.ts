import { createNextCacheHandler } from "tricache/next";
import type { CacheHandlerValue } from "tricache/next";

const Handler = createNextCacheHandler({
    namespace: "nextjs-demo",
    tagStrategy: "generational",
    backplaneMode: "stream",
    encryptionKey: "demo-key-0123456789012345678901234567123412",
});

const handler = new Handler();

/**
 * cacheHandlers (plural) expects a handler *instance* with get/set methods.
 * cacheHandler (singular) expects a *class* — don't use the same export for both.
 */
export default {
    get(cacheKey: string, softTags: string[]) {
        return handler.get(cacheKey, { softTags });
    },
    set(cacheKey: string, pendingEntry: Promise<CacheHandlerValue | null>): Promise<void> {
        return handler.set(cacheKey, pendingEntry);
    },
    refreshTags() {
        return handler.refreshTags();
    },
    getExpiration(tags: string[]) {
        return handler.getExpiration(tags);
    },
    updateTags(tags: string[], durations?: { expire?: number }) {
        return handler.updateTags(tags);
    },
};