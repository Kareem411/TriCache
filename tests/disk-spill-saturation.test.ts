import { describe, it, expect, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { readdirSync, rmSync } from 'fs';

describe('Disk Spill Saturation & Full Recovery Test', () => {
  let cache: CacheService | null = null;
  let diskDir: string;

  afterEach(async () => {
    if (cache) {
      await cache.destroy();
      cache = null;
    }
    if (diskDir) {
      try {
        rmSync(diskDir, { recursive: true, force: true });
      } catch {
        /* ok */
      }
    }
  });

  it('bounds disk usage under heavy saturation and maintains LRU eviction stability', async () => {
    diskDir = join(tmpdir(), `tricache-sat-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const diskMaxBytes = 50 * 1024; // 50 KB ceiling

    cache = new CacheService({
      namespace: `saturation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      disableRedis: true,
      disableDisk: false,
      l1MaxBytes: 10 * 1024, // 10 KB L1 forces early spill to disk
      l1MaxEntries: 10,
      diskCacheDir: diskDir,
      diskMaxBytes,
      diskEntryMaxBytes: 5 * 1024,
    });

    const payloadSize = 1500; // ~1.5 KB per item
    const totalEntries = 80;

    // Saturate the cache by writing 80 items (~120 KB total payload into 50 KB disk quota)
    for (let i = 0; i < totalEntries; i++) {
      const payload = {
        id: i,
        data: 'X'.repeat(payloadSize),
        timestamp: Date.now(),
      };
      await cache.set(`saturated:item:${i}`, payload, 600);
    }

    // Allow async disk write queue to settle across thread workers (with polling for slow CI I/O)
    let stats = cache.stats();
    for (let attempt = 0; attempt < 30 && stats.disk.files === 0; attempt++) {
      await new Promise(r => setTimeout(r, 100));
      stats = cache.stats();
    }

    // Verify disk stats are tracked and within reasonable quota limits
    expect(stats.disk.files).toBeGreaterThan(0);
    expect(stats.disk.sizeKB).toBeLessThanOrEqual((diskMaxBytes / 1024) * 1.5);

    // Verify no orphaned temporary lock files (.tmp) remain in the directory
    const files = readdirSync(diskDir, { recursive: true }) as string[];
    const tmpFiles = files.filter(f => typeof f === 'string' && f.endsWith('.tmp'));
    expect(tmpFiles.length).toBe(0);

    // Most recent entries should remain intact and accessible
    const recent = await cache.get(`saturated:item:${totalEntries - 1}`, async () => null, 600);
    expect(recent).not.toBeNull();
    expect((recent as any)?.id).toBe(totalEntries - 1);
  });
});
