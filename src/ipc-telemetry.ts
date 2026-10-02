import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { CacheMetrics, CacheHealthStatus, CacheOptions } from './types.js';

/**
 * Platform-agnostic IPC socket / named pipe path resolver.
 * - POSIX: `/tmp/tricache-<id>.sock` (or `$TMPDIR/tricache-<id>.sock`)
 * - Windows: `\\.\pipe\tricache-<id>`
 */
export function resolveIpcSocketPath(id: string | number = process.pid): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\tricache-${id}`;
  }
  const dir = process.env.TMPDIR || '/tmp';
  return path.join(dir, `tricache-${id}.sock`);
}

/**
 * Cache provider interface required by the IPC telemetry server.
 */
export interface IIpcCacheProvider {
  options?: CacheOptions;
  metrics(): CacheMetrics;
  stats?(): {
    l1: Record<string, unknown>;
    disk: Record<string, unknown>;
  };
  hotKeys?(n?: number): Array<{ key: string; hits: number; sizeBytes: number }>;
  health?(): CacheHealthStatus;
}

/**
 * Serialized telemetry payload transferred across the IPC bridge.
 */
export interface IpcMetricsPayload {
  pid: number;
  uptimeMs: number;
  timestamp: number;
  namespace?: string;
  l1MaxBytes?: number;
  metrics: CacheMetrics;
  stats?: {
    l1: Record<string, unknown>;
    disk: Record<string, unknown>;
  };
  hotKeys?: Array<{ key: string; hits: number; sizeBytes: number }>;
  health?: CacheHealthStatus;
}

/**
 * Lightweight, non-blocking IPC Telemetry Server.
 * Exposes real-time cache metrics over Unix domain sockets (POSIX) or Named Pipes (Windows).
 */
export class IpcTelemetryServer {
  private server: net.Server | null = null;
  public readonly socketPath: string;
  private _closed = false;
  private _exitHandler: (() => void) | null = null;
  private _sigintHandler: (() => void) | null = null;
  private _sigtermHandler: (() => void) | null = null;

  constructor(
    private readonly cache: IIpcCacheProvider,
    customSocketPath?: string,
  ) {
    this.socketPath = customSocketPath || resolveIpcSocketPath();
  }

  /**
   * Start listening on the IPC socket / pipe.
   */
  async start(): Promise<void> {
    if (this.server && this.server.listening) return;

    // Hygiene on POSIX: check if an orphaned socket file exists from a crashed run
    if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
      await new Promise<void>((resolve) => {
        const testSocket = net.createConnection(this.socketPath);
        testSocket.once('connect', () => {
          testSocket.destroy();
          // Active server already listening on this socket
          resolve();
        });
        testSocket.once('error', () => {
          testSocket.destroy();
          // Stale socket file: safe to unlink
          try {
            fs.unlinkSync(this.socketPath);
          } catch {
            // Ignore unlink errors
          }
          resolve();
        });
      });
    }

    this.server = net.createServer((socket) => {
      let buffer = '';

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) continue;

          // Non-blocking telemetry pull: pull stats snapshot on tick boundaries
          // using setImmediate so serialization never introduces event loop stalls.
          setImmediate(() => {
            if (socket.destroyed) return;
            try {
              let cmd = line;
              try {
                const parsed = JSON.parse(line);
                if (parsed && typeof parsed.cmd === 'string') {
                  cmd = parsed.cmd;
                }
              } catch {
                // Keep raw line as command
              }

              if (cmd === 'PING') {
                socket.write(JSON.stringify({ pong: true, timestamp: Date.now() }) + '\n');
                return;
              }

              if (cmd === 'GET_METRICS' || cmd === 'INSPECT') {
                const payload = this.getSnapshot();
                const serialized = JSON.stringify(payload) + '\n';
                socket.write(serialized);
                return;
              }

              socket.write(JSON.stringify({ error: `Unknown command: ${cmd}` }) + '\n');
            } catch (err) {
              if (!socket.destroyed) {
                socket.write(JSON.stringify({ error: (err as Error).message }) + '\n');
              }
            }
          });
        }
      });

      socket.on('error', () => {
        // Suppress client disconnection errors on IPC socket
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.removeListener('error', reject);
        resolve();
      });
    });

    // Register process termination handlers to guarantee socket hygiene
    this._exitHandler = () => this._unlinkSocket();
    this._sigintHandler = () => {
      this._unlinkSocket();
      process.exit(0);
    };
    this._sigtermHandler = () => {
      this._unlinkSocket();
      process.exit(0);
    };

    process.once('exit', this._exitHandler);
    process.once('SIGINT', this._sigintHandler);
    process.once('SIGTERM', this._sigtermHandler);
  }

  /**
   * Build a complete telemetry snapshot from the underlying cache provider.
   */
  getSnapshot(): IpcMetricsPayload {
    const metrics = this.cache.metrics();
    const stats = typeof this.cache.stats === 'function' ? this.cache.stats() : undefined;
    const hotKeys = typeof this.cache.hotKeys === 'function' ? this.cache.hotKeys(10) : undefined;
    const health = typeof this.cache.health === 'function' ? this.cache.health() : undefined;
    const l1MaxBytes = (this.cache.options?.l1MaxBytes as number | undefined) ?? metrics.l1?.maxBytes;

    return {
      pid: process.pid,
      uptimeMs: metrics.uptimeMs,
      timestamp: Date.now(),
      namespace: this.cache.options?.namespace || metrics.namespace,
      l1MaxBytes,
      metrics,
      stats,
      hotKeys,
      health,
    };
  }

  private _unlinkSocket(): void {
    if (this._closed) return;
    this._closed = true;
    try {
      this.server?.close();
    } catch {
      // Ignore close errors
    }
    if (process.platform !== 'win32') {
      try {
        if (fs.existsSync(this.socketPath)) {
          fs.unlinkSync(this.socketPath);
        }
      } catch {
        // Ignore unlink errors during teardown
      }
    }
  }

  /**
   * Gracefully close the IPC telemetry server and clean up handlers and sockets.
   */
  async close(): Promise<void> {
    if (this._exitHandler) {
      process.removeListener('exit', this._exitHandler);
      this._exitHandler = null;
    }
    if (this._sigintHandler) {
      process.removeListener('SIGINT', this._sigintHandler);
      this._sigintHandler = null;
    }
    if (this._sigtermHandler) {
      process.removeListener('SIGTERM', this._sigtermHandler);
      this._sigtermHandler = null;
    }

    this._unlinkSocket();

    return new Promise<void>((resolve) => {
      if (!this.server || !this.server.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  get isListening(): boolean {
    return Boolean(this.server && this.server.listening);
  }
}

/**
 * IPC Telemetry Client for connecting to and querying a running TriCache instance.
 */
export class IpcTelemetryClient {
  public readonly socketPath: string;

  constructor(socketPath?: string) {
    this.socketPath = socketPath || resolveIpcSocketPath();
  }

  /**
   * Fetch a live metrics snapshot from the IPC server.
   */
  async getMetrics(timeoutMs = 3000): Promise<IpcMetricsPayload> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = '';
      let timer: NodeJS.Timeout | null = setTimeout(() => {
        socket.destroy();
        reject(new Error(`IPC connection timeout (${timeoutMs}ms) to ${this.socketPath}`));
      }, timeoutMs);

      socket.once('connect', () => {
        socket.write('GET_METRICS\n');
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx !== -1) {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          const line = buffer.slice(0, newlineIdx).trim();
          socket.end();
          try {
            const data = JSON.parse(line);
            if (data.error) {
              reject(new Error(data.error));
            } else {
              resolve(data as IpcMetricsPayload);
            }
          } catch (e) {
            reject(new Error(`Failed to parse IPC payload: ${(e as Error).message}`));
          }
        }
      });

      socket.once('error', (err) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        reject(err);
      });
    });
  }

  /**
   * Send a ping over the IPC bridge and measure round-trip latency.
   */
  async ping(timeoutMs = 1000): Promise<number> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let timer: NodeJS.Timeout | null = setTimeout(() => {
        socket.destroy();
        reject(new Error(`IPC ping timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      socket.once('connect', () => {
        socket.write('PING\n');
      });

      socket.on('data', () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        socket.end();
        resolve(Date.now() - start);
      });

      socket.once('error', (err) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        reject(err);
      });
    });
  }
}

/**
 * Probe local system for active TriCache IPC sockets.
 */
export async function findActiveSockets(): Promise<string[]> {
  const active: string[] = [];

  if (process.platform === 'win32') {
    const currentPipe = resolveIpcSocketPath(process.pid);
    const client = new IpcTelemetryClient(currentPipe);
    try {
      await client.ping(100);
      active.push(currentPipe);
    } catch {
      // Pipe not present or not active on current PID
    }

    try {
      const { execFileSync } = await import('node:child_process');
      const stdout = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '[System.IO.Directory]::GetFiles("\\\\.\\pipe\\") | Where-Object { $_ -like "*tricache-*" }'],
        { timeout: 1500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const candidates = stdout
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter((name) => name.length > 0 && !active.includes(name));

      await Promise.all(
        candidates.map(async (pipePath) => {
          const testClient = new IpcTelemetryClient(pipePath);
          try {
            await testClient.ping(100);
            active.push(pipePath);
          } catch {
            // Stale or non-responsive pipe
          }
        }),
      );
    } catch {
      // Ignore enumeration errors (e.g. timeout or restricted environment)
    }

    return active;
  }

  const dir = process.env.TMPDIR || '/tmp';
  try {
    if (!fs.existsSync(dir)) return active;
    const entries = fs.readdirSync(dir);
    const candidates = entries
      .filter((name) => name.startsWith('tricache-') && name.endsWith('.sock'))
      .map((name) => path.join(dir, name));

    await Promise.all(
      candidates.map(async (sockPath) => {
        const client = new IpcTelemetryClient(sockPath);
        try {
          await client.ping(100);
          active.push(sockPath);
        } catch {
          // Stale socket
        }
      }),
    );
  } catch {
    // Directory scan error
  }

  return active;
}

// ── Rendering Utilities for CLI Top ──────────────────────────────────────────

export function renderProgressBar(ratio: number, width = 18): string {
  const clamped = Math.max(0, Math.min(1, isNaN(ratio) ? 0 : ratio));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

export function formatBytes(bytes: number): string {
  if (!bytes || isNaN(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatNumber(n: number): string {
  return (n ?? 0).toLocaleString();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return `${m}m ${remS}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}

/**
 * Render an ANSI/ASCII dashboard representation of the cache metrics.
 */
export function renderTopDashboard(payload: IpcMetricsPayload): string {
  const m = payload.metrics;
  const gets = m.gets;
  const l1Max = payload.l1MaxBytes || 200 * 1024 * 1024;
  const l1Used = m.l1.sizeBytes;
  const l1Pct = l1Max > 0 ? l1Used / l1Max : 0;
  const uptime = formatDuration(payload.uptimeMs);
  const ns = payload.namespace || '(default)';
  const pct = (r: number) => `${((r || 0) * 100).toFixed(1)}%`;

  const lines: string[] = [];
  lines.push('╔══════════════════════════════════════════════════════════════════════════════════════╗');
  lines.push(`║  TriCache Monitor [PID: ${String(payload.pid).padEnd(6)}]   Uptime: ${uptime.padEnd(8)}   Namespace: ${ns.padEnd(16)}║`);
  lines.push('╠══════════════════════════════════════════════════════════════════════════════════════╣');
  lines.push(`║  Hit Ratios & Tier Breakdown (Total Gets: ${formatNumber(gets.total).padEnd(12)})                         ║`);
  lines.push(`║    L1 (RAM):   [${renderProgressBar(gets.l1HitRate)}] ${pct(gets.l1HitRate).padStart(6)}   (${formatNumber(gets.l1Hits).padStart(8)} hits)             ║`);
  lines.push(`║    L1.5(Disk): [${renderProgressBar(gets.diskHitRate)}] ${pct(gets.diskHitRate).padStart(6)}   (${formatNumber(gets.diskHits).padStart(8)} hits)             ║`);
  lines.push(`║    L2 (Redis): [${renderProgressBar(gets.l2HitRate)}] ${pct(gets.l2HitRate).padStart(6)}   (${formatNumber(gets.l2Hits).padStart(8)} hits)             ║`);
  lines.push(`║    Misses:     [${renderProgressBar(gets.fetchRate)}] ${pct(gets.fetchRate).padStart(6)}   (${formatNumber(gets.fetches).padStart(8)} fetches)          ║`);
  lines.push(`║    Stampedes Saved: ${formatNumber(gets.stampedePrevented).padEnd(8)} coalesced concurrent requests               ║`);
  lines.push('╠══════════════════════════════════════════════════════════════════════════════════════╣');
  lines.push(`║  Memory & Storage Headroom                                                           ║`);
  lines.push(`║    L1 Memory:  [${renderProgressBar(l1Pct)}] ${formatBytes(l1Used).padStart(8)} / ${formatBytes(l1Max).padEnd(8)} (${formatNumber(m.l1.entries).padStart(6)} entries)  ║`);
  const diskFiles = m.disk?.files ?? 0;
  const diskKB = m.disk?.sizeKB ?? 0;
  const diskMaxKB = m.disk?.maxKB ?? 0;
  lines.push(`║    Disk Spill: ${formatBytes(diskKB * 1024).padStart(8)} / ${formatBytes(diskMaxKB * 1024).padEnd(8)} (${formatNumber(diskFiles).padStart(6)} files)                          ║`);
  lines.push('╠══════════════════════════════════════════════════════════════════════════════════════╣');
  lines.push(`║  Protection & Health Diagnostics                                                     ║`);
  const watchdog = m.disk?.latencyWatchdog;
  const bypassStage = watchdog ? `Stage ${watchdog.bypassStage} (${watchdog.bypassActive ? 'ACTIVE' : 'Normal'})` : 'Stage 0 (Normal)';
  const cbState = m.l2CircuitBreaker?.state || 'closed';
  lines.push(`║    Watchdog:   ${bypassStage.padEnd(20)} L2 Circuit Breaker: ${cbState.padEnd(20)}║`);
  if (watchdog) {
    const diskP95 = `${watchdog.diskP95Ms.toFixed(2)}ms`;
    const redisP95 = `${watchdog.redisP95Ms.toFixed(2)}ms`;
    lines.push(`║    Disk p95:   ${diskP95.padEnd(10)} Redis p95: ${redisP95.padEnd(10)} Bypassed: ${formatNumber(watchdog.bypassedTotal).padEnd(16)}║`);
  }
  const oomEvict = m.oom?.evictions ?? 0;
  lines.push(`║    OOM Evictions: ${formatNumber(oomEvict).padEnd(6)} SWR Revalidations: ${formatNumber(m.revalidations?.total ?? 0).padEnd(14)}            ║`);
  lines.push('╠══════════════════════════════════════════════════════════════════════════════════════╣');
  lines.push(`║  🔥 Top Hot Keys (Count-Min Sketch)                                                  ║`);

  if (!payload.hotKeys || payload.hotKeys.length === 0) {
    lines.push('║    (no hot keys recorded yet)                                                        ║');
  } else {
    payload.hotKeys.slice(0, 5).forEach(({ key, hits, sizeBytes }, idx) => {
      const displayKey = key.length > 34 ? `${key.slice(0, 31)}...` : key;
      const hitStr = `${formatNumber(hits)} hits`;
      const sizeStr = formatBytes(sizeBytes);
      const row = `  ${idx + 1}. ${displayKey.padEnd(36)} ${hitStr.padStart(14)} (${sizeStr})`;
      lines.push(`║${row.padEnd(86)}║`);
    });
  }
  lines.push('╚══════════════════════════════════════════════════════════════════════════════════════╝');
  return lines.join('\n');
}
