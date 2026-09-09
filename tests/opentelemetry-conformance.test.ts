import { describe, it, expect, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service';
import type { ICacheTracer, ICacheSpan } from '../src/types';

describe('OpenTelemetry Conformance & Dual Semconv (Phase 2 & Guardrail 2)', () => {
  function createMockTracer() {
    const spans: {
      name: string;
      attrs: Record<string, unknown>;
      ended: boolean;
      status?: { code: number; message?: string };
      exceptions: unknown[];
    }[] = [];

    const tracer: ICacheTracer = {
      startSpan(name) {
        const spanRecord: (typeof spans)[number] = {
          name,
          attrs: {},
          ended: false,
          exceptions: [],
        };
        spans.push(spanRecord);

        const span: ICacheSpan = {
          setAttribute(key, value) {
            spanRecord.attrs[key] = value;
            return span;
          },
          setStatus(status) {
            spanRecord.status = status;
            return span;
          },
          recordException(err) {
            spanRecord.exceptions.push(err);
            return span;
          },
          end() {
            spanRecord.ended = true;
          },
        };
        return span;
      },
    };

    return { tracer, spans };
  }

  let svc: CacheService;

  afterEach(async () => {
    if (svc) await svc.destroy();
  });

  it('instruments mset() with tricache.mset span and cache.batch.size', async () => {
    const { tracer, spans } = createMockTracer();
    svc = new CacheService({
      disableDisk: true,
      disableRedis: true,
      tracer,
    });

    await svc.mset({
      'user:1': { value: { name: 'Alice' }, ttl: 60 },
      'user:2': { value: { name: 'Bob' }, ttl: 60 },
      'user:3': { value: { name: 'Charlie' }, ttl: 60 },
    });

    const msetSpan = spans.find(s => s.name === 'tricache.mset');
    expect(msetSpan).toBeDefined();
    expect(msetSpan?.ended).toBe(true);
    expect(msetSpan?.attrs['cache.batch.size']).toBe(3);
  });

  it('instruments mdel() with tricache.mdel span and cache.batch.size', async () => {
    const { tracer, spans } = createMockTracer();
    svc = new CacheService({
      disableDisk: true,
      disableRedis: true,
      tracer,
    });

    await svc.set('key:1', 'val1', 60);
    await svc.set('key:2', 'val2', 60);

    await svc.mdel(['key:1', 'key:2']);

    const mdelSpan = spans.find(s => s.name === 'tricache.mdel');
    expect(mdelSpan).toBeDefined();
    expect(mdelSpan?.ended).toBe(true);
    expect(mdelSpan?.attrs['cache.batch.size']).toBe(2);
  });

  it('preserves dual semconv: boolean cache.hit + cache.item.tier AND legacy cache.hit_tier', async () => {
    const { tracer, spans } = createMockTracer();
    svc = new CacheService({
      disableDisk: true,
      disableRedis: true,
      tracer,
    });

    // 1. First get: cache miss
    await svc.get('product:42', async () => ({ id: 42, title: 'Widget' }), 60);
    const missSpan = spans.find(s => s.name === 'tricache.get' && s.attrs['cache.hit'] === false);
    expect(missSpan).toBeDefined();
    expect(typeof missSpan?.attrs['cache.hit']).toBe('boolean');
    expect(missSpan?.attrs['cache.hit']).toBe(false);
    expect(missSpan?.attrs['cache.hit_tier']).toBe('miss');

    // 2. Second get: L1 cache hit
    await svc.get('product:42', async () => ({ id: 42, title: 'Widget' }), 60);
    const hitSpan = spans.find(s => s.name === 'tricache.get' && s.attrs['cache.hit'] === true);
    expect(hitSpan).toBeDefined();
    // OTEL semconv boolean:
    expect(typeof hitSpan?.attrs['cache.hit']).toBe('boolean');
    expect(hitSpan?.attrs['cache.hit']).toBe(true);
    // OTEL semconv item tier:
    expect(hitSpan?.attrs['cache.item.tier']).toBe('memory');
    // Legacy backward-compatible tier:
    expect(hitSpan?.attrs['cache.hit_tier']).toBe('l1');
  });

  it('records span error status and exception when fetchFn throws', async () => {
    const { tracer, spans } = createMockTracer();
    svc = new CacheService({
      disableDisk: true,
      disableRedis: true,
      tracer,
    });

    const error = new Error('Database connection reset');
    await expect(
      svc.get('failing:key', async () => {
        throw error;
      }),
    ).rejects.toThrow('Database connection reset');

    const errorSpan = spans.find(s => s.name === 'tricache.get');
    expect(errorSpan).toBeDefined();
    expect(errorSpan?.status).toEqual({
      code: 2,
      message: 'Database connection reset',
    });
    expect(errorSpan?.exceptions).toHaveLength(1);
    expect(errorSpan?.exceptions[0]).toBe(error);
  });
});
