/**
 * Zero-dependency Base64 <-> Uint8Array utilities designed for pure Edge isolates
 * (Cloudflare Workers without nodejs_compat, Deno, Fastly Compute, browsers).
 *
 * Avoids call stack overflow (RangeError: Maximum call stack size exceeded)
 * on payloads > 64 KB by chunking binary data into safe 8 KB slices.
 */

const CHUNK_SIZE = 8192;

/**
 * Converts a Uint8Array to a standard Base64 string safely across all JS runtimes.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  // 1. Modern TC39 stage 3 Uint8Array.prototype.toBase64 support
  const modernBytes = bytes as unknown as { toBase64?: () => string };
  if (typeof modernBytes.toBase64 === 'function') {
    return modernBytes.toBase64();
  }

  // 2. Fallback using chunked String.fromCharCode + btoa
  let binary = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, len));
    binary += String.fromCharCode(...chunk);
  }
  return globalThis.btoa(binary);
}

/**
 * Converts a Base64 string to a Uint8Array safely across all JS runtimes.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  // 1. Modern TC39 stage 3 Uint8Array.fromBase64 support
  const modernU8 = Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array };
  if (typeof modernU8.fromBase64 === 'function') {
    return modernU8.fromBase64(base64);
  }

  // 2. Universal atob fallback
  const binary = globalThis.atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encodes a UTF-8 string to a Uint8Array using standard TextEncoder.
 */
export function utf8ToUint8Array(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Decodes a Uint8Array to a UTF-8 string using standard TextDecoder.
 */
export function uint8ArrayToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
