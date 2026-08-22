import zlib from 'zlib';

export type CompressionAlgorithm = 'brotli' | 'gzip' | 'none';

export const PREFIX_COMPRESSED     = 'cmp:v1:';
export const PREFIX_ENC_COMPRESSED = 'ecp:v1:';

/** "TRC\x01" 4-byte marker prefix identifying compressed data */
const COMPRESSION_MAGIC = Buffer.from([0x54, 0x52, 0x43, 0x01]);

export function isCompressed(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x54 && buf[1] === 0x52 && buf[2] === 0x43 && buf[3] === 0x01;
}

export function compressBuffer(buf: Buffer, algorithm: CompressionAlgorithm): Buffer {
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
  return buf;
}

export function decompressBuffer(buf: Buffer, algorithm: CompressionAlgorithm = 'brotli'): Buffer {
  // Try the configured algorithm first, then the other one as recovery (covers
  // entries written under a different compression setting). If BOTH fail, the
  // payload is corrupt: THROW instead of returning the raw bytes. Returning raw
  // surfaced corruption as garbage JSON.parse errors deep downstream; every
  // call site maps a thrown error to a clean cache miss instead.
  const tryBrotli = (): Buffer | null => { try { return zlib.brotliDecompressSync(buf); } catch { return null; } };
  const tryGzip   = (): Buffer | null => { try { return zlib.gunzipSync(buf); }          catch { return null; } };

  const result = algorithm === 'gzip' ? (tryGzip() ?? tryBrotli()) : (tryBrotli() ?? tryGzip());
  if (result === null) {
    throw new Error(`tricache: corrupt compressed payload (${buf.length} bytes, algorithm=${algorithm})`);
  }
  return result;
}

export function compressWithHeader(buf: Buffer, algorithm: CompressionAlgorithm): Buffer {
  if (algorithm === 'none') return buf;
  const compressed = compressBuffer(buf, algorithm);
  return Buffer.concat([COMPRESSION_MAGIC, compressed]);
}

export function decompressWithHeader(buf: Buffer, algorithm: CompressionAlgorithm = 'brotli'): Buffer {
  if (isCompressed(buf)) {
    return decompressBuffer(buf.subarray(4), algorithm);
  }
  return buf;
}
