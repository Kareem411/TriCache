import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Put, Query } from '@nestjs/common';
import { NotesService } from './notes.service.js';

@Controller('store')
export class NotesController {
  constructor(@Inject(NotesService) private readonly notes: NotesService) {}

  @Get('keys')
  listKeys() {
    return this.notes.listKeys();
  }

  @Get('notes/:id')
  read(@Param('id') id: string) {
    return this.notes.read(id);
  }

  @Put('notes/:id')
  write(
    @Param('id') id: string,
    @Body() body: { body?: string; ttlMs?: number },
    @Query('ttlMs') ttlQuery?: string,
  ) {
    const text = typeof body?.body === 'string' ? body.body : '';
    if (!text) {
      throw new BadRequestException('JSON body { "body": "..." } is required');
    }
    const ttlMs = Number(body?.ttlMs ?? ttlQuery ?? 60_000);
    return this.notes.write(id, text, Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : 60_000);
  }

  @Delete('notes/:id')
  erase(@Param('id') id: string) {
    return this.notes.erase(id);
  }
}
