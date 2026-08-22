/**
 * Disk-tier byte-accounting regression tests.
 *
 * Guards the invariant: every file the janitor deletes must also release its
 * byte count from diskUsageBytes — otherwise the in-memory counter drifts above
 * reality and the tier stops accepting writes early (phantom "disk cap hit").
 *
 * The legacy (V1) decrypt-failure purge path deleted the file WITHOUT
 * decrementing diskUsageBytes. Runs in file-only mode (node:sqlite stubbed out)
 * because the SQLite index path recomputes counters from the meta table and
 * would mask the drift.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { DiskTier } from '../src/disk-tier.js';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const proc = process as unknown as { getBuiltinModule(m: string): unknown };
const origGetBuiltinModule = proc.getBuiltinModule;

describe('DiskTier byte accounting on corrupt-entry purge', () => {
  let dir = '';

  afterEach(() => {
    proc.getBuiltinModule = origGetBuiltinModule;
    if (dir) {
      for (let i = 0; i < 5; i++) {
        try { rmSync(dir, { recursive: true, force: true }); break; } catch { /* Windows handle lag */ }
      }
      dir = '';
    }
  });

  it('releases bytes when the legacy purge path deletes an undecryptable file', () => {
    // Force file-only mode: hide node:sqlite so the tier walks the filesystem
    // and reports counters from real files instead of the SQLite meta table.
    proc.getBuiltinModule = (m: string) => (m === 'node:sqlite' ? undefined : origGetBuiltinModule.call(process, m));

    dir = join(tmpdir(), `tricache-acct-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const disk = new DiskTier({
      dir,
      maxBytes: 64 * 1024 * 1024,
      entryMaxBytes: 8 * 1024 * 1024,
      forbiddenPrefixes: [],
      logger: silentLogger,
    });

    // Plant a 2 MB legacy-format (V1) file that cannot be decrypted: real
    // DISK_MAGIC prefix ("DTIERV1\0", disk-tier.ts) but no CacheEncryption is
    // configured on this tier → decrypt() throws 'entry is encrypted but no
    // encryption configured' → legacy purge path deletes the file.
    const hash = createHash('sha256').update('corrupt-key').digest('hex');
    const bucket = join(dir, hash.slice(0, 2));
    mkdirSync(bucket, { recursive: true });
    const v1Magic = Buffer.from([0x44, 0x54, 0x49, 0x45, 0x52, 0x56, 0x31, 0x00]); // "DTIERV1\0"
    const blob = Buffer.concat([v1Magic, Buffer.alloc(2 * 1024 * 1024, 7)]);
    writeFileSync(join(bucket, hash), blob);

    // Force the FILE-ONLY code path (the one carrying the accounting bug).
    // node:sqlite binds at module-import time and ensureDir() lazily initialises
    // the index on FIRST use, so order matters: run once to trigger that lazy
    // init, THEN sever the index and re-walk — the exact state of a Node without
    // node:sqlite (or where SQLite init failed), which counts via filesystem walk.
    const d = disk as unknown as {
      _db: unknown;
      usageCounted: boolean;
      ensureUsageCounted(): void;
    };
    d.ensureUsageCounted(); // lazy ensureDir + _initSqlite happens here
    // Close the index BEFORE severing so no handle leaks into afterEach cleanup
    // (an open meta.db handle makes rmSync EPERM on Windows and litters tmpdir).
    (d._db as { close(): void } | null)?.close();
    d._db = null;           // sever the index → file-only mode from here on
    d.usageCounted = false;
    d.ensureUsageCounted(); // now seeds counters from the real filesystem walk

    // Counter seeded from the filesystem walk must reflect the planted file.
    expect(disk.stats.sizeKB).toBeGreaterThanOrEqual(2048);

    const purged = disk.purgeExpired();
    expect(purged).toBe(1);

    // THE invariant: the file's bytes must be released, not just the file unlinked.
    expect(disk.stats.sizeKB).toBe(0);
  });
});
