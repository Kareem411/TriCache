import { describe, it, expect, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service';

describe('Read Safety Strategy (cloneStrategy)', () => {
  let svc: CacheService | null = null;

  afterEach(async () => {
    if (svc) {
      await svc.destroy();
      svc = null;
    }
  });

  it('cloneStrategy: "none" returns raw reference allowing in-place mutation', async () => {
    svc = new CacheService({
      cloneStrategy: 'none',
      disableRedis: true,
      disableDisk: true,
    });

    const original = { user: 'Alice', roles: ['admin'] };
    await svc.set('user:alice', original);

    const hit1 = await svc.get('user:alice', async () => ({ user: 'Alice', roles: ['admin'] }));
    hit1.roles.push('superadmin'); // Mutate returned object

    const hit2 = await svc.get('user:alice', async () => ({ user: 'Alice', roles: ['admin'] }));
    // With cloneStrategy: 'none', in-place mutation affects subsequent gets
    expect(hit2.roles).toEqual(['admin', 'superadmin']);
  });

  it('cloneStrategy: "structuredClone" isolates L1 entry from caller mutations', async () => {
    svc = new CacheService({
      cloneStrategy: 'structuredClone',
      disableRedis: true,
      disableDisk: true,
    });

    const original = { user: 'Bob', settings: { theme: 'dark' } };
    await svc.set('user:bob', original);

    const hit1 = await svc.get('user:bob', async () => ({ user: 'Bob', settings: { theme: 'dark' } }));
    hit1.settings.theme = 'light'; // Mutate returned object

    const hit2 = await svc.get('user:bob', async () => ({ user: 'Bob', settings: { theme: 'dark' } }));
    // With cloneStrategy: 'structuredClone', L1 cache is protected from caller mutation
    expect(hit2.settings.theme).toBe('dark');
  });

  it('cloneStrategy: "structuredClone" protects fetchFn result from caller mutation', async () => {
    svc = new CacheService({
      cloneStrategy: 'structuredClone',
      disableRedis: true,
      disableDisk: true,
    });

    let fetchCount = 0;
    const fetchFn = async () => {
      fetchCount++;
      return { profile: { title: 'Engineer' } };
    };

    const res1 = await svc.get('profile:1', fetchFn);
    res1.profile.title = 'Manager'; // Mutate returned object

    const res2 = await svc.get('profile:1', fetchFn);
    expect(res2.profile.title).toBe('Engineer');
    expect(fetchCount).toBe(1); // Served from L1 cache
  });

  it('frozen: true with cloneStrategy: "structuredClone" freezes L1 while returning mutable clone', async () => {
    svc = new CacheService({
      frozen: true,
      cloneStrategy: 'structuredClone',
      disableRedis: true,
      disableDisk: true,
    });

    await svc.set('data:1', { a: 1, b: [2, 3] });

    const clone = await svc.get('data:1', async () => ({ a: 1, b: [2, 3] }));
    // The returned clone is NOT frozen, allowing callers to mutate their copy
    expect(Object.isFrozen(clone)).toBe(false);
    expect(() => {
      clone.a = 99;
      clone.b.push(4);
    }).not.toThrow();

    // But the L1 cache remains pristine and intact
    const clone2 = await svc.get('data:1', async () => ({ a: 1, b: [2, 3] }));
    expect(clone2.a).toBe(1);
    expect(clone2.b).toEqual([2, 3]);
  });
});
