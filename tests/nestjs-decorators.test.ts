import { describe, it, expect, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import { Cacheable, CacheEvict } from '../src/nestjs/decorators.js';

function applyDecorator(target: any, propertyKey: string, decorator: MethodDecorator): void {
  const desc = Object.getOwnPropertyDescriptor(target.prototype, propertyKey)!;
  const newDesc = decorator(target.prototype, propertyKey, desc) || desc;
  Object.defineProperty(target.prototype, propertyKey, newDesc);
}

describe('NestJS Method Decorators (@Cacheable, @CacheEvict)', () => {
  let cache: CacheService | null = null;

  afterEach(async () => {
    if (cache) {
      await cache.destroy();
      cache = null;
    }
  });

  it('caches method results and prevents duplicate execution via @Cacheable', async () => {
    cache = CacheService.create({
      namespace: `dec-test-${Date.now()}`,
      disableRedis: true,
      disableDisk: true,
    });

    let dbQueries = 0;

    class TestService {
      cache = cache;

      async findUser(id: string) {
        dbQueries++;
        return { id, name: `User ${id}`, queriedAt: Date.now() };
      }
    }

    applyDecorator(
      TestService,
      'findUser',
      Cacheable({ key: (id: string) => `user:${id}`, ttl: 300, tags: ['users'] }),
    );

    const service = new TestService();

    // First call executes method
    const res1 = await service.findUser('u100');
    expect(res1.id).toBe('u100');
    expect(dbQueries).toBe(1);

    // Second call serves from cache
    const res2 = await service.findUser('u100');
    expect(res2).toEqual(res1);
    expect(dbQueries).toBe(1);

    // Different key executes method
    const res3 = await service.findUser('u200');
    expect(res3.id).toBe('u200');
    expect(dbQueries).toBe(2);
  });

  it('invalidates cached keys and tags via @CacheEvict', async () => {
    cache = CacheService.create({
      namespace: `evict-test-${Date.now()}`,
      disableRedis: true,
      disableDisk: true,
    });

    let queries = 0;

    class OrderService {
      cache = cache;

      async getOrder(id: string) {
        queries++;
        return { id, status: 'pending' };
      }

      async updateOrder(id: string, status: string) {
        return { id, status };
      }

      async clearAllOrders() {
        return { cleared: true };
      }
    }

    applyDecorator(
      OrderService,
      'getOrder',
      Cacheable({ key: (id: string) => `order:${id}`, tags: ['orders'] }),
    );
    applyDecorator(
      OrderService,
      'updateOrder',
      CacheEvict({ key: (id: string) => `order:${id}` }),
    );
    applyDecorator(
      OrderService,
      'clearAllOrders',
      CacheEvict({ tags: ['orders'] }),
    );

    const service = new OrderService();

    await service.getOrder('ord-1');
    expect(queries).toBe(1);

    await service.getOrder('ord-1');
    expect(queries).toBe(1); // cache hit

    // Evict key
    await service.updateOrder('ord-1', 'shipped');
    await service.getOrder('ord-1');
    expect(queries).toBe(2); // re-executed

    // Evict by tag
    await service.clearAllOrders();
    await service.getOrder('ord-1');
    expect(queries).toBe(3); // re-executed
  });
});
