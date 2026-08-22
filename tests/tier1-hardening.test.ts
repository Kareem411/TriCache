/**
 * TDD specs for Tier-1 hardening:
 *
 * 1. Stream backplane: XREAD field parsing must validate entries through the
 *    same schema rules as the pubsub path before mutating state.
 * 2. TriCacheHandler.getExpiration(): must return a real expiration timestamp
 *    for tagged keys instead of hardcoded 0.
 * 3. TriCacheHandler.refreshTags(): must actually reconcile local tag-version
 *    knowledge against shared state (not an empty try/catch).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import TriCacheHandler from '../src/next/cache-handler.js';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe('stream backplane entry validation', () => {
  let svc: CacheService | null = null;

  afterEach(async () => {
    if (svc) await svc.destroy();
    svc = null;
  });

  function makeSvc(ns: string) {
    svc = new CacheService({
      namespace: ns,
      disableRedis: true,
      invalidationBackplane: false,
      logger: silentLogger,
    });
    return svc;
  }

  it('malformed op in a stream entry is rejected, not applied', async () => {
    const svc2 = makeSvc(`sv-${Date.now()}`);
    await svc2.set('victim:key', { v: 1 }, 60);

    const applySpy = viSpyOnApply(svc2);

    // Flat ioredis XREAD field shape: [name, value, name, value, …]
    (svc2 as unknown as { _processStreamEntry(fields: string[]): void })
      ._processStreamEntry(['op', 'DROP TABLE', 'key', `${svcNamespace(svc2)}:victim:key`, 'src', 'peer']);

    // Invalid op must be dropped with a warning — never dispatched.
    expect(applySpy.count).toBe(0);
    expect(svc2.getIfFresh('victim:key')).toEqual({ v: 1 });
  });

  it('NaN tagVersion from a corrupt field cannot poison the tag version map', async () => {
    const svc2 = makeSvc(`nan-${Date.now()}`);

    (svc2 as unknown as { _processStreamEntry(fields: string[]): void })
      ._processStreamEntry(['op', 'tag_incr', 'key', 'catalog', 'src', 'peer', 'tagVersion', '12abc34']);

    // The entry must be rejected outright — no NaN version may enter the map.
    const stored = (svc2 as unknown as { tagVersions: Map<string, { version: number }> })
      .tagVersions.get('catalog');
    expect(stored === undefined || Number.isFinite(stored.version)).toBe(true);
  });

  it('valid stream entries still apply normally', async () => {
    const svc2 = makeSvc(`ok-${Date.now()}`);
    await svc2.set('good:key', { v: 42 }, 60);

    (svc2 as unknown as { _processStreamEntry(fields: string[]): void })
      ._processStreamEntry(['op', 'del', 'key', `${svcNamespace(svc2)}:good:key`, 'src', 'peer-1']);

    expect(svc2.getIfFresh('good:key')).toBeNull();
  });
});

function svcNamespace(svc: CacheService): string {
  return (svc as unknown as { _namespace: string })._namespace;
}

/** Attach a counting wrapper around the private apply hook. */
function viSpyOnApply(svc: CacheService): { count: number } {
  const state = { count: 0 };
  const target = svc as unknown as {
    _applyInvalidationEvent: (...a: unknown[]) => void;
  };
  const original = target._applyInvalidationEvent.bind(svc);
  target._applyInvalidationEvent = (...a: unknown[]) => {
    state.count++;
    return original(...a);
  };
  return state;
}

describe('Next.js TriCacheHandler — real expiration & refresh contracts', () => {
  let handler: TriCacheHandler | null = null;

  afterEach(async () => {
    if (handler) {
      const cache = (handler as unknown as { cache: CacheService }).cache;
      await cache.destroy();
      handler = null;
    }
  });

  function makeHandler(): TriCacheHandler {
    handler = new TriCacheHandler({
      namespace: `exp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      disableRedis: true,
      disableDisk: true,
      logger: silentLogger,
    });
    return handler!;
  }

  it('getExpiration() returns the stored entry expiration (> now) instead of 0', async () => {
    const h = makeHandler();
    await h.set(
      'page:about',
      Promise.resolve({ value: { p: 1 }, tags: ['about'], ttl: 120 }),
      { tags: ['about'] },
    );

    const exp = await h.getExpiration(['about']);
    expect(exp).toBeGreaterThan(Date.now());
  });

  it('refreshTags() forces subsequent generational reads to re-sync tag versions', async () => {
    const h = makeHandler();
    const cache = (h as unknown as { cache: CacheService }).cache;

    // Warm the local tag cache with a stale snapshot
    (cache as unknown as { _setLocalTagVersion(t: string, v: number, now?: number): void })
      ._setLocalTagVersion('layout', 7, Date.now() - 60_000);
    const before = (cache as unknown as { tagVersions: Map<string, { lastSyncedAt: number }> })
      .tagVersions.get('layout')!;

    await h.refreshTags();

    const after = (cache as unknown as { tagVersions: Map<string, { lastSyncedAt: number }> })
      .tagVersions.get('layout');
    // Either evicted (undefined → will re-sync on next read) or re-synced with
    // a newer stamp; the old no-op refreshTags() left lastSyncedAt untouched.
    expect(after === undefined || after.lastSyncedAt > before.lastSyncedAt).toBe(true);
  });
});
