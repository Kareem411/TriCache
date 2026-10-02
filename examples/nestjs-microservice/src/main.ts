import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { CacheService } from 'tricache';
import { TRICACHE_SERVICE } from 'tricache/nestjs';
import { AppModule } from './app.module.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST ?? '127.0.0.1';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  await app.listen(PORT, HOST);
  console.log(`TriCache NestJS demo listening on http://${HOST}:${PORT}`);

  const cache = app.get<CacheService>(TRICACHE_SERVICE);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received, shutting down`);
    await app.close().catch(() => {});
    await cache.destroy().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

void bootstrap();
