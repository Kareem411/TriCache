import { describe, it, expect, afterEach, vi } from 'vitest';
import { CacheService } from '../src/cache-service';

describe('Redis Streams Invalidation Backplane (backplaneMode: stream)', () => {
  let svc: CacheService | null = null;

  afterEach(async () => {
    if (svc) {
      await svc.destroy();
      svc = null;
    }
  });

  it('configures stream options with default and custom values', () => {
    svc = new CacheService({
      namespace: 'test-stream',
      backplaneMode: 'stream',
      backplaneStreamMaxLen: 5000,
      backplaneStreamBlockMs: 1000,
      disableRedis: true,
      disableDisk: true,
    });

    const m = svc.metrics();
    expect(m.backplane.mode).toBe('stream');
  });

  it('publishes invalidations using XADD with approximate MAXLEN trimming and cluster hash tag', async () => {
    const xaddCalls: Array<{ streamKey: string; args: string[] }> = [];

    const mockRedis = {
      xadd: vi.fn(async (streamKey: string, ...args: string[]) => {
        xaddCalls.push({ streamKey, args });
        return '1724240000000-0';
      }),
      disconnect: vi.fn(async () => {}),
      status: 'ready',
    };

    svc = new CacheService({
      namespace: 'org-sales',
      backplaneMode: 'stream',
      backplaneStreamMaxLen: 10_000,
      disableRedis: false,
      disableDisk: true,
    });

    // Inject mock redis
    (svc as any).redis = mockRedis;
    (svc as any)._redisDisabled = false;

    // Delete a key -> triggers publishInvalidation('del', 'user:42')
    await svc.delete('user:42');

    expect(mockRedis.xadd).toHaveBeenCalled();
    expect(xaddCalls.length).toBeGreaterThanOrEqual(1);

    const call = xaddCalls[0];
    // Verify single-slot hash tag
    expect(call.streamKey).toBe('tricache:stream:{org-sales}');
    // Verify MAXLEN ~ 10000
    expect(call.args).toContain('MAXLEN');
    expect(call.args).toContain('~');
    expect(call.args).toContain('10000');
    expect(call.args).toContain('op');
    expect(call.args).toContain('del');
    expect(call.args).toContain('key');
    expect(call.args).toContain('org-sales:user:42');
  });

  it('processes peer stream invalidations and evicts local L1', async () => {
    svc = new CacheService({
      namespace: 'org-inventory',
      backplaneMode: 'stream',
      disableRedis: true,
      disableDisk: true,
    });

    // Populate L1
    await svc.set('item:100', { qty: 50 });
    expect(svc.getIfFresh('item:100')).toEqual({ qty: 50 });

    // Simulate stream message from a peer instance
    const streamMessage = JSON.stringify({
      op: 'del',
      key: 'org-inventory:item:100',
      src: 'peer-instance-999',
    });

    svc._handleBackplaneMessage(streamMessage);

    // L1 should now be evicted
    expect(svc.getIfFresh('item:100')).toBeNull();
  });

  it('skips own stream messages based on instanceId', async () => {
    svc = new CacheService({
      namespace: 'org-inventory',
      backplaneMode: 'stream',
      disableRedis: true,
      disableDisk: true,
    });

    await svc.set('item:200', { qty: 20 });
    const instanceId = (svc as any).instanceId;

    // Simulate stream message originating from this same instance
    const ownMessage = JSON.stringify({
      op: 'del',
      key: 'org-inventory:item:200',
      src: instanceId,
    });

    svc._handleBackplaneMessage(ownMessage);

    // Own message was skipped -> L1 remains untouched
    expect(svc.getIfFresh('item:200')).toEqual({ qty: 20 });
    expect(svc.metrics().backplane.skipped).toBe(1);
  });

  it('replays missed events after reconnect using _lastStreamId', async () => {
    let xreadCalls = 0;
    const streamEntries: Array<[string, string[]]> = [
      ['1724240000001-0', ['op', 'del', 'key', 'org-reconnect:cached:1', 'src', 'peer-1']],
      ['1724240000002-0', ['op', 'del', 'key', 'org-reconnect:cached:2', 'src', 'peer-1']],
    ];

    const mockStreamClient = {
      xread: vi.fn(async (_block: string, _ms: number, _streams: string, _key: string, lastId: string) => {
        xreadCalls++;
        if (lastId === '1724240000000-0') {
          // Replay the 2 missed entries
          return [['tricache:stream:{org-reconnect}', streamEntries]];
        }
        await new Promise(r => setTimeout(r, 100));
        return null;
      }),
      disconnect: vi.fn(async () => {}),
      on: vi.fn(),
    };

    svc = new CacheService({
      namespace: 'org-reconnect',
      backplaneMode: 'stream',
      disableRedis: true,
      disableDisk: true,
    });

    // Populate L1 entries
    await svc.set('cached:1', 'value1');
    await svc.set('cached:2', 'value2');
    expect(svc.getIfFresh('cached:1')).toBe('value1');
    expect(svc.getIfFresh('cached:2')).toBe('value2');

    // Simulate that the stream consumer is at position '1724240000000-0'
    (svc as any)._lastStreamId = '1724240000000-0';
    (svc as any).streamClient = mockStreamClient;
    (svc as any)._redisDisabled = false;

    // Start stream worker loop and let one iteration run
    void (svc as any)._startStreamConsumer();
    await new Promise(resolve => setTimeout(resolve, 50));

    // L1 should be updated from replayed entries
    expect(svc.getIfFresh('cached:1')).toBeNull();
    expect(svc.getIfFresh('cached:2')).toBeNull();
    expect(xreadCalls).toBeGreaterThanOrEqual(1);
    expect((svc as any)._lastStreamId).toBe('1724240000002-0');
    expect(svc.metrics().backplane.streamReplays).toBeGreaterThanOrEqual(1);

    await svc.destroy();
    svc = null;
  });

  it('handles stream gap error by flushing L1 and resetting _lastStreamId', async () => {
    const mockStreamClient = {
      xread: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 20));
        throw new Error('NOGROUP or ID smaller than stream earliest entry (trimmed)');
      }),
      disconnect: vi.fn(async () => {}),
      on: vi.fn(),
    };

    svc = new CacheService({
      namespace: 'org-gap',
      backplaneMode: 'stream',
      disableRedis: true,
      disableDisk: true,
    });

    await svc.set('stale:key', 'old-data');
    (svc as any)._lastStreamId = '1000-0';
    (svc as any).streamClient = mockStreamClient;
    (svc as any)._redisDisabled = false;

    void (svc as any)._startStreamConsumer();
    await new Promise(resolve => setTimeout(resolve, 50));

    // L1 should be cleared on gap detection
    expect(svc.getIfFresh('stale:key')).toBeNull();
    expect(svc.metrics().backplane.streamGaps).toBeGreaterThanOrEqual(1);
    expect((svc as any)._lastStreamId).toBe('$');

    await svc.destroy();
    svc = null;
  });

  it('cleanly disconnects stream client on destroy() without hanging', async () => {
    const mockStreamClient = {
      xread: vi.fn(async () => new Promise(r => setTimeout(r, 5000))), // simulated hanging long-poll
      disconnect: vi.fn(async () => {}),
      on: vi.fn(),
    };

    svc = new CacheService({
      namespace: 'org-teardown',
      backplaneMode: 'stream',
      disableRedis: false,
      disableDisk: true,
    });

    (svc as any).streamClient = mockStreamClient;

    await svc.destroy();

    expect(mockStreamClient.disconnect).toHaveBeenCalled();
    expect((svc as any)._destroyed).toBe(true);
    svc = null;
  });
});
