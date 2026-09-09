import { describe, it, expect, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service';
import { DiskTier } from '../src/disk-tier';
import { CacheEncryption } from '../src/encryption';
import { consoleLogger } from '../src/types';
import { compressBuffer, decompressBuffer } from '../src/compression';
import { pack } from 'msgpackr';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

function makeKey(len = 32, char = 'k'): string {
  return Buffer.from(char.repeat(len)).toString('base64');
}

describe('Payload Compression (Redis L2 & Disk Tier)', () => {
  let svc: CacheService | null = null;
  let diskDir: string | null = null;

  afterEach(async () => {
    if (svc) {
      await svc.destroy();
      svc = null;
    }
    if (diskDir) {
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
      diskDir = null;
    }
  });

  describe('Compression utilities', () => {
    it('round-trips brotli compression and decompression', () => {
      const payload = Buffer.from('hello world'.repeat(50), 'utf8');
      const compressed = compressBuffer(payload, 'brotli');
      expect(compressed.length).toBeLessThan(payload.length);
      const decompressed = decompressBuffer(compressed, 'brotli');
      expect(decompressed.toString('utf8')).toBe(payload.toString('utf8'));
    });

    it('round-trips gzip compression and decompression', () => {
      const payload = Buffer.from('hello world'.repeat(50), 'utf8');
      const compressed = compressBuffer(payload, 'gzip');
      expect(compressed.length).toBeLessThan(payload.length);
      const decompressed = decompressBuffer(compressed, 'gzip');
      expect(decompressed.toString('utf8')).toBe(payload.toString('utf8'));
    });

    it('throws on corrupt payloads instead of returning raw bytes', () => {
      // Old contract silently returned the input buffer when BOTH algorithms
      // failed — corruption surfaced as garbage downstream instead of a miss.
      const garbage = Buffer.alloc(64, 0xa5);
      expect(() => decompressBuffer(garbage, 'brotli')).toThrow(/corrupt compressed payload/);
      expect(() => decompressBuffer(garbage, 'gzip')).toThrow(/corrupt compressed payload/);
      // Cross-algorithm recovery still works: brotli data decompressed under
      // the 'gzip' setting must come back intact, and vice versa.
      const brotliData = compressBuffer(Buffer.from('cross-algo recovery'), 'brotli');
      expect(decompressBuffer(brotliData, 'gzip').toString('utf8')).toBe('cross-algo recovery');

      const gzipData = compressBuffer(Buffer.from('gzip cross-algo recovery'), 'gzip');
      expect(decompressBuffer(gzipData, 'brotli').toString('utf8')).toBe('gzip cross-algo recovery');
    });
  });

  describe('Envelope matrix & storage formats', () => {
    it('formats cmp:v1: envelope when compression is enabled without encryption', async () => {
      diskDir = mkdtempSync(path.join(os.tmpdir(), 'tricache-cmp-test-'));
      svc = new CacheService({
        diskCacheDir: diskDir,
        disableRedis: true,
        compression: 'brotli',
        compressionThresholdBytes: 50,
      });

      const helper = svc as unknown as { _serializeAndEncrypt: (s: string) => Promise<string> };
      const largePayload = JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => `item-${i}`) });

      const stored = await helper._serializeAndEncrypt(largePayload);
      expect(stored.startsWith('cmp:v1:')).toBe(true);

      const deser = svc as unknown as { _decryptAndDeserialize: <T>(s: string) => Promise<T> };
      const parsed = await deser._decryptAndDeserialize<{ items: string[] }>(stored);
      expect(parsed.items.length).toBe(50);
    });

    it('formats ecp:v1: envelope when both compression and encryption are enabled', async () => {
      diskDir = mkdtempSync(path.join(os.tmpdir(), 'tricache-ecp-test-'));
      svc = new CacheService({
        diskCacheDir: diskDir,
        disableRedis: true,
        encryptionKey: makeKey(32),
        encryptionMode: 'aes-256-gcm',
        compression: 'brotli',
        compressionThresholdBytes: 50,
      });

      const helper = svc as unknown as { _serializeAndEncrypt: (s: string) => Promise<string> };
      const largePayload = JSON.stringify({ data: 'repeated text '.repeat(30) });

      const stored = await helper._serializeAndEncrypt(largePayload);
      expect(stored.startsWith('ecp:v1:')).toBe(true);

      const deser = svc as unknown as { _decryptAndDeserialize: <T>(s: string) => Promise<T> };
      const parsed = await deser._decryptAndDeserialize<{ data: string }>(stored);
      expect(parsed.data).toBe('repeated text '.repeat(30));
    });

    it('skips compression when payload is below compressionThresholdBytes', async () => {
      diskDir = mkdtempSync(path.join(os.tmpdir(), 'tricache-threshold-test-'));
      svc = new CacheService({
        diskCacheDir: diskDir,
        disableRedis: true,
        compression: 'brotli',
        compressionThresholdBytes: 1024,
      });

      const helper = svc as unknown as { _serializeAndEncrypt: (s: string) => Promise<string> };
      const smallPayload = JSON.stringify({ a: 1 });

      const stored = await helper._serializeAndEncrypt(smallPayload);
      expect(stored.startsWith('cmp:v1:')).toBe(false);
      expect(stored).toBe(smallPayload);
    });
  });

  describe('Disk Tier compression', () => {
    it('compresses disk files and reads them back transparently', async () => {
      diskDir = mkdtempSync(path.join(os.tmpdir(), 'tricache-disk-cmp-'));
      const disk = new DiskTier({
        dir: diskDir,
        maxBytes: 10 * 1024 * 1024,
        entryMaxBytes: 1024 * 1024,
        forbiddenPrefixes: [],
        compression: 'brotli',
        compressionThresholdBytes: 50,
        logger: consoleLogger,
      });

      const largeObj = { records: Array.from({ length: 100 }, (_, i) => ({ id: i, text: `record-${i}` })) };
      const packed = pack(largeObj);

      await disk.save('big-record', {
        data: packed,
        size: packed.length,
        expiresAt: Date.now() + 60_000,
        priority: 0,
        hits: 1,
        lastAccess: Date.now(),
        isCompressed: true,
      });

      const loaded = disk.load('big-record');
      expect(loaded).not.toBeNull();
      expect(loaded!.data).toEqual(Buffer.from(packed));
    });

    it('compresses and encrypts disk files together', async () => {
      diskDir = mkdtempSync(path.join(os.tmpdir(), 'tricache-disk-ecp-'));
      const enc = new CacheEncryption(makeKey(32), consoleLogger, 'aes-256-gcm');
      const disk = new DiskTier({
        dir: diskDir,
        maxBytes: 10 * 1024 * 1024,
        entryMaxBytes: 1024 * 1024,
        forbiddenPrefixes: [],
        encryption: enc,
        compression: 'brotli',
        compressionThresholdBytes: 50,
        logger: consoleLogger,
      });

      const largeObj = { secretList: Array.from({ length: 100 }, (_, i) => `secret-${i}`) };
      const packed = pack(largeObj);

      await disk.save('enc-record', {
        data: packed,
        size: packed.length,
        expiresAt: Date.now() + 60_000,
        priority: 0,
        hits: 1,
        lastAccess: Date.now(),
        isCompressed: true,
      });

      const loaded = disk.load('enc-record');
      expect(loaded).not.toBeNull();
      expect(loaded!.data).toEqual(Buffer.from(packed));
    });

    it('maintains backward compatibility with uncompressed legacy disk files', async () => {
      diskDir = mkdtempSync(path.join(os.tmpdir(), 'tricache-disk-legacy-'));
      // Write uncompressed file first
      const plainDisk = new DiskTier({
        dir: diskDir,
        maxBytes: 10 * 1024 * 1024,
        entryMaxBytes: 1024 * 1024,
        forbiddenPrefixes: [],
        compression: 'none',
        logger: consoleLogger,
      });

      const obj = { message: 'legacy uncompressed payload' };
      const packed = pack(obj);
      await plainDisk.save('legacy-key', {
        data: packed,
        size: packed.length,
        expiresAt: Date.now() + 60_000,
        priority: 0,
        hits: 1,
        lastAccess: Date.now(),
        isCompressed: true,
      });

      // Open with compression-enabled DiskTier
      const cmpDisk = new DiskTier({
        dir: diskDir,
        maxBytes: 10 * 1024 * 1024,
        entryMaxBytes: 1024 * 1024,
        forbiddenPrefixes: [],
        compression: 'brotli',
        logger: consoleLogger,
      });

      const loaded = cmpDisk.load('legacy-key');
      expect(loaded).not.toBeNull();
      expect(loaded!.data).toEqual(Buffer.from(packed));
    });
  });

  describe('Compression ratio & byte reduction', () => {
    it('achieves at least 20% byte reduction for structured repetitive JSON payloads', async () => {
      const repetitiveData = {
        users: Array.from({ length: 100 }, (_, i) => ({
          id: i,
          organization: 'Acme Global Enterprises International',
          role: 'Software Engineer Level 4',
          permissions: ['read', 'write', 'admin', 'billing', 'deploy'],
          status: 'ACTIVE_VERIFIED',
        })),
      };

      const rawJson = JSON.stringify(repetitiveData);
      const rawBuf = Buffer.from(rawJson, 'utf8');
      const compressedBuf = compressBuffer(rawBuf, 'brotli');

      const reductionPercent = ((rawBuf.length - compressedBuf.length) / rawBuf.length) * 100;
      expect(reductionPercent).toBeGreaterThanOrEqual(20);
    });
  });
});
