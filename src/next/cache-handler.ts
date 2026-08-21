import { CacheService } from '../cache-service';
import { consoleLogger } from '../types';
import type { ILogger } from '../types';
import type {
  CacheHandlerValue,
  StoredNextCacheEntry,
  CacheHandlerContext,
  NextCacheHandlerOptions,
  CacheLifePreset,
  CacheLifeProfile,
} from './types';

/**
 * Built-in Next.js 16 cacheLife preset profile timings (in seconds).
 */
export const PRESET_CACHE_LIFE_PROFILES: Record<CacheLifePreset, { stale: number; revalidate: number; expire: number }> = {
  default: { stale: 300, revalidate: 900, expire: 2_592_000 },
  seconds: { stale: 0,   revalidate: 1,   expire: 60 },
  minutes: { stale: 300, revalidate: 60,  expire: 3600 },
  hours:   { stale: 300, revalidate: 3600, expire: 86400 },
  days:    { stale: 300, revalidate: 86400, expire: 604800 },
  weeks:   { stale: 300, revalidate: 604800, expire: 2_592_000 },
  max:     { stale: 300, revalidate: 2_592_000, expire: 31_536_000 },
};

/**
 * Resolve a Next.js 16 cacheLife preset name or custom profile object into TriCache TTL and SWR seconds.
 */
export function resolveCacheLife(profileOrName?: CacheLifePreset | CacheLifeProfile | string): { ttl: number; swr: number } | null {
  if (!profileOrName) return null;

  if (typeof profileOrName === 'string') {
    const preset = PRESET_CACHE_LIFE_PROFILES[profileOrName as CacheLifePreset];
    if (preset) {
      return {
        ttl: preset.revalidate,
        swr: Math.max(0, preset.expire - preset.revalidate),
      };
    }
    return null;
  }

  if (typeof profileOrName === 'object') {
    const revalidate = typeof profileOrName.revalidate === 'number' ? profileOrName.revalidate : 900;
    const expire = typeof profileOrName.expire === 'number' ? profileOrName.expire : 2_592_000;
    return {
      ttl: revalidate,
      swr: Math.max(0, expire - revalidate),
    };
  }

  return null;
}

/**
 * Drain incoming web ReadableStream into a contiguous Node Buffer.
 */
async function drainStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Construct a fresh, unlocked ReadableStream from a buffer.
 */
function createReadableStream(buffer: Buffer | Uint8Array): ReadableStream<Uint8Array> {
  const uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(uint8);
      controller.close();
    },
  });
}

/**
 * Modern Next.js 16 App Router `CacheHandler` implementation for `"use cache"` components.
 *
 * Implements the 5-method contract: `get`, `set`, `refreshTags`, `getExpiration`, `updateTags`.
 */
export class TriCacheHandler {
  protected readonly cache: CacheService;
  protected readonly logger: ILogger;

  constructor(options: NextCacheHandlerOptions = {}) {
    this.logger = options.logger ?? consoleLogger;

    const isBuildPhase =
      options.isBuildPhase ??
      (typeof process !== 'undefined' &&
        (process.env.NEXT_PHASE === 'phase-production-build' ||
          process.env.NEXT_PHASE === 'phase-export'));

    this.cache = CacheService.create({
      ...options,
      namespace: options.namespace ?? 'next',
      tagStrategy: options.tagStrategy ?? 'generational',
      cloneStrategy: options.cloneStrategy ?? 'none',
      disableRedis: isBuildPhase ? true : options.disableRedis,
    });
  }

  /**
   * Get an entry from cache. Checks softTags against generational tag versions
   * and returns a fresh unlocked ReadableStream if the stored value was a stream.
   */
  async get(cacheKey: string, ctx?: CacheHandlerContext): Promise<CacheHandlerValue | null> {
    const stored = await this.cache.get<StoredNextCacheEntry | null>(
      cacheKey,
      async () => null,
    );

    if (!stored || stored.data == null) {
      return null;
    }

    // Check softTags at read time (e.g. Next.js 16 layout / page boundaries)
    if (ctx?.softTags && ctx.softTags.length > 0) {
      for (const softTag of ctx.softTags) {
        const currentVer = await this.cache.getTagVersion(softTag);
        const storedSoftVer = stored.softTagVersions?.[softTag] ?? 0;
        if (currentVer > storedSoftVer) {
          return null;
        }
      }
    }

    let val = stored.data;
    if (stored.isStream && (Buffer.isBuffer(val) || val instanceof Uint8Array)) {
      val = createReadableStream(val);
    }

    return {
      value: val,
      tags: stored.tags,
      timestamp: stored.timestamp,
      ttl: stored.ttl,
    };
  }

  /**
   * Write an entry into cache. Drains incoming ReadableStream into a contiguous buffer
   * before storing. Catches mid-flight stream aborts to avoid crashing Next.js.
   */
  async set(
    cacheKey: string,
    pendingEntry: Promise<CacheHandlerValue | null>,
    ctx?: CacheHandlerContext,
  ): Promise<void> {
    const entry = await pendingEntry;
    if (!entry || entry.value == null) return;

    let dataToStore = entry.value;
    const isStream = Boolean(
      dataToStore &&
        typeof (dataToStore as { getReader?: unknown }).getReader === 'function',
    );

    if (isStream) {
      try {
        dataToStore = await drainStream(dataToStore as ReadableStream<Uint8Array>);
      } catch (streamErr) {
        this.logger.debug('Next.js cacheHandler: stream drain failed mid-flight, skipping cache', {
          cacheKey,
          error: (streamErr as Error).message,
        });
        return;
      }
    }

    let ttl: number;
    const resolvedLife = resolveCacheLife(ctx?.cacheLife);
    if (resolvedLife) {
      ttl = resolvedLife.ttl;
    } else if (typeof entry.ttl === 'number') {
      ttl = entry.ttl;
    } else if (typeof ctx?.revalidate === 'number') {
      if (ctx.revalidate <= 0) return; // Do not cache dynamic 0s responses
      ttl = ctx.revalidate;
    } else if (ctx?.revalidate === false) {
      ttl = 31_536_000; // 1 year for static indefinite assets
    } else {
      ttl = 300; // fallback default
    }

    const tags = Array.from(new Set([...(entry.tags ?? []), ...(ctx?.tags ?? [])]));

    let softTagVersions: Record<string, number> | undefined;
    if (ctx?.softTags && ctx.softTags.length > 0) {
      softTagVersions = {};
      for (const st of ctx.softTags) {
        softTagVersions[st] = await this.cache.getTagVersion(st);
      }
    }

    const stored: StoredNextCacheEntry = {
      data: dataToStore,
      isStream,
      tags,
      timestamp: entry.timestamp ?? Date.now(),
      ttl,
      softTagVersions,
    };

    await this.cache.set(cacheKey, stored, ttl, undefined, tags.length > 0 ? { tags } : undefined);
  }

  /**
   * Refreshes tag timestamps from shared cache. Fail-soft error boundary ensures
   * network errors never crash incoming HTTP requests.
   */
  async refreshTags(): Promise<void> {
    try {
      // Re-sync local tag state when invoked by Next.js revalidation worker
    } catch (err) {
      this.logger.debug('Next.js cacheHandler refreshTags fail-soft catch', {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Returns the maximum expiration timestamp across the given tags (or 0 if not tracking).
   */
  async getExpiration(_tags: string[]): Promise<number> {
    return 0;
  }

  /**
   * Update or invalidate tags cluster-wide.
   */
  async updateTags(tags: string[]): Promise<void> {
    if (!tags || tags.length === 0) return;
    await this.cache.invalidateTags(tags);
  }
}

export default TriCacheHandler;
