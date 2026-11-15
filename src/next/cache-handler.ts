import { CacheService } from '../cache-service';
import { CachePriority, consoleLogger } from '../types';
import type { ILogger } from '../types';
import type {
  CacheHandlerValue,
  NextCacheEntry,
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
async function drainStream(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        size += value.byteLength;
        if (size > maxBytes) throw new Error('RSC stream exceeds maxStreamBytes');
        chunks.push(Uint8Array.from(value));
      }
    }
    return Buffer.concat(chunks);
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Construct a fresh, unlocked ReadableStream from a buffer.
 */
function createReadableStream(buffer: Buffer | Uint8Array): ReadableStream<Uint8Array> {
  const uint8 = Uint8Array.from(buffer);
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
  private readonly maxStreamBytes: number;
  private readonly pendingSets = new Map<string, { token: symbol; completion: Promise<void> }>();
  private readonly observedTags = new Map<string, { version: number; observedAt: number }>();

  constructor(options: NextCacheHandlerOptions = {}) {
    this.logger = options.logger ?? consoleLogger;
    this.maxStreamBytes = options.maxStreamBytes ?? 16 * 1024 * 1024;
    if (!Number.isFinite(this.maxStreamBytes) || this.maxStreamBytes <= 0) throw new Error('maxStreamBytes must be finite and positive');
    if (options.tagStrategy && options.tagStrategy !== 'generational') throw new Error('Next.js cache handlers require tagStrategy: generational');

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
  async get(cacheKey: string, softTags: string[]): Promise<NextCacheEntry | undefined>;
  async get(cacheKey: string, ctx?: CacheHandlerContext): Promise<CacheHandlerValue | undefined>;
  async get(cacheKey: string, context?: CacheHandlerContext | string[]): Promise<CacheHandlerValue | undefined> {
    let pending = this.pendingSets.get(cacheKey);
    while (pending) {
      await pending.completion;
      pending = this.pendingSets.get(cacheKey);
    }
    const native = Array.isArray(context);
    const ctx = native ? { softTags: context } : context;
    const stored = await this.cache.peek<StoredNextCacheEntry>(cacheKey);

    if (!stored || stored.data == null) {
      return undefined;
    }

    const expire = stored.expire ?? stored.ttl;
    if (!Number.isFinite(stored.timestamp) || !Number.isFinite(expire) || Date.now() >= stored.timestamp + expire * 1000) return undefined;
    const tags = [...new Set([...stored.tags, ...ctx?.softTags ?? []])];
    const versions = await Promise.all(tags.map(tag => this.cache.getTagVersion(tag)));
    const states = await this.cache.mget<{ revalidatedAt: number; expiredAt?: number }>(tags.map(tag => `_next_tag_state_:${tag}`));
    let revalidate = stored.revalidate ?? stored.ttl;
    for (let index = 0; index < tags.length; index++) {
      const tag = tags[index];
      const state = states[index];
      const snapshot = stored.generations?.[tag] ?? stored.softTagVersions?.[tag];
      if (state && (state.revalidatedAt > stored.timestamp || state.revalidatedAt === stored.timestamp && snapshot !== versions[index])) {
        if (state.expiredAt !== undefined && state.expiredAt <= Date.now()) return undefined;
        revalidate = -1; // Next.js serves stale and computes a replacement in the background.
      } else if (!state && versions[index] > 0) {
        if (snapshot !== undefined && versions[index] > snapshot) return undefined;
        if (snapshot === undefined) {
          const observed = this.observeTag(tag, versions[index]);
          if (stored.timestamp <= observed) return undefined;
        }
      }
    }

    let val = stored.data;
    if (stored.isStream) {
      let bytes: Uint8Array;
      if (stored.streamEncoding === 'base64' && typeof val === 'string') {
        if (val.length > Math.ceil(this.maxStreamBytes / 3) * 4) return undefined;
        bytes = Buffer.from(val, 'base64');
      }
      else if (Buffer.isBuffer(val) || val instanceof Uint8Array) bytes = val;
      else if (val && typeof val === 'object' && (val as { type?: unknown }).type === 'Buffer' && Array.isArray((val as { data?: unknown }).data)) {
        bytes = Buffer.from((val as { data: number[] }).data);
      } else return undefined;
      if (bytes.length > this.maxStreamBytes) return undefined;
      val = createReadableStream(bytes);
    } else if (native) {
      return undefined; // Legacy plain-object entries are not native RSC CacheEntry streams.
    }

    return {
      value: val,
      tags: stored.tags,
      timestamp: stored.timestamp,
      ttl: stored.ttl,
      stale: stored.stale ?? 300,
      revalidate,
      expire,
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
    const token = Symbol(cacheKey);
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    this.pendingSets.set(cacheKey, { token, completion });
    try {
    const canCommit = this.cache.captureMutationFence(cacheKey);
    const entry = await pendingEntry;
    if (!entry || entry.value == null) return;
    const tags = Array.from(new Set([...(entry.tags ?? []), ...(ctx?.tags ?? [])]));
    const allTags = [...new Set([...tags, ...ctx?.softTags ?? []])];
    const initialVersions = Object.fromEntries(await Promise.all(allTags.map(async tag => [tag, await this.cache.getTagVersion(tag)])));

    let dataToStore = entry.value;
    const isStream = Boolean(
      dataToStore &&
        typeof (dataToStore as { getReader?: unknown }).getReader === 'function',
    );

    if (isStream) {
      try {
        dataToStore = (await drainStream(dataToStore as ReadableStream<Uint8Array>, this.maxStreamBytes)).toString('base64');
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
    } else if (typeof entry.revalidate === 'number') {
      ttl = entry.revalidate;
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

    const expire = entry.expire ?? (resolvedLife ? resolvedLife.ttl + resolvedLife.swr : ttl);
    const timestamp = entry.timestamp ?? Date.now();
    if (!Number.isFinite(expire) || expire <= 0 || !Number.isFinite(timestamp) || timestamp > Date.now() + (this.cache.options.clockSkewToleranceMs ?? 250)) return;
    const remaining = timestamp + expire * 1000 - Date.now();
    if (remaining <= 0 || !canCommit() || this.pendingSets.get(cacheKey)?.token !== token) return;
    const finalVersions = await Promise.all(allTags.map(tag => this.cache.getTagVersion(tag)));
    if (allTags.some((tag, index) => finalVersions[index] !== initialVersions[tag])) return;
    const tagStates = await this.cache.mget<{ revalidatedAt: number }>(allTags.map(tag => `_next_tag_state_:${tag}`));
    if (tagStates.some(state => state && state.revalidatedAt > timestamp)) return;

    let softTagVersions: Record<string, number> | undefined;
    if (ctx?.softTags && ctx.softTags.length > 0) {
      const softTags = ctx.softTags;
      const vers = await Promise.all(softTags.map(st => this.cache.getTagVersion(st)));
      softTagVersions = {};
      for (let i = 0; i < softTags.length; i++) {
        softTagVersions[softTags[i]] = vers[i];
      }
    }

    const stored: StoredNextCacheEntry = {
      data: dataToStore,
      isStream,
      tags,
      timestamp,
      ttl,
      softTagVersions,
      generations: initialVersions,
      stale: entry.stale ?? (typeof ctx?.cacheLife === 'string' ? PRESET_CACHE_LIFE_PROFILES[ctx.cacheLife as CacheLifePreset]?.stale : typeof ctx?.cacheLife === 'object' ? ctx.cacheLife.stale : undefined) ?? 300,
      revalidate: ttl,
      expire,
      streamEncoding: isStream ? 'base64' : undefined,
    };

    if (!canCommit() || this.pendingSets.get(cacheKey)?.token !== token) return;
    // Next owns delayed tag expiry. Eager engine tags would delete SWR entries
    // before Next could return revalidate:-1 and schedule their replacement.
    await this.cache.set(cacheKey, stored, remaining / 1000, undefined, { tags: [] });
    } finally {
      finish();
      if (this.pendingSets.get(cacheKey)?.token === token) this.pendingSets.delete(cacheKey);
    }
  }

  private observeTag(tag: string, version: number): number {
    const known = this.observedTags.get(tag);
    if (known?.version === version) return known.observedAt;
    if (this.observedTags.size >= 10000) {
      const oldest = this.observedTags.keys().next().value;
      if (oldest !== undefined) this.observedTags.delete(oldest);
    }
    const observedAt = Date.now();
    this.observedTags.set(tag, { version, observedAt });
    return observedAt;
  }

  /**
   * Delegate soft-tag checking to get() using Next's Infinity sentinel.
   */
  async getExpiration(tags: string[]): Promise<number> {
    // This is the native contract's explicit delegation sentinel, not an entry expiry.
    return tags.length ? Infinity : 0;
  }

  /**
   * Force subsequent tag reads to re-sync without forgetting monotonic versions.
   */
  async refreshTags(): Promise<void> {
    try {
      this.cache.refreshTagVersions();
    } catch (err) {
      this.logger.debug('Next.js cacheHandler refreshTags fail-soft catch', {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Update or invalidate tags cluster-wide.
   */
  async updateTags(tags: string[], durations?: { expire?: number }): Promise<void> {
    if (!tags || tags.length === 0) return;
    const now = Date.now();
    const delay = durations && durations.expire === undefined ? undefined : Math.max(0, durations?.expire ?? 0) * 1000;
    if (delay !== undefined && !Number.isFinite(delay)) throw new Error('Tag expiry duration must be finite');
    await Promise.all(tags.map(tag => this.cache.set(`_next_tag_state_:${tag}`, {
      revalidatedAt: now, expiredAt: delay === undefined ? undefined : now + delay,
    }, 0, CachePriority.HIGH)));
    await this.cache.invalidateTags(tags);
  }
}

export default TriCacheHandler;
