import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import { Cacheable, CacheEvict } from '../src/nestjs/decorators.js';
import { TriCacheStore } from '../src/nestjs/tricache.store.js';
import { INITIAL_ITEMS } from '../examples/nestjs-microservice/src/catalog.js';
import { ItemsRepository } from '../examples/nestjs-microservice/src/items.repository.js';

function applyDecorator(target: any, propertyKey: string, decorator: MethodDecorator): void {
  const desc = Object.getOwnPropertyDescriptor(target.prototype, propertyKey)!;
  const newDesc = decorator(target.prototype, propertyKey, desc) || desc;
  Object.defineProperty(target.prototype, propertyKey, newDesc);
}

describe('NestJS microservice reference example (examples/nestjs-microservice)', () => {
  let cache: CacheService;

  beforeEach(() => {
    cache = CacheService.create({
      namespace: `nest_demo_test_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      disableRedis: true,
      disableDisk: true,
      invalidationBackplane: false,
    });
  });

  afterEach(async () => {
    await cache.destroy();
  });

  describe('in-memory catalog repository', () => {
    it('seeds the demo catalog and supports CRUD', () => {
      const repo = new ItemsRepository();
      expect(repo.findAll().map((item) => item.id)).toEqual(INITIAL_ITEMS.map((item) => item.id));
      expect(repo.originReads).toBe(1);

      const created = repo.create({ name: 'USB Hub', price: 89 });
      expect(created.id).toBe('4');
      expect(repo.update('4', { price: 99 })?.price).toBe(99);
      expect(repo.remove('4')?.name).toBe('USB Hub');
      expect(repo.findById('4')).toBeUndefined();
    });
  });

  describe('@Cacheable / @CacheEvict contract used by ItemsService', () => {
    it('caches reads and evicts the items tag on mutation', async () => {
      const repo = new ItemsRepository();

      class DemoItemsService {
        cacheService = cache;

        async findOne(id: string) {
          const item = repo.findById(id);
          return { item, originReads: repo.originReads, computedAt: Date.now() };
        }

        async list() {
          return { items: repo.findAll(), originReads: repo.originReads, computedAt: Date.now() };
        }

        async update(id: string, name: string) {
          return repo.update(id, { name });
        }
      }

      applyDecorator(
        DemoItemsService,
        'findOne',
        Cacheable({ key: (id: string) => `item:${id}`, ttl: 120, ttlUnit: 'seconds', tags: ['items'] }),
      );
      applyDecorator(
        DemoItemsService,
        'list',
        Cacheable({ key: () => 'items:list', ttl: 120, tags: ['items'] }),
      );
      applyDecorator(
        DemoItemsService,
        'update',
        CacheEvict({ tags: ['items'] }),
      );

      const service = new DemoItemsService();

      const miss = await service.findOne('1');
      expect(miss.item?.name).toBe('Mechanical Keyboard');
      expect(repo.originReads).toBe(1);

      const hit = await service.findOne('1');
      expect(hit.computedAt).toBe(miss.computedAt);
      expect(repo.originReads).toBe(1);

      const listMiss = await service.list();
      expect(listMiss.items).toHaveLength(INITIAL_ITEMS.length);
      expect(repo.originReads).toBe(2);
      const listHit = await service.list();
      expect(listHit.computedAt).toBe(listMiss.computedAt);
      expect(repo.originReads).toBe(2);

      await service.update('1', 'Ortho Keyboard');
      const refill = await service.findOne('1');
      expect(refill.item?.name).toBe('Ortho Keyboard');
      expect(refill.computedAt).not.toBe(miss.computedAt);
      expect(repo.originReads).toBe(3);

      const listRefill = await service.list();
      expect(listRefill.computedAt).not.toBe(listMiss.computedAt);
      expect(repo.originReads).toBe(4);
    });
  });

  describe('CACHE_MANAGER / TriCacheStore path used by NotesService', () => {
    it('implements cache-manager get/set/del/keys/ttl with millisecond TTL', async () => {
      const store = new TriCacheStore(cache);

      expect(await store.get('note:n1')).toBeUndefined();

      const note = { id: 'n1', body: 'session-token', writtenAt: '2026-01-01T00:00:00.000Z' };
      await store.set('note:n1', note, 60_000);

      expect(await store.get('note:n1')).toEqual(note);
      const remaining = await store.ttl('note:n1');
      expect(remaining).toBeGreaterThan(50_000);
      expect(remaining).toBeLessThanOrEqual(60_000);
      expect(await store.keys('note:')).toContain('note:n1');

      await store.del('note:n1');
      expect(await store.get('note:n1')).toBeUndefined();
    });
  });
});
