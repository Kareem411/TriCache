import { Module, type DynamicModule } from '@nestjs/common';
import { TriCacheModule } from 'tricache/nestjs';
import { AppController } from './app.controller.js';
import { createDemoCacheOptions } from './cache-options.js';
import { ItemsController } from './items.controller.js';
import { ItemsRepository } from './items.repository.js';
import { ItemsService } from './items.service.js';
import { NotesController } from './notes.controller.js';
import { NotesService } from './notes.service.js';

/**
 * `tricache/nestjs` types a structural DynamicModule so Nest stays an optional
 * peer. The runtime object is a Nest dynamic module (`global: true`).
 */
function registerTriCache(): DynamicModule {
  return TriCacheModule.register(createDemoCacheOptions()) as unknown as DynamicModule;
}

@Module({
  imports: [registerTriCache()],
  controllers: [AppController, ItemsController, NotesController],
  providers: [ItemsRepository, ItemsService, NotesService],
})
export class AppModule {}
