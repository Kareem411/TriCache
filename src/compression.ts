import zlib from 'zlib';
import lz4js from 'lz4js';
import { ZstdCodec } from 'zstd-codec';

export type CompressionAlgorithm = 'brotli' | 'gzip' | 'zstd' | 'lz4' | 'none';

export interface CustomCompressor {
  name: string;
  compress: (buf: Buffer) => Buffer;
  decompress: (buf: Buffer) => Buffer;
}

export const PREFIX_COMPRESSED     = 'cmp:v1:';
export const PREFIX_ENC_COMPRESSED = 'ecp:v1:';

/** "TRC\x01" 4-byte marker prefix identifying compressed data */
const COMPRESSION_MAGIC = Buffer.from([0x54, 0x52, 0x43, 0x01]);

let zstdSimple: any = null;
let zstdInitPromise: Promise<any> | null = null;

/**
 * Initializes the WebAssembly Zstandard codec.
 * Resolves immediately if already initialized.
 */
export function initZstd(): Promise<any> {
  if (zstdSimple) return Promise.resolve(zstdSimple);
  if (!zstdInitPromise) {
    zstdInitPromise = new Promise((resolve) => {
      try {
        ZstdCodec.run((zstd: any) => {
          zstdSimple = new zstd.Simple();
          resolve(zstdSimple);
        });
      } catch {
        resolve(null);
      }
    });
  }
  return zstdInitPromise;
}

// Auto-start initialization immediately in the background
initZstd().catch(() => {});

export function isCompressed(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x54 && buf[1] === 0x52 && buf[2] === 0x43 && buf[3] === 0x01;
}

export function compressBuffer(
  buf: Buffer,
  algorithm: CompressionAlgorithm,
  custom?: CustomCompressor,
): Buffer {
  if (custom) {
    return custom.compress(buf);
  }
  if (algorithm === 'brotli') {
    return zlib.brotliCompressSync(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 4, // Fast level 4 compression
      },
    });
  }
  if (algorithm === 'gzip') {
    return zlib.gzipSync(buf, { level: 6 });
  }
  if (algorithm === 'lz4') {
    return Buffer.from(lz4js.compress(buf));
  }
  if (algorithm === 'zstd') {
    if (!zstdSimple) {
      // If zstd WASM compile has not yet finished, fallback to fast Brotli level 4
      return zlib.brotliCompressSync(buf, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
      });
    }
    return Buffer.from(zstdSimple.compress(buf));
  }
  return buf;
}

export const MAX_DECOMPRESS_BYTES = 25 * 1024 * 1024; // 25 MB decompression bomb safety ceiling

export function decompressBuffer(
  buf: Buffer,
  algorithm: CompressionAlgorithm = 'zstd',
  custom?: CustomCompressor,
): Buffer {
  if (custom) {
    const res = custom.decompress(buf);
    if (res.length > MAX_DECOMPRESS_BYTES) {
      throw new Error(`tricache: decompressed payload exceeds maximum safety threshold of ${MAX_DECOMPRESS_BYTES} bytes`);
    }
    return res;
  }

  const checkSafety = (decomp: Buffer): Buffer => {
    if (decomp.length > MAX_DECOMPRESS_BYTES) {
      throw new Error(`tricache: decompressed payload exceeds maximum safety threshold of ${MAX_DECOMPRESS_BYTES} bytes`);
    }
    return decomp;
  };

  // 1. Zstandard magic header: 0x28 0xB5 0x2F 0xFD
  if (buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd) {
    if (zstdSimple) {
      try {
        return checkSafety(Buffer.from(zstdSimple.decompress(buf)));
      } catch (err: any) {
        if (err?.message?.includes('exceeds maximum safety threshold')) throw err;
        /* try recovery */
      }
    }
  }

  // 2. LZ4 frame magic header: 0x04 0x22 0x4D 0x18
  if (buf.length >= 4 && buf[0] === 0x04 && buf[1] === 0x22 && buf[2] === 0x4d && buf[3] === 0x18) {
    try {
      return checkSafety(Buffer.from(lz4js.decompress(buf)));
    } catch (err: any) {
      if (err?.message?.includes('exceeds maximum safety threshold')) throw err;
      /* try recovery */
    }
  }

  // 3. Gzip magic header: 0x1F 0x8B
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return zlib.gunzipSync(buf, { maxOutputLength: MAX_DECOMPRESS_BYTES });
    } catch (err: any) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new Error(`tricache: decompressed payload exceeds maximum safety threshold of ${MAX_DECOMPRESS_BYTES} bytes`);
      }
      /* try recovery */
    }
  }

  if (algorithm === 'none') {
    return buf;
  }

  // 4. Algorithm-specific attempts
  if (algorithm === 'lz4') {
    try {
      return checkSafety(Buffer.from(lz4js.decompress(buf)));
    } catch (err: any) {
      if (err?.message?.includes('exceeds maximum safety threshold')) throw err;
      /* fallback */
    }
  }

  if (algorithm === 'zstd' && zstdSimple) {
    try {
      return checkSafety(Buffer.from(zstdSimple.decompress(buf)));
    } catch (err: any) {
      if (err?.message?.includes('exceeds maximum safety threshold')) throw err;
      /* fallback */
    }
  }

  // 5. Universal fallback & recovery
  const tryBrotli = (): Buffer | null => {
    try {
      return zlib.brotliDecompressSync(buf, { maxOutputLength: MAX_DECOMPRESS_BYTES });
    } catch (err: any) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new Error(`tricache: decompressed payload exceeds maximum safety threshold of ${MAX_DECOMPRESS_BYTES} bytes`);
      }
      return null;
    }
  };
  const tryGzip = (): Buffer | null => {
    try {
      return zlib.gunzipSync(buf, { maxOutputLength: MAX_DECOMPRESS_BYTES });
    } catch (err: any) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new Error(`tricache: decompressed payload exceeds maximum safety threshold of ${MAX_DECOMPRESS_BYTES} bytes`);
      }
      return null;
    }
  };
  const tryLz4 = (): Buffer | null => {
    try {
      return checkSafety(Buffer.from(lz4js.decompress(buf)));
    } catch (err: any) {
      if (err?.message?.includes('exceeds maximum safety threshold')) throw err;
      return null;
    }
  };
  const tryZstd = (): Buffer | null => {
    if (!zstdSimple) return null;
    try {
      return checkSafety(Buffer.from(zstdSimple.decompress(buf)));
    } catch (err: any) {
      if (err?.message?.includes('exceeds maximum safety threshold')) throw err;
      return null;
    }
  };

  const result = (algorithm === 'gzip' ? tryGzip() : null) ??
                 (algorithm === 'lz4'  ? tryLz4()  : null) ??
                 (algorithm === 'zstd' ? tryZstd() : null) ??
                 tryBrotli() ??
                 tryGzip() ??
                 tryLz4() ??
                 tryZstd();

  if (result === null) {
    throw new Error(`tricache: corrupt compressed payload (${buf.length} bytes, algorithm=${algorithm})`);
  }
  return result;
}

export function compressWithHeader(
  buf: Buffer,
  algorithm: CompressionAlgorithm,
  custom?: CustomCompressor,
): Buffer {
  if (algorithm === 'none') return buf;
  const compressed = compressBuffer(buf, algorithm, custom);
  return Buffer.concat([COMPRESSION_MAGIC, compressed]);
}

export function decompressWithHeader(
  buf: Buffer,
  algorithm: CompressionAlgorithm = 'zstd',
  custom?: CustomCompressor,
): Buffer {
  if (isCompressed(buf)) {
    return decompressBuffer(buf.subarray(4), algorithm, custom);
  }
  return buf;
}
