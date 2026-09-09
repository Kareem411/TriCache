import { describe, it, expect, vi, afterEach } from 'vitest';
import { consoleLogger } from '../src/types';

describe('consoleLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('debug is a no-op function', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    consoleLogger.debug('test debug message', { extra: 1 });
    expect(infoSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('info outputs [tricache] prefix with message and meta', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    consoleLogger.info('cache warmed', { keys: 10 });
    expect(infoSpy).toHaveBeenCalledWith('[tricache]', 'cache warmed', { keys: 10 });

    consoleLogger.info('no meta message');
    expect(infoSpy).toHaveBeenCalledWith('[tricache]', 'no meta message', '');
  });

  it('warn outputs [tricache] prefix with message and meta', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    consoleLogger.warn('memory limit nearing', { percent: 90 });
    expect(warnSpy).toHaveBeenCalledWith('[tricache]', 'memory limit nearing', { percent: 90 });

    consoleLogger.warn('simple warning');
    expect(warnSpy).toHaveBeenCalledWith('[tricache]', 'simple warning', '');
  });

  it('error outputs [tricache] prefix with message, meta, and error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sampleErr = new Error('Disk write failed');

    consoleLogger.error('failure saving key', { key: 'user:1' }, sampleErr);
    expect(errorSpy).toHaveBeenCalledWith('[tricache]', 'failure saving key', { key: 'user:1' }, sampleErr);

    consoleLogger.error('failure without meta or error');
    expect(errorSpy).toHaveBeenCalledWith('[tricache]', 'failure without meta or error', '', '');
  });
});
