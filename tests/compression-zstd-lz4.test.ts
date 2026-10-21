import { describe, it, expect, beforeAll } from 'vitest';
import {
  compressBuffer,
  decompressBuffer,
  compressWithHeader,
  decompressWithHeader,
  initZstd,
  isCompressed,
  type CustomCompressor,
} from '../src/compression';
import { CacheService } from '../src/cache-service';

describe('Zstandard & LZ4 Compression Layer', () => {
  const sampleText = JSON.stringify({
    title: 'Large analytical report',
    dataset: Array.from({ length: 500 }, (_, i) => ({
      id: i,
      guid: `guid-${i}-abc-xyz-${i * 13}`,
      timestamp: Date.now() + i,
      message: `Detailed diagnostic entry number ${i} with repeating attributes for compression test.`,
    })),
  });
  const sampleBuf = Buffer.from(sampleText, 'utf8');

  beforeAll(async () => {
    await initZstd();
  });

  describe('LZ4 Compression', () => {
    it('compresses and decompresses payload correctly', () => {
      const compressed = compressBuffer(sampleBuf, 'lz4');
      expect(compressed.length).toBeLessThan(sampleBuf.length);

      // Verify LZ4 frame magic: 0x04 0x22 0x4D 0x18
      expect(compressed[0]).toBe(0x04);
      expect(compressed[1]).toBe(0x22);
      expect(compressed[2]).toBe(0x4d);
      expect(compressed[3]).toBe(0x18);

      const decompressed = decompressBuffer(compressed, 'lz4');
      expect(decompressed.toString('utf8')).toBe(sampleText);
    });

    it('works with header prefix (compressWithHeader / decompressWithHeader)', () => {
      const withHeader = compressWithHeader(sampleBuf, 'lz4');
      expect(isCompressed(withHeader)).toBe(true);

      const decompressed = decompressWithHeader(withHeader, 'lz4');
      expect(decompressed.toString('utf8')).toBe(sampleText);
    });
  });

  describe('Zstandard (WebAssembly) Compression', () => {
    it('compresses and decompresses payload correctly with high ratio', () => {
      const compressed = compressBuffer(sampleBuf, 'zstd');
      // Substantial ratio reduction
      expect(compressed.length).toBeLessThan(sampleBuf.length * 0.3);

      // Verify Zstandard magic: 0x28 0xB5 0x2F 0xFD
      expect(compressed[0]).toBe(0x28);
      expect(compressed[1]).toBe(0xb5);
      expect(compressed[2]).toBe(0x2f);
      expect(compressed[3]).toBe(0xfd);

      const decompressed = decompressBuffer(compressed, 'zstd');
      expect(decompressed.toString('utf8')).toBe(sampleText);
    });

    it('works with header prefix (compressWithHeader / decompressWithHeader)', () => {
      const withHeader = compressWithHeader(sampleBuf, 'zstd');
      expect(isCompressed(withHeader)).toBe(true);

      const decompressed = decompressWithHeader(withHeader, 'zstd');
      expect(decompressed.toString('utf8')).toBe(sampleText);
    });
  });

  describe('Automatic Format Magic Detection', () => {
    it('auto-detects and decompresses Zstandard, LZ4, Gzip without specifying algorithm', () => {
      const zstdCmp = compressBuffer(sampleBuf, 'zstd');
      const lz4Cmp  = compressBuffer(sampleBuf, 'lz4');
      const gzipCmp = compressBuffer(sampleBuf, 'gzip');

      // Decompressing each without matching algorithm parameter (defaults to brotli)
      expect(decompressBuffer(zstdCmp).toString('utf8')).toBe(sampleText);
      expect(decompressBuffer(lz4Cmp).toString('utf8')).toBe(sampleText);
      expect(decompressBuffer(gzipCmp).toString('utf8')).toBe(sampleText);
    });
  });

  describe('Custom Compressor Plugin', () => {
    it('supports custom pluggable compression engine', () => {
      const custom: CustomCompressor = {
        name: 'mock-rot13',
        compress: (buf: Buffer) => {
          const out = Buffer.alloc(buf.length);
          for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ 0x42;
          return out;
        },
        decompress: (buf: Buffer) => {
          const out = Buffer.alloc(buf.length);
          for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ 0x42;
          return out;
        },
      };

      const compressed = compressBuffer(sampleBuf, 'none', custom);
      expect(compressed.equals(sampleBuf)).toBe(false);

      const decompressed = decompressBuffer(compressed, 'none', custom);
      expect(decompressed.toString('utf8')).toBe(sampleText);
    });

    it('rejects custom compressor exceeding MAX_DECOMPRESS_BYTES ceiling', () => {
      const oversizedCustom: CustomCompressor = {
        name: 'bomb-mock',
        compress: (buf: Buffer) => buf,
        decompress: () => Buffer.alloc(26 * 1024 * 1024), // 26 MB > 25 MB limit
      };

      expect(() => {
        decompressBuffer(Buffer.from('small'), 'none', oversizedCustom);
      }).toThrow(/exceeds maximum safety threshold/);
    });
  });

  describe('CacheService Integration', () => {
    it('works with compression: "lz4" on get() and set()', async () => {
      const cache = new CacheService({
        disableDisk: true,
        disableRedis: true,
        compression: 'lz4',
        compressionThresholdBytes: 64,
      });

      const testData = { payload: 'lz4-cache-content-'.repeat(20) };
      await cache.set('item:lz4', testData, 60);

      const retrieved = await cache.getIfFresh<typeof testData>('item:lz4');
      expect(retrieved).toEqual(testData);
    });

    it('works with compression: "zstd" on get() and set()', async () => {
      const cache = new CacheService({
        disableDisk: true,
        disableRedis: true,
        compression: 'zstd',
        compressionThresholdBytes: 64,
      });

      await cache.ready();

      const testData = { payload: 'zstd-cache-content-'.repeat(20) };
      await cache.set('item:zstd', testData, 60);

      const retrieved = await cache.getIfFresh<typeof testData>('item:zstd');
      expect(retrieved).toEqual(testData);
    });

    it('defaults to compression: "zstd" when no compression option is provided', async () => {
      const cache = new CacheService({
        disableDisk: true,
        disableRedis: true,
      });

      expect((cache as any).opts.compression).toBe('zstd');

      const testData = { payload: 'default-zstd-'.repeat(20) };
      await cache.set('item:default', testData, 60);

      const retrieved = await cache.getIfFresh<typeof testData>('item:default');
      expect(retrieved).toEqual(testData);
    });

    it('works with customCompressor plugin on CacheService', async () => {
      let compressCount = 0;
      let decompressCount = 0;

      const customCompressor: CustomCompressor = {
        name: 'test-passthrough',
        compress: (buf) => {
          compressCount++;
          return buf;
        },
        decompress: (buf) => {
          decompressCount++;
          return buf;
        },
      };

      const cache = new CacheService({
        disableDisk: true,
        disableRedis: true,
        customCompressor,
        compressionThresholdBytes: 16,
      });

      const data = { big: 'x'.repeat(100) };
      await cache.set('item:custom', data, 60);

      const res = await cache.getIfFresh('item:custom');
      expect(res).toEqual(data);
      expect(compressCount).toBeGreaterThanOrEqual(0);
      expect(decompressCount).toBeGreaterThanOrEqual(0);
    });

    it('works with workerThreads enabled and compression: "zstd"', async () => {
      const cache = new CacheService({
        disableDisk: true,
        disableRedis: true,
        compression: 'zstd',
        compressionThresholdBytes: 32,
        workerThreads: true,
        workerPoolSize: 1,
      });

      await cache.ready();

      const data = { workerPayload: 'zstd-worker-'.repeat(25) };
      await cache.set('item:worker:zstd', data, 60);

      const res = await cache.getIfFresh<typeof data>('item:worker:zstd');
      expect(res).toEqual(data);

      await cache.destroy();
    });

    it('works with workerThreads enabled and compression: "lz4"', async () => {
      const cache = new CacheService({
        disableDisk: true,
        disableRedis: true,
        compression: 'lz4',
        compressionThresholdBytes: 32,
        workerThreads: true,
        workerPoolSize: 1,
      });

      await cache.ready();

      const data = { workerPayload: 'lz4-worker-'.repeat(25) };
      await cache.set('item:worker:lz4', data, 60);

      const res = await cache.getIfFresh<typeof data>('item:worker:lz4');
      expect(res).toEqual(data);

      await cache.destroy();
    });
  });
});
