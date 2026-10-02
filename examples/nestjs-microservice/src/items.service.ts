import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CacheService } from 'tricache';
import { Cacheable, CacheEvict, TRICACHE_SERVICE } from 'tricache/nestjs';
import { originLatencyMs, sleep } from './cache-options.js';
import { ItemsRepository, type ItemMutation } from './items.repository.js';
import type { Item } from './catalog.js';

export interface CachedPayload<T> {
  data: T;
  computedAt: string;
  originReads: number;
  originLatencyMs: number;
}

/**
 * Decorators resolve the engine via `this.cacheService` | `this.cache` |
 * `this.cacheStore.cache`. The injected property name must be one of those.
 */
@Injectable()
export class ItemsService {
  constructor(
    @Inject(TRICACHE_SERVICE) readonly cacheService: CacheService,
    @Inject(ItemsRepository) private readonly repo: ItemsRepository,
  ) {}

  @Cacheable({
    key: () => 'items:list',
    ttl: 120,
    ttlUnit: 'seconds',
    tags: ['items'],
  })
  async list(): Promise<CachedPayload<Item[]>> {
    const started = Date.now();
    await sleep(originLatencyMs());
    return {
      data: this.repo.findAll(),
      computedAt: new Date().toISOString(),
      originReads: this.repo.originReads,
      originLatencyMs: Date.now() - started,
    };
  }

  @Cacheable({
    key: (id: string) => `item:${id}`,
    ttl: 120,
    ttlUnit: 'seconds',
    tags: ['items'],
  })
  async findOne(id: string): Promise<CachedPayload<Item>> {
    const started = Date.now();
    await sleep(originLatencyMs());
    const item = this.repo.findById(id);
    if (!item) {
      throw new NotFoundException(`item ${id} not found`);
    }
    return {
      data: item,
      computedAt: new Date().toISOString(),
      originReads: this.repo.originReads,
      originLatencyMs: Date.now() - started,
    };
  }

  @CacheEvict({ tags: ['items'] })
  async create(input: { name: string; price: number }): Promise<Item> {
    return this.repo.create(input);
  }

  @CacheEvict({ tags: ['items'] })
  async update(id: string, patch: ItemMutation): Promise<Item> {
    const item = this.repo.update(id, patch);
    if (!item) {
      throw new NotFoundException(`item ${id} not found`);
    }
    return item;
  }

  @CacheEvict({ tags: ['items'] })
  async remove(id: string): Promise<Item> {
    const item = this.repo.remove(id);
    if (!item) {
      throw new NotFoundException(`item ${id} not found`);
    }
    return item;
  }
}
