import { CacheService } from '../cache-service';
import type {
  IncrementalCacheEntry,
  IncrementalCacheValue,
  NextCacheHandlerOptions,
} from './types';

/**
 * Legacy Next.js 15/16 ISR `cacheHandler` implementation for Route Handlers and ISR pages.
 *
 * Implements the 4-method contract: `get`, `set`, `revalidateTag`, `resetRequestCache`.
 */
export class TriCacheISRHandler {
  protected readonly cache: CacheService;
  protected readonly requestCache = new Map<string, IncrementalCacheEntry | null>();

  constructor(options: NextCacheHandlerOptions = {}) {
    const isBuildPhase =
      options.isBuildPhase ??
      (typeof process !== 'undefined' &&
        (process.env.NEXT_PHASE === 'phase-production-build' ||
          process.env.NEXT_PHASE === 'phase-export'));

    this.cache = CacheService.create({
      ...options,
      namespace: options.namespace ?? 'next-isr',
      tagStrategy: options.tagStrategy ?? 'generational',
      cloneStrategy: options.cloneStrategy ?? 'none',
      disableRedis: isBuildPhase ? true : options.disableRedis,
    });
  }

  /**
   * Read an entry from the cache. Checks the in-memory requestCache first before querying TriCache.
   */
  async get(key: string): Promise<IncrementalCacheEntry | null> {
    if (this.requestCache.has(key)) {
      return this.requestCache.get(key) ?? null;
    }

    const stored = await this.cache.get<IncrementalCacheEntry | null>(
      key,
      async () => null,
    );

    if (stored) {
      this.requestCache.set(key, stored);
      return stored;
    }

    return null;
  }

  /**
   * Set an entry in the cache.
   */
  async set(
    key: string,
    data: IncrementalCacheValue | null,
    ctx?: { tags?: string[]; revalidate?: number | false },
  ): Promise<void> {
    if (!data) return;

    let ttl: number;
    if (typeof ctx?.revalidate === 'number') {
      if (ctx.revalidate <= 0) return; // Do not cache dynamic 0s responses
      ttl = ctx.revalidate;
    } else if (ctx?.revalidate === false) {
      ttl = 31_536_000; // 1 year for static indefinite assets
    } else {
      ttl = 300; // fallback default
    }

    const entry: IncrementalCacheEntry = {
      curRevalidate: ctx?.revalidate,
      revalidateAfter: typeof ctx?.revalidate === 'number' ? Date.now() + ctx.revalidate * 1000 : false,
      isStale: false,
      value: data,
    };

    this.requestCache.set(key, entry);

    const tags = ctx?.tags;
    await this.cache.set(key, entry, ttl, undefined, tags?.length ? { tags } : undefined);
  }

  /**
   * Revalidate all entries associated with a tag.
   * Supports Next.js 16's cacheLife parameter ('max', 'hours', 'days').
   */
  async revalidateTag(tag: string, _cacheLife?: string): Promise<void> {
    if (!tag) return;
    this.requestCache.clear();
    await this.cache.invalidateTag(tag);
  }

  /**
   * Reset request-scoped in-memory cache at the beginning/end of each request.
   */
  resetRequestCache(): void {
    this.requestCache.clear();
  }
}

export default TriCacheISRHandler;
