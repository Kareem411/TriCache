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
  if (algorithm === 'gzip') {
    try {
      return zlib.gunzipSync(buf);
    } catch {
      try {
        return zlib.brotliDecompressSync(buf);
      } catch {
        return buf;
      }
    }
  }
  try {
    return zlib.brotliDecompressSync(buf);
  } catch {
    try {
      return zlib.gunzipSync(buf);
    } catch {
      return buf;
    }
  }
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
