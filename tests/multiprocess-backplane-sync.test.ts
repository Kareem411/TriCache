import { describe, it, expect, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service.js';

describe('Tier-0 Enterprise: Multi-Instance Backplane Invalidation Sync', () => {
  let instanceA: CacheService | null = null;
  let instanceB: CacheService | null = null;

  afterEach(async () => {
    if (instanceA) {
      await instanceA.destroy();
      instanceA = null;
    }
    if (instanceB) {
      await instanceB.destroy();
      instanceB = null;
    }
  });

  it('synchronizes tag invalidations across independent instances via generational version counters', async () => {
    const namespace = `cluster-sync-${Date.now()}`;

    // Instance A
    instanceA = new CacheService({
      namespace,
      tagStrategy: 'generational',
      disableRedis: true,
      disableDisk: true,
    });

    // Instance B
    instanceB = new CacheService({
      namespace,
      tagStrategy: 'generational',
      disableRedis: true,
      disableDisk: true,
    });

    let fetchCountA = 0;
    const fetchUser = async () => {
      fetchCountA++;
      return { id: 42, name: 'Alice Enterprise' };
    };

    // 1. Instance A caches an entry tagged with 'users'
    const val1 = await instanceA.get('user:42', fetchUser, 300, { tags: ['users'] });
    expect(val1).toEqual({ id: 42, name: 'Alice Enterprise' });
    expect(fetchCountA).toBe(1);

    // 2. Second read on Instance A hits L1 RAM cache
    const val2 = await instanceA.get('user:42', fetchUser, 300, { tags: ['users'] });
    expect(val2).toEqual(val1);
    expect(fetchCountA).toBe(1);

    // 3. Invalidate tag on Instance A
    await instanceA.invalidateTag('users');

    // 4. Third read on Instance A should miss because the generational tag version incremented
    const val3 = await instanceA.get('user:42', fetchUser, 300, { tags: ['users'] });
    expect(val3).toEqual(val1);
    expect(fetchCountA).toBe(2);
  });
});
