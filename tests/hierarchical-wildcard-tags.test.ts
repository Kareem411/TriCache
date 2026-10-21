import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service';
import { EdgeCacheService } from '../src/edge/cache';
import {
  matchesTagPattern,
  isChildTag,
  expandHierarchicalTags,
  isWildcardTag,
} from '../src/utils/tag-matcher';

describe('Tag Matcher Utilities', () => {
  describe('isWildcardTag', () => {
    it('detects wildcard characters', () => {
      expect(isWildcardTag('catalog')).toBe(false);
      expect(isWildcardTag('org:123:*')).toBe(true);
      expect(isWildcardTag('*:settings')).toBe(true);
      expect(isWildcardTag('tenant:?:users')).toBe(true);
    });
  });

  describe('matchesTagPattern', () => {
    it('handles exact matches', () => {
      expect(matchesTagPattern('catalog', 'catalog')).toBe(true);
      expect(matchesTagPattern('catalog', 'users')).toBe(false);
    });

    it('handles universal wildcard (*)', () => {
      expect(matchesTagPattern('*', 'anything')).toBe(true);
      expect(matchesTagPattern('*', '')).toBe(true);
    });

    it('handles trailing prefix wildcards (e.g. org:123:*)', () => {
      expect(matchesTagPattern('org:123:*', 'org:123:users')).toBe(true);
      expect(matchesTagPattern('org:123:*', 'org:123:dept:456')).toBe(true);
      expect(matchesTagPattern('org:123:*', 'org:123')).toBe(false);
      expect(matchesTagPattern('org:123:*', 'org:456:users')).toBe(false);
    });

    it('handles leading suffix wildcards (e.g. *:comments)', () => {
      expect(matchesTagPattern('*:comments', 'post:1:comments')).toBe(true);
      expect(matchesTagPattern('*:comments', 'case:42:comments')).toBe(true);
      expect(matchesTagPattern('*:comments', 'post:1:likes')).toBe(false);
    });

    it('handles middle / arbitrary glob wildcards and single char (?)', () => {
      expect(matchesTagPattern('org:*:settings', 'org:corp:settings')).toBe(true);
      expect(matchesTagPattern('org:*:settings', 'org:corp:sub:settings')).toBe(true);
      expect(matchesTagPattern('org:*:settings', 'org:corp:profile')).toBe(false);
      expect(matchesTagPattern('tenant:?:active', 'tenant:1:active')).toBe(true);
      expect(matchesTagPattern('tenant:?:active', 'tenant:12:active')).toBe(false);
    });
  });

  describe('isChildTag', () => {
    it('returns true for exact match or children with boundary delimiter', () => {
      expect(isChildTag('org:123', 'org:123', ':')).toBe(true);
      expect(isChildTag('org:123', 'org:123:dept', ':')).toBe(true);
      expect(isChildTag('org:123', 'org:123:dept:sales', ':')).toBe(true);
      // Boundary check: org:1234 must not match org:123
      expect(isChildTag('org:123', 'org:1234', ':')).toBe(false);
      expect(isChildTag('org:123', 'other:123', ':')).toBe(false);
    });

    it('supports custom delimiters', () => {
      expect(isChildTag('geo/us', 'geo/us/west', '/')).toBe(true);
      expect(isChildTag('geo/us', 'geo/uswest', '/')).toBe(false);
    });
  });

  describe('expandHierarchicalTags', () => {
    it('expands tags into all ancestor levels', () => {
      const expanded = expandHierarchicalTags(['org:123:dept:456', 'role:admin']);
      expect(expanded).toContain('org');
      expect(expanded).toContain('org:123');
      expect(expanded).toContain('org:123:dept');
      expect(expanded).toContain('org:123:dept:456');
      expect(expanded).toContain('role');
      expect(expanded).toContain('role:admin');
      expect(expanded.length).toBe(6);
    });

    it('handles tags with no delimiters and custom delimiters', () => {
      expect(expandHierarchicalTags(['plain'])).toEqual(['plain']);
      expect(expandHierarchicalTags(['a/b/c'], '/')).toEqual(['a', 'a/b', 'a/b/c']);
    });
  });
});

describe('Hierarchical & Wildcard Tag Invalidation (tagStrategy: set)', () => {
  let cache: CacheService;

  beforeEach(() => {
    cache = new CacheService({
      disableDisk: true,
      disableRedis: true,
      tagStrategy: 'set',
    });
  });

  afterEach(async () => {
    await cache.clear();
  });

  it('invalidates entries using wildcard prefix (e.g. org:123:*)', async () => {
    await cache.set('k1', 'val1', 60, undefined, { tags: ['org:123:users'] });
    await cache.set('k2', 'val2', 60, undefined, { tags: ['org:123:settings'] });
    await cache.set('k3', 'val3', 60, undefined, { tags: ['org:999:users'] });

    expect(await cache.getIfFresh('k1')).toBe('val1');
    expect(await cache.getIfFresh('k2')).toBe('val2');
    expect(await cache.getIfFresh('k3')).toBe('val3');

    // Invalidate with wildcard
    await cache.invalidateTag('org:123:*');

    expect(await cache.getIfFresh('k1')).toBeNull();
    expect(await cache.getIfFresh('k2')).toBeNull();
    expect(await cache.getIfFresh('k3')).toBe('val3');
  });

  it('invalidates entries using wildcard suffix (e.g. *:comments)', async () => {
    await cache.set('k1', 'post1', 60, undefined, { tags: ['post:1:comments'] });
    await cache.set('k2', 'post2', 60, undefined, { tags: ['case:42:comments'] });
    await cache.set('k3', 'post3', 60, undefined, { tags: ['post:1:likes'] });

    await cache.invalidateTag('*:comments');

    expect(await cache.getIfFresh('k1')).toBeNull();
    expect(await cache.getIfFresh('k2')).toBeNull();
    expect(await cache.getIfFresh('k3')).toBe('post3');
  });

  it('supports parent-child tag cascading with { cascade: true }', async () => {
    await cache.set('k1', 'user', 60, undefined, { tags: ['tenant:acme:dept:sales'] });
    await cache.set('k2', 'other', 60, undefined, { tags: ['tenant:other:dept:sales'] });

    // Without cascade: 'tenant:acme' does not match 'tenant:acme:dept:sales'
    await cache.invalidateTag('tenant:acme');
    expect(await cache.getIfFresh('k1')).toBe('user');

    // With cascade: 'tenant:acme' cascades down to all children
    await cache.invalidateTag('tenant:acme', { cascade: true });
    expect(await cache.getIfFresh('k1')).toBeNull();
    expect(await cache.getIfFresh('k2')).toBe('other');
  });

  it('supports batch invalidateTags() with mixed wildcards and discrete tags', async () => {
    await cache.set('k1', 'val1', 60, undefined, { tags: ['org:1:users'] });
    await cache.set('k2', 'val2', 60, undefined, { tags: ['org:2:settings'] });
    await cache.set('k3', 'val3', 60, undefined, { tags: ['catalog'] });
    await cache.set('k4', 'val4', 60, undefined, { tags: ['system'] });

    await cache.invalidateTags(['org:*', 'catalog']);

    expect(await cache.getIfFresh('k1')).toBeNull();
    expect(await cache.getIfFresh('k2')).toBeNull();
    expect(await cache.getIfFresh('k3')).toBeNull();
    expect(await cache.getIfFresh('k4')).toBe('val4');
  });

  it('safely handles non-matching wildcards without throwing', async () => {
    await cache.set('k1', 'val1', 60, undefined, { tags: ['org:1:users'] });
    await expect(cache.invalidateTag('nonexistent:*')).resolves.not.toThrow();
    expect(await cache.getIfFresh('k1')).toBe('val1');
  });
});

describe('Hierarchical Tags Auto-Expansion (hierarchicalTags: true)', () => {
  it('automatically associates entries with all ancestor namespaces on set()', async () => {
    const cache = new CacheService({
      disableDisk: true,
      disableRedis: true,
      hierarchicalTags: true,
      tagHierarchyDelimiter: ':',
    });

    await cache.set('k1', 'val1', 60, undefined, { tags: ['company:meta:team:infra'] });

    // Invalidating ancestor 'company:meta' should invalidate 'k1'
    await cache.invalidateTag('company:meta');
    expect(await cache.getIfFresh('k1')).toBeNull();
  });

  it('supports custom hierarchy delimiter (e.g. /)', async () => {
    const cache = new CacheService({
      disableDisk: true,
      disableRedis: true,
      hierarchicalTags: true,
      tagHierarchyDelimiter: '/',
    });

    await cache.set('k1', 'val1', 60, undefined, { tags: ['geo/us/west/oregon'] });

    await cache.invalidateTag('geo/us');
    expect(await cache.getIfFresh('k1')).toBeNull();
  });

  it('automatically expands hierarchical tags in get() cache miss', async () => {
    const cache = new CacheService({
      disableDisk: true,
      disableRedis: true,
      hierarchicalTags: true,
    });

    let fetches = 0;
    const fetcher = async () => {
      fetches++;
      return { id: 101 };
    };

    const res1 = await cache.get('user:101', fetcher, 60, { tags: ['org:eng:frontend:team1'] });
    expect(res1).toEqual({ id: 101 });
    expect(fetches).toBe(1);

    // Invalidate top-level ancestor 'org'
    await cache.invalidateTag('org');

    // Next get() must re-fetch
    const res2 = await cache.get('user:101', fetcher, 60, { tags: ['org:eng:frontend:team1'] });
    expect(res2).toEqual({ id: 101 });
    expect(fetches).toBe(2);
  });
});

describe('Hierarchical & Wildcard Tag Invalidation (tagStrategy: generational)', () => {
  let cache: CacheService;

  beforeEach(() => {
    cache = new CacheService({
      disableDisk: true,
      disableRedis: true,
      tagStrategy: 'generational',
    });
  });

  afterEach(async () => {
    await cache.clear();
  });

  it('detects staleness across wildcard tags (e.g. case:100:*)', async () => {
    let fetchCount1 = 0;
    let fetchCount2 = 0;
    let fetchCount3 = 0;

    await cache.get('c100:msg', async () => (++fetchCount1, 'messages'), 60, { tags: ['case:100:messages'] });
    await cache.get('c100:files', async () => (++fetchCount2, 'files'), 60, { tags: ['case:100:files'] });
    await cache.get('c200:msg', async () => (++fetchCount3, 'messages200'), 60, { tags: ['case:200:messages'] });

    expect(fetchCount1).toBe(1);
    expect(fetchCount2).toBe(1);
    expect(fetchCount3).toBe(1);

    // Invalidate wildcard case:100:*
    await cache.invalidateTag('case:100:*');

    // c100 keys must be stale and re-fetched
    await cache.get('c100:msg', async () => (++fetchCount1, 'fresh1'), 60, { tags: ['case:100:messages'] });
    await cache.get('c100:files', async () => (++fetchCount2, 'fresh2'), 60, { tags: ['case:100:files'] });

    expect(fetchCount1).toBe(2);
    expect(fetchCount2).toBe(2);

    // c200 key must remain a cache hit (fetchCount3 unchanged)
    const val3 = await cache.get('c200:msg', async () => (++fetchCount3, 'unwanted'), 60, { tags: ['case:200:messages'] });
    expect(val3).toBe('messages200');
    expect(fetchCount3).toBe(1);
  });

  it('supports { cascade: true } in generational strategy', async () => {
    let fetches = 0;
    await cache.get('k1', async () => (++fetches, 'data'), 60, { tags: ['org:123:dept:456'] });
    expect(fetches).toBe(1);

    // Non-cascading invalidation does not affect child
    await cache.invalidateTag('org:123');
    await cache.get('k1', async () => (++fetches, 'data'), 60, { tags: ['org:123:dept:456'] });
    expect(fetches).toBe(1);

    // Cascading invalidation updates version for all descendants
    await cache.invalidateTag('org:123', { cascade: true });
    await cache.get('k1', async () => (++fetches, 'data'), 60, { tags: ['org:123:dept:456'] });
    expect(fetches).toBe(2);
  });

  it('supports hierarchicalTags auto-expansion in generational strategy', async () => {
    const genCache = new CacheService({
      disableDisk: true,
      disableRedis: true,
      tagStrategy: 'generational',
      hierarchicalTags: true,
    });

    let fetches = 0;
    await genCache.get('doc:1', async () => (++fetches, 'doc'), 60, { tags: ['tenant:acme:workspace:alpha'] });
    expect(fetches).toBe(1);

    // Invalidate top-level tenant
    await genCache.invalidateTag('tenant:acme');

    // Should detect staleness and re-fetch
    await genCache.get('doc:1', async () => (++fetches, 'doc'), 60, { tags: ['tenant:acme:workspace:alpha'] });
    expect(fetches).toBe(2);
  });
});

describe('EdgeCacheService Wildcard & Cascading Tag Invalidation', () => {
  it('supports wildcard tag invalidation in Edge isolates', async () => {
    const edge = new EdgeCacheService();
    await edge.set('item:1', 'data1', 60, ['org:123:users']);
    await edge.set('item:2', 'data2', 60, ['org:123:settings']);
    await edge.set('item:3', 'data3', 60, ['org:456:users']);

    expect(await edge.get('item:1')).toBe('data1');
    expect(await edge.get('item:2')).toBe('data2');
    expect(await edge.get('item:3')).toBe('data3');

    // Invalidate wildcard
    await edge.invalidateTag('org:123:*');

    expect(await edge.get('item:1')).toBeNull();
    expect(await edge.get('item:2')).toBeNull();
    expect(await edge.get('item:3')).toBe('data3');
  });

  it('supports parent-child tag cascading with { cascade: true } in Edge isolates', async () => {
    const edge = new EdgeCacheService();
    await edge.set('item:1', 'data1', 60, ['tenant:acme:team:eng']);
    await edge.set('item:2', 'data2', 60, ['tenant:acme']);
    await edge.set('item:3', 'data3', 60, ['tenant:acme_other']);

    await edge.invalidateTag('tenant:acme', { cascade: true });

    expect(await edge.get('item:1')).toBeNull();
    expect(await edge.get('item:2')).toBeNull();
    expect(await edge.get('item:3')).toBe('data3'); // boundary safe, not matched
  });
});
