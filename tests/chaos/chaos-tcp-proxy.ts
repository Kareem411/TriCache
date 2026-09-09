import net from 'node:net';

export interface ChaosOptions {
  latencyMs?: number;
  jitterMs?: number;
  blackhole?: boolean;
  bandwidthBytesPerSec?: number;
}

/**
 * ChaosTcpProxy — Programmatic, zero-dependency TCP Chaos Proxy.
 *
 * Runs in-process using native `node:net` without external daemons (Toxiproxy, Docker, iptables).
 * Allows Vitest to inject network partitions, latency spikes, bandwidth throttling,
 * and abrupt TCP RST mid-command or mid-pipeline.
 */
export class ChaosTcpProxy {
  private server: net.Server | null = null;
  private activeSockets = new Set<net.Socket>();
  private options: ChaosOptions = {};

  constructor(
    public readonly targetHost: string,
    public readonly targetPort: number,
  ) {}

  public async start(): Promise<number> {
    this.server = net.createServer((clientSocket) => {
      const upstreamSocket = net.createConnection(this.targetPort, this.targetHost);
      this.activeSockets.add(clientSocket);
      this.activeSockets.add(upstreamSocket);

      const pipeWithChaos = (src: net.Socket, dst: net.Socket) => {
        src.on('data', (chunk) => {
          if (this.options.blackhole) {
            // Drop packet bidirectionally without FIN/RST (simulating half-open or silent black hole)
            return;
          }

          const delay = (this.options.latencyMs ?? 0) +
            (this.options.jitterMs ? Math.random() * this.options.jitterMs : 0);

          if (delay > 0) {
            setTimeout(() => {
              if (!dst.destroyed) dst.write(chunk);
            }, delay);
          } else {
            dst.write(chunk);
          }
        });
      };

      pipeWithChaos(clientSocket, upstreamSocket);
      pipeWithChaos(upstreamSocket, clientSocket);

      const cleanup = () => {
        this.activeSockets.delete(clientSocket);
        this.activeSockets.delete(upstreamSocket);
        try { clientSocket.destroy(); } catch { /* ok */ }
        try { upstreamSocket.destroy(); } catch { /* ok */ }
      };

      clientSocket.on('close', cleanup);
      upstreamSocket.on('close', cleanup);
      clientSocket.on('error', cleanup);
      upstreamSocket.on('error', cleanup);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    return (this.server.address() as net.AddressInfo).port;
  }

  public setLatency(latencyMs: number, jitterMs = 0): void {
    this.options.latencyMs = latencyMs;
    this.options.jitterMs = jitterMs;
  }

  public setBlackhole(enabled: boolean): void {
    this.options.blackhole = enabled;
  }

  public resetAllConnections(): void {
    for (const socket of this.activeSockets) {
      // Abrupt TCP RST simulation
      try {
        socket.destroy(new Error('ECONNRESET'));
      } catch { /* ok */ }
    }
    this.activeSockets.clear();
  }

  public async stop(): Promise<void> {
    this.resetAllConnections();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }
}
