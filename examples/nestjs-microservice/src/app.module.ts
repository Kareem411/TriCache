import { Module } from '@nestjs/common';
import { TriCacheModule } from 'tricache/nestjs';
import { AppController } from './app.controller.js';
import { createDemoCacheOptions } from './cache-options.js';
import { ItemsController } from './items.controller.js';
import { ItemsRepository } from './items.repository.js';
import { ItemsService } from './items.service.js';
import { NotesController } from './notes.controller.js';
import { NotesService } from './notes.service.js';

@Module({
  imports: [TriCacheModule.register(createDemoCacheOptions())],
  controllers: [AppController, ItemsController, NotesController],
  providers: [ItemsRepository, ItemsService, NotesService],
})
export class AppModule {}
