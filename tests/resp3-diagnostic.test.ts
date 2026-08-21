import { describe, it, expect, vi } from 'vitest';
import { CacheService } from '../src/cache-service.js';

describe('RESP3 Protocol Diagnostic & Warning Hint', () => {
  it('emits actionable warning when Redis handshake fails with unknown command HELLO / ProtocolError', () => {
    const warnSpy = vi.fn();
    const mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    };

    const cache = new CacheService({
      namespace: `resp3-test-${Date.now()}`,
      logger: mockLogger,
      disableRedis: true,
    });

    // Invoke diagnostic handler with simulated RESP2 proxy rejection error
    (cache as any)._checkAndLogResp3Hint(new Error("ERR unknown command 'HELLO'"));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Redis connection/protocol error detected. If your Redis endpoint or proxy'),
      expect.objectContaining({ hint: 'redisProtocol: 2' }),
    );
  });

  it('does not emit warning when redisProtocol is already explicitly set to 2', () => {
    const warnSpy = vi.fn();
    const mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    };

    const cache = new CacheService({
      namespace: `resp3-test-explicit-${Date.now()}`,
      logger: mockLogger,
      redisProtocol: 2,
      disableRedis: true,
    });

    (cache as any)._checkAndLogResp3Hint(new Error("ERR unknown command 'HELLO'"));

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
