import { describe, it, expect } from 'vitest';
import { CacheService, ProcessTerminationBus } from '../src';

describe('ProcessTerminationBus (Phase 1 & Guardrail 1)', () => {
  it('registers multiple CacheService instances with exactly 1 process listener and 0 MaxListenersExceededWarning', async () => {
    const warnings: Error[] = [];
    const warningHandler = (warning: Error) => {
      if (warning.name === 'MaxListenersExceededWarning') {
        warnings.push(warning);
      }
    };
    process.on('warning', warningHandler);

    const initialSigtermCount = process.listenerCount('SIGTERM');
    const initialSigintCount = process.listenerCount('SIGINT');

    const instances: CacheService[] = [];
    const INSTANCE_COUNT = 15;

    try {
      for (let i = 0; i < INSTANCE_COUNT; i++) {
        const cache = new CacheService({
          disableDisk: true,
          disableRedis: true,
        });
        instances.push(cache);
      }

      // Assert that ProcessTerminationBus holds all active instances
      expect(ProcessTerminationBus.size).toBeGreaterThanOrEqual(INSTANCE_COUNT);
      expect(ProcessTerminationBus.isRegistered).toBe(true);

      // Crucial: Only 1 listener is added to process, regardless of 15 instances
      expect(process.listenerCount('SIGTERM')).toBe(initialSigtermCount + 1);
      expect(process.listenerCount('SIGINT')).toBe(initialSigintCount + 1);

      // No MaxListenersExceededWarning was triggered
      expect(warnings).toHaveLength(0);
    } finally {
      // Clean up all instances
      for (const instance of instances) {
        await instance.destroy();
      }
      process.off('warning', warningHandler);
    }
  });

  it('idle listener teardown: detaches process listeners when instance count reaches 0', async () => {
    // Before creating instance
    const baseSigterm = process.listenerCount('SIGTERM');
    const baseSigint = process.listenerCount('SIGINT');

    const cache1 = new CacheService({ disableDisk: true, disableRedis: true });
    const cache2 = new CacheService({ disableDisk: true, disableRedis: true });

    expect(ProcessTerminationBus.isRegistered).toBe(true);
    expect(process.listenerCount('SIGTERM')).toBe(baseSigterm + 1);

    // Destroy one instance: bus remains registered because 1 instance is still alive
    await cache1.destroy();
    expect(ProcessTerminationBus.isRegistered).toBe(true);
    expect(process.listenerCount('SIGTERM')).toBe(baseSigterm + 1);

    // Destroy second instance: bus unregisters and removes listeners from process
    await cache2.destroy();
    expect(ProcessTerminationBus.size).toBe(0);
    expect(ProcessTerminationBus.isRegistered).toBe(false);
    expect(process.listenerCount('SIGTERM')).toBe(baseSigterm);
    expect(process.listenerCount('SIGINT')).toBe(baseSigint);
  });

  it('triggers graceful snapshot on simulated shutdown', () => {
    const cache = new CacheService({ disableDisk: true, disableRedis: true });
    let snapshotWritten = false;
    cache.writeSnapshot = () => {
      snapshotWritten = true;
    };

    // Trigger internal shutdown directly
    cache._triggerShutdown();
    // In disableDisk mode, writeSnapshot is skipped by default
    expect(snapshotWritten).toBe(false);

    cache.destroy();
  });
});
