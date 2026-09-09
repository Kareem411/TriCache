import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoundedDiskQueue, DiskTier } from '../../src/disk-tier.js';
import { CacheService } from '../../src/cache-service.js';
import { ChaosTcpProxy } from './chaos-tcp-proxy.js';
import { DiskChaosInjector } from './disk-chaos-injector.js';
import { consoleLogger } from '../../src/types.js';

describe('Milestone 1: Fleet Chaos Engineering & Resilience', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `tricache-chaos-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ok */ }
  });

  // ── 1. Noisy Neighbor NVMe Backpressure & Canary Breaker ─────────────────

  describe('BoundedDiskQueue (NVMe Stalls & Libuv Protection)', () => {
    it('sheds writes immediately when queue hits maxPending without touching threadpool', async () => {
      // Concurrency: 1, MaxPending: 2, Timeout: 200ms
      const queue = new BoundedDiskQueue(1, 2, 200, 5, 1000);
      let activeRunning = 0;
      let maxSeenActive = 0;

      const slowTask = async () => {
        activeRunning++;
        maxSeenActive = Math.max(maxSeenActive, activeRunning);
        await new Promise<void>((res) => setTimeout(res, 50));
        activeRunning--;
        return 'ok';
      };

      // Launch 10 simultaneous writes
      const promises = Array.from({ length: 10 }, () => queue.schedule(slowTask));
      const results = await Promise.all(promises);

      // maxSeenActive should never exceed maxConcurrent (1)
      expect(maxSeenActive).toBe(1);

      // Total completed: 1 (active) + 2 (pending) = 3; remaining 7 must be shed (null)
      const successful = results.filter((r) => r === 'ok');
      const dropped = results.filter((r) => r === null);

      expect(successful.length).toBe(3);
      expect(dropped.length).toBe(7);

      const stats = queue.getStats();
      expect(stats.spillsDropped).toBe(7);
      expect(stats.activeWrites).toBe(0);
      expect(stats.pendingWrites).toBe(0);
      expect(stats.circuitState).toBe('closed');
    });

    it('trips circuit breaker on consecutive timeouts and recovers via Half-Open canary probe', async () => {
      // Failure threshold: 3, Cooldown: 60ms, Write Timeout: 20ms
      const queue = new BoundedDiskQueue(2, 10, 20, 3, 60);

      // Task that stalls for 80ms (violating 20ms write timeout)
      const stallingTask = () => new Promise<string>((res) => setTimeout(() => res('done'), 80));

      // Execute 3 consecutive slow writes -> each times out
      const r1 = await queue.schedule(stallingTask);
      const r2 = await queue.schedule(stallingTask);
      const r3 = await queue.schedule(stallingTask);

      expect(r1).toBeNull();
      expect(r2).toBeNull();
      expect(r3).toBeNull();

      // Circuit should now be OPEN
      expect(queue.getStats().circuitState).toBe('open');

      // Subsequent write during OPEN is dropped immediately (sub-millisecond fast drop)
      const tStart = performance.now();
      const rOpen = await queue.schedule(async () => 'should not run');
      const tElapsed = performance.now() - tStart;

      expect(rOpen).toBeNull();
      expect(tElapsed).toBeLessThan(10); // immediate return without touching libuv

      // Wait for 70ms cooldown to expire -> transitions to HALF-OPEN
      await new Promise<void>((res) => setTimeout(res, 70));

      // In HALF-OPEN mode:
      // Launch 2 concurrent writes: 1 canary permitted, 2nd rejected immediately
      const canaryTask = vi.fn(async () => {
        await new Promise<void>((res) => setTimeout(res, 10));
        return 'canary-success';
      });

      const [pCanary, pConcurrent] = await Promise.all([
        queue.schedule(canaryTask),
        queue.schedule(async () => 'concurrent-probe'),
      ]);

      expect(pCanary).toBe('canary-success');
      expect(pConcurrent).toBeNull(); // concurrent caller rejected during canary
      expect(canaryTask).toHaveBeenCalledTimes(1);

      // After canary success, circuit breaker transitions to CLOSED
      expect(queue.getStats().circuitState).toBe('closed');

      // Subsequent writes now succeed normally
      const normal = await queue.schedule(async () => 'healthy');
      expect(normal).toBe('healthy');
    });

    it('trips back to OPEN if the canary write in HALF-OPEN fails', async () => {
      const queue = new BoundedDiskQueue(1, 10, 20, 2, 50);

      // Trigger 2 failures to trip to OPEN
      await queue.schedule(() => new Promise((res) => setTimeout(res, 40)));
      await queue.schedule(() => new Promise((res) => setTimeout(res, 40)));
      expect(queue.getStats().circuitState).toBe('open');

      // Wait for cooldown
      await new Promise<void>((res) => setTimeout(res, 60));

      // Canary fails (times out)
      const canaryResult = await queue.schedule(() => new Promise((res) => setTimeout(res, 40)));
      expect(canaryResult).toBeNull();

      // Must trip immediately back to OPEN (not staying half-open)
      expect(queue.getStats().circuitState).toBe('open');
    });
  });

  // ── 2. DiskTier & CacheService Integration with Backpressure ─────────────

  describe('DiskTier Backpressure Integration', () => {
    it('surfaces backpressure stats in disk stats and handles NVMe stalls gracefully', async () => {
      const disk = new DiskTier({
        dir: tmpDir,
        maxBytes: 10 * 1024 * 1024,
        entryMaxBytes: 1024 * 1024,
        forbiddenPrefixes: [],
        logger: consoleLogger,
        diskMaxConcurrentWrites: 2,
        diskMaxPendingWrites: 4,
        diskWriteTimeoutMs: 50,
        diskCircuitBreakerThreshold: 3,
      });

      const stats = disk.stats;
      expect(stats.backpressure).toBeDefined();
      expect(stats.backpressure?.activeWrites).toBe(0);
      expect(stats.backpressure?.circuitState).toBe('closed');
      expect(stats.backpressure?.spillsDropped).toBe(0);

      // Write valid entry
      const codec = (disk as any).codec;
      const data = codec.encode({ hello: 'world' });
      await disk.save('key:1', {
        data,
        isCompressed: true,
        size: data.length,
        hits: 1,
        lastAccess: Date.now(),
        priority: 1,
        expiresAt: Date.now() + 60_000,
      });

      expect(disk.stats.files).toBe(1);
      const loaded = disk.load('key:1');
      expect(loaded).not.toBeNull();
      expect(codec.decode(loaded?.data as Buffer)).toEqual({ hello: 'world' });
    });

    it('surfaces disk backpressure in CacheService.stats()', async () => {
      const cache = CacheService.create({
        namespace: 'chaos_test',
        diskCacheDir: tmpDir,
        disableRedis: true,
        diskMaxConcurrentWrites: 2,
        diskMaxPendingWrites: 8,
      });

      const serviceStats = cache.stats();
      expect(serviceStats.disk.backpressure).toBeDefined();
      expect(serviceStats.disk.backpressure?.circuitState).toBe('closed');
      expect(serviceStats.disk.backpressure?.pendingWrites).toBe(0);

      await cache.destroy();
    });
  });

  // ── 3. Clock Drift & Leap Second Epsilon-Fencing ─────────────────────────

  describe('Clock Drift & Leap Second Epsilon-Fencing', () => {
    it('accepts snapshots written up to clockSkewToleranceMs into the future', async () => {
      const snapshotPath = path.join(tmpDir, 'skew-snapshot.msgpack');
      const cache = CacheService.create({
        namespace: 'skew_test',
        snapshotPath,
        disableRedis: true,
        clockSkewToleranceMs: 300,
      });

      // Write an entry, create snapshot, then skew writtenAt by +150ms
      await cache.set('user:42', { name: 'Alice' }, 300);
      cache.writeSnapshot();
      await cache.clear();

      // Read snapshot, modify writtenAt to be 150ms in the future
      const raw = fs.readFileSync(snapshotPath);
      const decoded = (cache as any).codec.decode(raw);
      decoded.writtenAt = Date.now() + 150;
      fs.writeFileSync(snapshotPath, (cache as any).codec.encode(decoded));

      // Load snapshot: within 300ms tolerance -> must accept and populate L1
      cache.loadSnapshot();

      const fresh = cache.getIfFresh('user:42');
      expect(fresh).toEqual({ name: 'Alice' });

      await cache.destroy();
    });

    it('rejects snapshots written beyond clockSkewToleranceMs into the future', async () => {
      const snapshotPath = path.join(tmpDir, 'skew-reject-snapshot.msgpack');
      const cache = CacheService.create({
        namespace: 'skew_reject',
        snapshotPath,
        disableRedis: true,
        clockSkewToleranceMs: 200,
      });

      // Write an entry, create snapshot, then skew writtenAt by +600ms (exceeds 200ms)
      await cache.set('bad:key', { bad: true }, 300);
      cache.writeSnapshot();
      await cache.clear();

      const raw = fs.readFileSync(snapshotPath);
      const decoded = (cache as any).codec.decode(raw);
      decoded.writtenAt = Date.now() + 600;
      fs.writeFileSync(snapshotPath, (cache as any).codec.encode(decoded));

      // Load snapshot: exceeds tolerance -> must be rejected
      cache.loadSnapshot();

      const fresh = cache.getIfFresh('bad:key');
      expect(fresh).toBeNull();

      await cache.destroy();
    });

    it('remains resilient to backward wall-clock jumps (monotonic tag synchronization)', async () => {
      const cache = CacheService.create({
        namespace: 'monotonic_tag',
        disableRedis: true,
        tagStrategy: 'generational',
        tagVersionTtlMs: 2000,
      });

      // Seed local tag version
      (cache as any)._setLocalTagVersion('users', 1);

      // Simulate wall-clock jumping backward 1 hour
      const realDateNow = Date.now;
      try {
        Date.now = () => realDateNow() - 3_600_000;

        // Reading tag version should not produce negative duration error or stale misbehavior
        const ver = await (cache as any)._getTagVersion('users');
        expect(ver).toBe(1);
      } finally {
        Date.now = realDateNow;
        await cache.destroy();
      }
    });
  });

  // ── 4. TCP Chaos Proxy & Connection Resets ───────────────────────────────

  describe('ChaosTcpProxy (Network Partition & TCP RST Defense)', () => {
    let mockRedisServer: net.Server;
    let mockRedisPort: number;
    let proxy: ChaosTcpProxy;
    let proxyPort: number;

    beforeEach(async () => {
      // Minimal mock TCP server simulating Redis RESP ping/pong
      mockRedisServer = net.createServer((sock) => {
        sock.on('data', (buf) => {
          const str = buf.toString('utf8');
          if (str.includes('PING')) {
            sock.write('+PONG\r\n');
          } else if (str.includes('GET')) {
            sock.write('$-1\r\n'); // Null bulk string
          } else {
            sock.write('+OK\r\n');
          }
        });
      });

      await new Promise<void>((res) => {
        mockRedisServer.listen(0, '127.0.0.1', () => res());
      });
      mockRedisPort = (mockRedisServer.address() as net.AddressInfo).port;

      // Start Chaos Proxy targeting the mock server
      proxy = new ChaosTcpProxy('127.0.0.1', mockRedisPort);
      proxyPort = await proxy.start();
    });

    afterEach(async () => {
      await proxy.stop();
      await new Promise<void>((res) => mockRedisServer.close(() => res()));
    });

    it('transparently proxies TCP traffic when no chaos is active', async () => {
      const client = net.createConnection(proxyPort, '127.0.0.1');
      await new Promise<void>((res) => client.once('connect', res));

      const responsePromise = new Promise<string>((res) => {
        client.once('data', (chunk) => res(chunk.toString('utf8')));
      });

      client.write('*1\r\n$4\r\nPING\r\n');
      const resp = await responsePromise;
      expect(resp).toBe('+PONG\r\n');

      client.destroy();
    });

    it('injects jittered latency cleanly into TCP streams', async () => {
      proxy.setLatency(40, 10);

      const client = net.createConnection(proxyPort, '127.0.0.1');
      await new Promise<void>((res) => client.once('connect', res));

      const tStart = performance.now();
      const responsePromise = new Promise<string>((res) => {
        client.once('data', (chunk) => res(chunk.toString('utf8')));
      });

      client.write('*1\r\n$4\r\nPING\r\n');
      const resp = await responsePromise;
      const tElapsed = performance.now() - tStart;

      expect(resp).toBe('+PONG\r\n');
      expect(tElapsed).toBeGreaterThanOrEqual(35);

      client.destroy();
    });

    it('abruptly terminates active sockets on resetAllConnections (TCP RST)', async () => {
      const client = net.createConnection(proxyPort, '127.0.0.1');
      await new Promise<void>((res) => client.once('connect', res));

      const closePromise = new Promise<void>((res) => {
        client.on('close', () => res());
        client.on('error', () => { /* expected on RST */ res(); });
      });

      // Inject abrupt TCP reset
      proxy.resetAllConnections();

      await closePromise;
      expect(client.destroyed).toBe(true);
    });

    it('drops packets silently when blackhole is enabled (simulating partition)', async () => {
      proxy.setBlackhole(true);

      const client = net.createConnection(proxyPort, '127.0.0.1');
      await new Promise<void>((res) => client.once('connect', res));

      let receivedData = false;
      client.on('data', () => { receivedData = true; });

      client.write('*1\r\n$4\r\nPING\r\n');

      // Wait 50ms to verify zero bytes arrived
      await new Promise<void>((res) => setTimeout(res, 50));
      expect(receivedData).toBe(false);

      client.destroy();
    });
  });

  // ── 5. DiskChaosInjector ─────────────────────────────────────────────────

  describe('DiskChaosInjector', () => {
    it('simulates NVMe latency stalls and intermittent I/O failures', async () => {
      const injector = new DiskChaosInjector();

      // Test latency injection
      injector.setWriteLatency(30);
      const t0 = performance.now();
      const res = await injector.execute(async () => 'written');
      const dt = performance.now() - t0;

      expect(res).toBe('written');
      expect(dt).toBeGreaterThanOrEqual(25);

      // Test failure injection
      injector.failNext(1, new Error('ENOSPC: no space left on device'));
      await expect(injector.execute(async () => 'fail')).rejects.toThrow('ENOSPC');

      // Next execution succeeds after count exhausted
      const recovered = await injector.execute(async () => 'ok');
      expect(recovered).toBe('ok');
    });
  });
});
