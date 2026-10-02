import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  index() {
    return {
      name: 'TriCache NestJS microservice demo',
      docs: 'See README.md for curl walkthroughs',
      routes: {
        items: 'GET /items  GET /items/:id  POST /items  PATCH /items/:id  DELETE /items/:id',
        store: 'PUT /store/notes/:id  GET /store/notes/:id  DELETE /store/notes/:id  GET /store/keys',
        health: 'GET /healthz',
      },
      try: {
        cacheable: 'GET /items/1 twice — identical computedAt / originReads on the second call',
        evict: 'PATCH /items/1 then GET /items/1 — new computedAt (tag eviction)',
        cacheManager: 'PUT /store/notes/n1 then GET /store/notes/n1 (cache: "hit")',
      },
    };
  }

  @Get('healthz')
  health() {
    return { ok: true };
  }
}
