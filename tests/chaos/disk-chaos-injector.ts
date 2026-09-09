/**
 * DiskChaosInjector — Simulates cloud NVMe throttling, EBS burst exhaustion,
 * and intermittent disk controller faults (EIO, ENOSPC, EBUSY).
 */
export class DiskChaosInjector {
  private writeLatencyMs = 0;
  private failNextWrites = 0;
  private failureError: Error | null = null;

  /**
   * Injects artificial I/O latency (e.g. 450ms NVMe noisy-neighbor stall).
   */
  public setWriteLatency(ms: number): void {
    this.writeLatencyMs = ms;
  }

  /**
   * Injects consecutive simulated filesystem failures.
   */
  public failNext(count: number, error: Error = new Error('EIO: i/o error, write')): void {
    this.failNextWrites = count;
    this.failureError = error;
  }

  /**
   * Wraps an async filesystem task with the active chaos injection rules.
   */
  public async execute<T>(task: () => Promise<T>): Promise<T> {
    if (this.failNextWrites > 0) {
      this.failNextWrites--;
      throw this.failureError ?? new Error('EIO: i/o error, write');
    }

    if (this.writeLatencyMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.writeLatencyMs));
    }

    return await task();
  }

  public reset(): void {
    this.writeLatencyMs = 0;
    this.failNextWrites = 0;
    this.failureError = null;
  }
}
