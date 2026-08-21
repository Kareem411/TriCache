import { describe, it, expect, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import type { ICacheMeter, ICacheCounter, ICacheObservableGauge, ICacheBatchObservableCallback } from '../src/types.js';

describe('OpenTelemetry Native Metrics (ICacheMeter)', () => {
  let cache: CacheService | null = null;

  afterEach(async () => {
    if (cache) {
      await cache.destroy();
      cache = null;
    }
  });

  it('registers counters and observable gauges with OpenTelemetry Meter', async () => {
    const recordedCounters: Record<string, number> = {};
    const recordedGauges: Record<string, number> = {};
    let batchCallback: ICacheBatchObservableCallback | null = null;

    const mockMeter: ICacheMeter = {
      createCounter(name: string): ICacheCounter {
        recordedCounters[name] = 0;
        return {
          add(value: number) {
            recordedCounters[name] = (recordedCounters[name] || 0) + value;
          },
        };
      },
      createObservableGauge(name: string): ICacheObservableGauge {
        return { _isGauge: true, name } as unknown as ICacheObservableGauge;
      },
      addBatchObservableCallback(cb: ICacheBatchObservableCallback) {
        batchCallback = cb;
      },
    };

    cache = new CacheService({
      namespace: `otel-${Date.now()}`,
      meter: mockMeter,
      disableRedis: true,
      disableDisk: true,
    });

    // Verify observable batch callback was registered
    expect(batchCallback).not.toBeNull();

    // Perform get, miss, and set operations
    await cache.get('user:100', async () => ({ id: 100, name: 'Alice' }), 300);
    await cache.get('user:100', async () => ({ id: 100, name: 'Alice' }), 300);
    await cache.set('user:200', { id: 200, name: 'Bob' }, 300);
    await cache.delete('user:200');

    // Trigger observable gauge callback
    if (batchCallback) {
      (batchCallback as ICacheBatchObservableCallback)({
        observe(metric: any, val: number) {
          recordedGauges[metric.name] = val;
        },
      });
    }

    // Verify monotonic counters were created and incremented
    expect(recordedCounters['tricache.gets.total']).toBe(2);
    expect(recordedCounters['tricache.l1.hits']).toBe(1);
    expect(recordedCounters['tricache.fetches']).toBe(1);
    expect(recordedCounters['tricache.sets.total']).toBe(1); // 1 from explicit set
    expect(recordedCounters['tricache.deletes.total']).toBe(1);

    // Verify observable gauges reported metrics
    expect(recordedGauges['tricache.l1.entries']).toBe(1);
    expect(recordedGauges['tricache.l1.bytes']).toBeGreaterThan(0);
    expect(recordedGauges['tricache.bloom.fpr']).toBe(0);
  });
});
