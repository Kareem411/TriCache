import { describe, it, expect } from 'vitest';
import { resolveCacheLife, PRESET_CACHE_LIFE_PROFILES } from '../src/next/cache-handler';

describe('next.js 16 cacheLife resolution', () => {
  it('resolves all standard built-in presets correctly', () => {
    for (const [name, profile] of Object.entries(PRESET_CACHE_LIFE_PROFILES)) {
      const resolved = resolveCacheLife(name);
      expect(resolved).not.toBeNull();
      expect(resolved!.ttl).toBe(profile.revalidate);
      expect(resolved!.swr).toBe(Math.max(0, profile.expire - profile.revalidate));
    }
  });

  it('resolves preset: "default"', () => {
    const res = resolveCacheLife('default');
    expect(res).toEqual({ ttl: 900, swr: 2_592_000 - 900 });
  });

  it('resolves preset: "seconds"', () => {
    const res = resolveCacheLife('seconds');
    expect(res).toEqual({ ttl: 1, swr: 59 });
  });

  it('resolves preset: "minutes"', () => {
    const res = resolveCacheLife('minutes');
    expect(res).toEqual({ ttl: 60, swr: 3540 });
  });

  it('resolves preset: "hours"', () => {
    const res = resolveCacheLife('hours');
    expect(res).toEqual({ ttl: 3600, swr: 82800 });
  });

  it('resolves preset: "days"', () => {
    const res = resolveCacheLife('days');
    expect(res).toEqual({ ttl: 86400, swr: 604800 - 86400 });
  });

  it('resolves preset: "weeks"', () => {
    const res = resolveCacheLife('weeks');
    expect(res).toEqual({ ttl: 604800, swr: 2_592_000 - 604800 });
  });

  it('resolves preset: "max"', () => {
    const res = resolveCacheLife('max');
    expect(res).toEqual({ ttl: 2_592_000, swr: 31_536_000 - 2_592_000 });
  });

  it('resolves custom profile object', () => {
    const res = resolveCacheLife({ revalidate: 120, expire: 600 });
    expect(res).toEqual({ ttl: 120, swr: 480 });
  });

  it('clamps swr to 0 if expire is less than revalidate', () => {
    const res = resolveCacheLife({ revalidate: 500, expire: 300 });
    expect(res).toEqual({ ttl: 500, swr: 0 });
  });

  it('uses default fallbacks when profile properties are missing', () => {
    const res = resolveCacheLife({} as any);
    expect(res).toEqual({ ttl: 900, swr: 2_592_000 - 900 });
  });

  it('returns null for unknown preset strings', () => {
    expect(resolveCacheLife('nonexistent-preset')).toBeNull();
  });

  it('returns null for undefined, null, or empty string', () => {
    expect(resolveCacheLife(undefined)).toBeNull();
    expect(resolveCacheLife(null as any)).toBeNull();
    expect(resolveCacheLife('')).toBeNull();
  });
});
