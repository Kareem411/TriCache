/**
 * Standard 32-bit MurmurHash3 (x86_32) implementation.
 * Pure TypeScript, zero external dependencies, zero Node.js Buffer dependencies.
 *
 * Fully compatible with V8 Edge Isolates (Cloudflare Workers, Fastly Compute,
 * Vercel Edge, Deno, Bun, and modern browsers).
 */

/**
 * Computes the 32-bit MurmurHash3 of a string with an optional seed.
 * Uses 32-bit unsigned arithmetic (>>> 0).
 */
export function murmur3_32(key: string, seed = 0): number {
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;

  let h1 = seed >>> 0;
  const len = key.length;

  // Process 2-character (4-byte in UTF-16 code units / 2-char chunks) blocks
  const remainder = len & 1;
  const bytes = len - remainder;

  for (let i = 0; i < bytes; i += 2) {
    let k1 = (key.charCodeAt(i) & 0xffff) | ((key.charCodeAt(i + 1) & 0xffff) << 16);

    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);

    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
  }

  if (remainder === 1) {
    let k1 = key.charCodeAt(bytes) & 0xffff;
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
  }

  // Finalization avalanche mix (fmix32)
  h1 ^= len;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;

  return h1 >>> 0;
}

export interface BloomFilterStats {
  bitsSet: number;
  fillFactor: number;
}

/**
 * Pure TypeScript Bloom filter backed by a Uint8Array bitset.
 * Uses Murmur3 double-hashing (Kirsch-Mitzenmacher technique):
 *   h_i(x) = (h1(x) + i * h2(x)) % m
 *
 * Zero Buffer dependency — runs identically in Node.js, Edge Isolates, and Browsers.
 */
export class Murmur3BloomFilter {
  private readonly bits: Uint8Array;
  readonly numBits: number;
  readonly k: number;
  private readonly _maxCapacity: number;
  private _insertionCount = 0;

  /**
   * @param numBits Total bits in the filter (default: 100,000 bits = 12.5 KB)
   * @param k Number of hash probes per key (default: 7, targeting ~1% FPR at 2,000 items)
   */
  constructor(numBits = 100_000, k = 7) {
    this.numBits = Math.max(64, numBits);
    this.k = Math.max(1, k);
    this.bits = new Uint8Array(Math.ceil(this.numBits / 8));
    const p = 0.01;
    this._maxCapacity = Math.floor(-this.numBits * Math.log(1 - Math.pow(p, 1 / this.k)) / this.k);
  }

  private setBit(bitIndex: number): void {
    const byteIndex = bitIndex >>> 3;
    this.bits[byteIndex] |= 1 << (bitIndex & 7);
  }

  private getBit(bitIndex: number): boolean {
    const byteIndex = bitIndex >>> 3;
    return (this.bits[byteIndex] & (1 << (bitIndex & 7))) !== 0;
  }

  /**
   * Adds a key to the Bloom filter.
   */
  add(key: string): void {
    if (key.length === 0) return;
    const h1 = murmur3_32(key, 0);
    const h2 = murmur3_32(key, 0x9747b28c) || 1; // ensure non-zero step
    const m = this.numBits;

    for (let i = 0; i < this.k; i++) {
      const bit = ((h1 + Math.imul(i, h2)) >>> 0) % m;
      this.setBit(bit);
    }
    this._insertionCount++;
  }

  /**
   * Tests whether a key might be in the set.
   * Returns `false` for guaranteed misses, `true` for possible hits.
   */
  mightContain(key: string): boolean {
    if (key.length === 0) return true;
    const h1 = murmur3_32(key, 0);
    const h2 = murmur3_32(key, 0x9747b28c) || 1;
    const m = this.numBits;

    for (let i = 0; i < this.k; i++) {
      const bit = ((h1 + Math.imul(i, h2)) >>> 0) % m;
      if (!this.getBit(bit)) return false;
    }
    return true;
  }

  /**
   * Clears all set bits in the filter.
   */
  reset(): void {
    this.bits.fill(0);
    this._insertionCount = 0;
  }

  /**
   * Rebuilds the filter from a collection of keys.
   */
  rebuild(keys: Iterable<string>): void {
    this.reset();
    for (const key of keys) {
      this.add(key);
    }
  }

  /**
   * Total add() calls since creation or last reset.
   */
  get insertions(): number {
    return this._insertionCount;
  }

  /**
   * Maximum safe insertions before false positive rate exceeds target ~1%.
   */
  get maxCapacity(): number {
    return this._maxCapacity;
  }

  /**
   * Returns current bit saturation metrics.
   */
  get stats(): BloomFilterStats {
    let bitsSet = 0;
    const len = this.bits.length;
    for (let i = 0; i < len; i++) {
      let b = this.bits[i];
      while (b) {
        bitsSet++;
        b &= b - 1;
      }
    }
    return {
      bitsSet,
      fillFactor: bitsSet / this.numBits,
    };
  }
}
