import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DiskTier } from '../src/disk-tier';
import { CachePriority } from '../src/types';
import type { SmartCacheEntry } from '../src/types';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, readdirSync } from 'fs';
import { consoleLogger } from '../src/types';

function tempDir() {
  return join(tmpdir(), `tricache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeEntry(value: string, ttlMs = 60_000): SmartCacheEntry {
  const data    = JSON.stringify(value);
  const size    = Buffer.byteLength(data, 'utf8');
  return {
    data,
    isCompressed:  false,
    expiresAt:     Date.now() + ttlMs,
    size,
    hits:          1,
    lastAccess:    Date.now(),
    priority:      CachePriority.NORMAL,
  };
}

describe('DiskTier', () => {
  let dir: string;
  let disk: DiskTier;

  beforeEach(() => {
    dir  = tempDir();
    disk = new DiskTier({ dir, maxBytes: 10 * 1024 * 1024, entryMaxBytes: 1024 * 1024, forbiddenPrefixes: [], logger: consoleLogger });
  });

  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('returns null for a key not on disk', () => {
    expect(disk.load('ghost')).toBeNull();
  });

  it('persists and reloads a value', () => {
    const entry = makeEntry('hello world');
    disk.save('key1', entry);
    const loaded = disk.load('key1');
    expect(loaded).not.toBeNull();
    expect(JSON.parse(loaded!.data as string)).toBe('hello world');
  });

  it('returns null for an expired entry', async () => {
    const entry = makeEntry('expired', 1); // 1 ms TTL
    disk.save('exp-key', entry);
    await new Promise(r => setTimeout(r, 20));
    expect(disk.load('exp-key')).toBeNull();
  });

  it('deletes a key from disk', () => {
    disk.save('to-del', makeEntry('bye'));
    disk.delete('to-del');
    expect(disk.load('to-del')).toBeNull();
  });

  it('purgeExpired removes only expired entries (verifies by file count)', async () => {
    disk.save('live', makeEntry('ok', 60_000));
    disk.save('will-expire', makeEntry('bye', 500)); // 500ms TTL
    const beforeFiles = readdirSync(dir).length;
    expect(beforeFiles).toBe(2);
    // Wait for the short-lived entry to expire — do NOT call load() first since load() consumes the file
    await new Promise(r => setTimeout(r, 600));
    // purgeExpired should detect expiry from the on-disk payload and remove it
    const n = disk.purgeExpired();
    expect(n).toBeGreaterThanOrEqual(1);
    const afterFiles = readdirSync(dir).length;
    expect(afterFiles).toBeLessThan(beforeFiles);
    // 'live' key can still be loaded (file still on disk)
    expect(disk.load('live')).not.toBeNull();
  });

  it('survives a second DiskTier instance pointing at the same directory', () => {
    disk.save('shared-key', makeEntry('shared-value'));
    // load() consumes the file (promotes to L1), so use a second instance to read it before consuming
    const disk2 = new DiskTier({ dir, maxBytes: 10 * 1024 * 1024, entryMaxBytes: 1024 * 1024, forbiddenPrefixes: [], logger: consoleLogger });
    expect(JSON.parse(disk2.load('shared-key')!.data as string)).toBe('shared-value');
  });

  it('encrypts and decrypts when encryptionKey is supplied', () => {
    const keyBuf = Buffer.from('00'.repeat(32), 'hex'); // 32 zero bytes
    const enc = new DiskTier({ dir: tempDir(), maxBytes: 10 * 1024 * 1024, entryMaxBytes: 1024 * 1024, forbiddenPrefixes: [], encryptionKey: keyBuf, logger: consoleLogger });
    enc.save('secret', makeEntry('sensitive-data'));
    expect(JSON.parse(enc.load('secret')!.data as string)).toBe('sensitive-data');
  });

  it('stats reflects stored files', () => {
    disk.save('s1', makeEntry('a'));
    disk.save('s2', makeEntry('b'));
    // stats.files = file count on disk; stats.sizeKB tracks usage bytes (rounds to KB)
    expect(disk.stats.files).toBe(2);
    expect(disk.stats.maxKB).toBeGreaterThan(0);
  });
});
