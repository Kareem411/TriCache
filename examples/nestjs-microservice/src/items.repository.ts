import { Injectable } from '@nestjs/common';
import { INITIAL_ITEMS, type Item } from './catalog.js';

export interface ItemMutation {
  name?: string;
  price?: number;
}

@Injectable()
export class ItemsRepository {
  private readonly items = new Map<string, Item>(
    INITIAL_ITEMS.map((item) => [item.id, { ...item }]),
  );
  private nextId = INITIAL_ITEMS.length + 1;

  /** Incremented only on origin reads (list / findById). Cached payloads snapshot this. */
  originReads = 0;

  findAll(): Item[] {
    this.originReads += 1;
    return [...this.items.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  }

  findById(id: string): Item | undefined {
    this.originReads += 1;
    const item = this.items.get(id);
    return item ? { ...item } : undefined;
  }

  create(input: { name: string; price: number }): Item {
    const item: Item = {
      id: String(this.nextId++),
      name: input.name,
      price: input.price,
    };
    this.items.set(item.id, item);
    return { ...item };
  }

  update(id: string, patch: ItemMutation): Item | undefined {
    const current = this.items.get(id);
    if (!current) return undefined;
    const next: Item = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.price !== undefined ? { price: patch.price } : {}),
    };
    this.items.set(id, next);
    return { ...next };
  }

  remove(id: string): Item | undefined {
    const current = this.items.get(id);
    if (!current) return undefined;
    this.items.delete(id);
    return { ...current };
  }
}
