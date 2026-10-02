import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ItemsService } from './items.service.js';
import type { ItemMutation } from './items.repository.js';

@Controller('items')
export class ItemsController {
  constructor(@Inject(ItemsService) private readonly items: ItemsService) {}

  @Get()
  async list() {
    const payload = await this.items.list();
    return {
      ...payload,
      note: 'computedAt / originReads stay frozen on a @Cacheable hit. PATCH/POST/DELETE evict tag "items".',
    };
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const payload = await this.items.findOne(id);
    return {
      ...payload,
      note: 'Same computedAt + originReads on a later GET means a cache hit. A mutation evicts this key via tags.',
    };
  }

  @Post()
  async create(@Body() body: { name?: string; price?: number }) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const price = Number(body?.price);
    if (!name || !Number.isFinite(price)) {
      throw new BadRequestException('name (string) and price (number) are required');
    }
    const item = await this.items.create({ name, price });
    return { item, evictedTags: ['items'] };
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: ItemMutation) {
    const patch: ItemMutation = {};
    if (typeof body?.name === 'string') patch.name = body.name;
    if (body?.price !== undefined) patch.price = Number(body.price);
    const item = await this.items.update(id, patch);
    return { item, evictedTags: ['items'] };
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Param('id') id: string) {
    const item = await this.items.remove(id);
    return { item, evictedTags: ['items'] };
  }
}
