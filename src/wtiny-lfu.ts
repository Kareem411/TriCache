/**
 * tricache — Native Window TinyLFU (W-TinyLFU) Admission Engine
 *
 * Implements the state-of-the-art W-TinyLFU cache architecture popularized by Caffeine:
 *
 *                           [Incoming Entry]
 *                                  │
 *                                  ▼
 *                    ┌───────────────────────────┐
 *                    │    Window Cache (LRU)     │  ~1% of Total Capacity
 *                    │  (Absorbs Burst Recency)  │
 *                    └─────────────┬─────────────┘
 *                                  │ Evicted from Window
 *                                  ▼
 *                         [TinyLFU Admission]
 *                      Freq(Candidate) > Freq(Victim)?
 *                                  │
 *                  ┌───────────────┴───────────────┐
 *                  │ YES                           │ NO
 *                  ▼                               ▼
 *       ┌──────────────────────┐             [Drop Candidate]
 *       │  Probationary SLRU   │  ~20% of Main
 *       └──────────┬───────────┘
 *                  │ On 2nd Hit
 *                  ▼
 *       ┌──────────────────────┐
 *       │    Protected SLRU    │  ~80% of Main
 *       └──────────────────────┘
 *
 * Characteristics:
 *  - Pure TypeScript with zero external dependencies
 *  - Mathematical scan resistance: large sequential scans never pollute the main cache
 *  - Burst recency absorption: short-lived temporal spikes hit in the Window without eviction churn
 *  - Near-optimal theoretical hit ratios on Zipfian distributions
 */

export interface WTinyLfuOptions {
  /** Total maximum number of entries across all segments (Window + Probation + Protected). Default: 10,000 */
  capacity: number;
  /** Fraction of total capacity dedicated to Window Cache for burst recency absorption. Default: 0.01 (1%) */
  windowPercent?: number;
  /** Fraction of main SLRU space allocated to Protected segment. Default: 0.80 (80%) */
  protectedPercent?: number;
  /** Width of Count-Min Sketch rows (power of 2). Default: 1024 */
  sketchWidth?: number;
}

export interface WTinyLfuStats {
  capacity: number;
  size: number;
  windowSize: number;
  probationSize: number;
  protectedSize: number;
  hits: number;
  misses: number;
  hitRate: number;
  admissions: number;
  rejections: number;
  demotions: number;
  promotions: number;
}

export interface EvictionResult<K, V> {
  evicted?: { key: K; value: V; segment: 'window' | 'probation' | 'protected' };
  rejected?: { key: K; value: V; segment: 'window' };
}

/**
 * 4-row Count-Min Sketch for TinyLFU frequency estimation.
 * Uses Murmur3-style bit-mixes of FNV-1a digests with periodic halving decay.
 */
export class TinyLfuSketch {
  private readonly rows = 4;
  private readonly width: number;
  private readonly mask: number;
  private readonly table: Uint16Array;
  private insertions = 0;
  private readonly decayThreshold: number;

  constructor(width = 1024, decayThreshold?: number) {
    // Ensure power of 2
    let w = 1;
    while (w < width) w <<= 1;
    this.width = w;
    this.mask = w - 1;
    this.table = new Uint16Array(this.rows * this.width);
    this.decayThreshold = decayThreshold ?? (width * 16);
  }

  private hash(key: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = (Math.imul(h, 0x01000193) >>> 0);
    }
    return h;
  }

  increment(key: string): void {
    const h = this.hash(key);
    const h1 = (h ^ (h >>> 16)) >>> 0;
    const h2 = (Math.imul(h1, 0x45d9f3b) ^ (h1 >>> 16)) >>> 0;
    const h3 = (Math.imul(h2, 0x7fb9b7a1) ^ (h2 >>> 16)) >>> 0;
    const h4 = (Math.imul(h3, 0x1b873593) ^ (h3 >>> 16)) >>> 0;

    const t = this.table;
    const w = this.width;

    const i0 = h1 & this.mask;
    const i1 = w + (h2 & this.mask);
    const i2 = (2 * w) + (h3 & this.mask);
    const i3 = (3 * w) + (h4 & this.mask);

    if (t[i0] < 0xffff) t[i0]++;
    if (t[i1] < 0xffff) t[i1]++;
    if (t[i2] < 0xffff) t[i2]++;
    if (t[i3] < 0xffff) t[i3]++;

    if (++this.insertions >= this.decayThreshold) {
      this.decay();
    }
  }

  estimate(key: string): number {
    const h = this.hash(key);
    const h1 = (h ^ (h >>> 16)) >>> 0;
    const h2 = (Math.imul(h1, 0x45d9f3b) ^ (h1 >>> 16)) >>> 0;
    const h3 = (Math.imul(h2, 0x7fb9b7a1) ^ (h2 >>> 16)) >>> 0;
    const h4 = (Math.imul(h3, 0x1b873593) ^ (h3 >>> 16)) >>> 0;

    const t = this.table;
    const w = this.width;

    return Math.min(
      t[h1 & this.mask],
      t[w + (h2 & this.mask)],
      t[(2 * w) + (h3 & this.mask)],
      t[(3 * w) + (h4 & this.mask)],
    );
  }

  decay(): void {
    for (let i = 0; i < this.table.length; i++) {
      this.table[i] >>>= 1;
    }
    this.insertions = 0;
  }

  clear(): void {
    this.table.fill(0);
    this.insertions = 0;
  }
}

/**
 * Window TinyLFU (W-TinyLFU) Segmented Cache.
 */
export class WTinyLfuCache<K = string, V = unknown> {
  private readonly maxTotal: number;
  private readonly maxWindow: number;
  private readonly maxProtected: number;
  private readonly maxProbation: number;

  // Segments (Map preserves insertion order: oldest is first key, MRU is last key)
  private readonly window = new Map<K, V>();
  private readonly probation = new Map<K, V>();
  private readonly protected_ = new Map<K, V>();

  // TinyLFU Frequency Sketch
  private readonly sketch: TinyLfuSketch;

  // Telemetry metrics
  private hitCount = 0;
  private missCount = 0;
  private admissionCount = 0;
  private rejectionCount = 0;
  private promotionCount = 0;
  private demotionCount = 0;

  constructor(options: WTinyLfuOptions) {
    this.maxTotal = Math.max(2, options.capacity);

    const winPercent = options.windowPercent ?? 0.01;
    this.maxWindow = Math.max(1, Math.floor(this.maxTotal * winPercent));

    const mainCapacity = Math.max(1, this.maxTotal - this.maxWindow);
    const protPercent = options.protectedPercent ?? 0.80;
    this.maxProtected = Math.max(1, Math.floor(mainCapacity * protPercent));
    this.maxProbation = Math.max(1, mainCapacity - this.maxProtected);

    this.sketch = new TinyLfuSketch(options.sketchWidth ?? 1024);
  }

  get capacity(): number {
    return this.maxTotal;
  }

  get size(): number {
    return this.window.size + this.probation.size + this.protected_.size;
  }

  private keyToString(key: K): string {
    return typeof key === 'string' ? key : String(key);
  }

  /**
   * Retrieves an entry and performs W-TinyLFU access promotion.
   */
  get(key: K): V | undefined {
    const keyStr = this.keyToString(key);
    this.sketch.increment(keyStr);

    // 1. Check Window Cache
    if (this.window.has(key)) {
      const val = this.window.get(key)!;
      // Refresh MRU in Window
      this.window.delete(key);
      this.window.set(key, val);
      this.hitCount++;
      return val;
    }

    // 2. Check Protected Segment
    if (this.protected_.has(key)) {
      const val = this.protected_.get(key)!;
      // Refresh MRU in Protected
      this.protected_.delete(key);
      this.protected_.set(key, val);
      this.hitCount++;
      return val;
    }

    // 3. Check Probationary Segment
    if (this.probation.has(key)) {
      const val = this.probation.get(key)!;
      this.probation.delete(key);

      // Promote to Protected on 2nd hit
      this.promotionCount++;
      this.protected_.set(key, val);

      // Handle Protected overflow: demote LRU of Protected back to Probation
      if (this.protected_.size > this.maxProtected) {
        const oldestProtKey = this.protected_.keys().next().value!;
        const oldestProtVal = this.protected_.get(oldestProtKey)!;
        this.protected_.delete(oldestProtKey);
        this.probation.set(oldestProtKey, oldestProtVal);
        this.demotionCount++;
      }

      this.hitCount++;
      return val;
    }

    this.missCount++;
    return undefined;
  }

  /**
   * Returns true if key exists in any segment without updating access frequency.
   */
  has(key: K): boolean {
    return this.window.has(key) || this.probation.has(key) || this.protected_.has(key);
  }

  /**
   * Puts an entry into the cache using W-TinyLFU admission policies.
   */
  set(key: K, value: V): EvictionResult<K, V> {
    const keyStr = this.keyToString(key);
    this.sketch.increment(keyStr);

    const result: EvictionResult<K, V> = {};

    // ── 1. Update existing key if present in any segment ────────────────────
    if (this.window.has(key)) {
      this.window.delete(key);
      this.window.set(key, value);
      return result;
    }

    if (this.protected_.has(key)) {
      this.protected_.delete(key);
      this.protected_.set(key, value);
      return result;
    }

    if (this.probation.has(key)) {
      this.probation.delete(key);
      this.probation.set(key, value);
      return result;
    }

    // ── 2. New key: Admit into Window Cache ─────────────────────────────────
    this.window.set(key, value);

    // If Window does not exceed capacity, admission complete
    if (this.window.size <= this.maxWindow) {
      this.admissionCount++;
      return result;
    }

    // ── 3. Window Overflow: Candidate evicts from Window to TinyLFU Gate ────
    const candKey = this.window.keys().next().value!;
    const candVal = this.window.get(candKey)!;
    this.window.delete(candKey);

    // If Main cache has headroom, admit candidate directly to Probation
    if (this.probation.size + this.protected_.size < this.maxProbation + this.maxProtected) {
      this.probation.set(candKey, candVal);
      this.admissionCount++;
      return result;
    }

    // ── 4. TinyLFU Admission Gate: Candidate vs Probation Victim ────────────
    // Find victim: LRU of Probationary segment (or LRU of Protected if Probation empty)
    let victimKey: K;
    let victimVal: V;
    let victimSegment: 'probation' | 'protected';

    if (this.probation.size > 0) {
      victimKey = this.probation.keys().next().value!;
      victimVal = this.probation.get(victimKey)!;
      victimSegment = 'probation';
    } else {
      victimKey = this.protected_.keys().next().value!;
      victimVal = this.protected_.get(victimKey)!;
      victimSegment = 'protected';
    }

    const candFreq = this.sketch.estimate(this.keyToString(candKey));
    const victimFreq = this.sketch.estimate(this.keyToString(victimKey));

    if (candFreq > victimFreq) {
      // Candidate WINS admission: evict victim, admit candidate to Probation
      if (victimSegment === 'probation') {
        this.probation.delete(victimKey);
      } else {
        this.protected_.delete(victimKey);
      }

      this.probation.set(candKey, candVal);
      this.admissionCount++;
      result.evicted = { key: victimKey, value: victimVal, segment: victimSegment };
    } else {
      // Candidate LOSES admission: candidate is rejected/dropped
      this.rejectionCount++;
      result.rejected = { key: candKey, value: candVal, segment: 'window' };
    }

    return result;
  }

  /**
   * Removes a key from whichever segment it resides in.
   */
  delete(key: K): boolean {
    return this.window.delete(key) || this.probation.delete(key) || this.protected_.delete(key);
  }

  /**
   * Resets all segments, sketch, and metrics.
   */
  clear(): void {
    this.window.clear();
    this.probation.clear();
    this.protected_.clear();
    this.sketch.clear();
    this.hitCount = 0;
    this.missCount = 0;
    this.admissionCount = 0;
    this.rejectionCount = 0;
    this.promotionCount = 0;
    this.demotionCount = 0;
  }

  /**
   * Returns current telemetry and hit-ratio stats.
   */
  stats(): WTinyLfuStats {
    const totalRequests = this.hitCount + this.missCount;
    return {
      capacity: this.maxTotal,
      size: this.size,
      windowSize: this.window.size,
      probationSize: this.probation.size,
      protectedSize: this.protected_.size,
      hits: this.hitCount,
      misses: this.missCount,
      hitRate: totalRequests > 0 ? this.hitCount / totalRequests : 0,
      admissions: this.admissionCount,
      rejections: this.rejectionCount,
      promotions: this.promotionCount,
      demotions: this.demotionCount,
    };
  }

  getStats(): WTinyLfuStats {
    return this.stats();
  }

  /**
   * Returns an iterator of all keys currently in the cache.
   */
  *keys(): IterableIterator<K> {
    yield* this.window.keys();
    yield* this.probation.keys();
    yield* this.protected_.keys();
  }

  /**
   * Returns an iterator of all entries currently in the cache.
   */
  *entries(): IterableIterator<[K, V]> {
    yield* this.window.entries();
    yield* this.probation.entries();
    yield* this.protected_.entries();
  }

  /**
   * Returns segment membership for a key ('window', 'probation', 'protected', or null).
   */
  getSegment(key: K): 'window' | 'probation' | 'protected' | null {
    if (this.window.has(key)) return 'window';
    if (this.probation.has(key)) return 'probation';
    if (this.protected_.has(key)) return 'protected';
    return null;
  }
}

export interface WTinyLfuAdmissionDecision {
  admit: boolean;
  evictKey?: string;
  candidateKey?: string;
}

/**
 * Lightweight W-TinyLFU policy controller for existing tiered caches like SmartMemoryCache.
 */
export class WTinyLfuPolicy {
  private readonly maxTotal: number;
  private readonly maxWindow: number;
  private readonly maxProtected: number;
  private readonly maxProbation: number;

  private readonly window = new Set<string>();
  private readonly probation = new Set<string>();
  private readonly protected_ = new Set<string>();

  // Telemetry metrics
  private hitCount = 0;
  private missCount = 0;
  private admissionCount = 0;
  private rejectionCount = 0;
  private promotionCount = 0;
  private demotionCount = 0;

  constructor(
    capacity: number,
    private readonly sketch: { estimate(key: string): number; increment(key: string): void },
    windowPercent = 0.01,
    protectedPercent = 0.80,
  ) {
    this.maxTotal = Math.max(2, capacity);
    this.maxWindow = Math.max(1, Math.floor(this.maxTotal * windowPercent));
    const mainCapacity = Math.max(1, this.maxTotal - this.maxWindow);
    this.maxProtected = Math.max(1, Math.floor(mainCapacity * protectedPercent));
    this.maxProbation = Math.max(1, mainCapacity - this.maxProtected);
  }

  get windowSize(): number {
    return this.window.size;
  }

  get probationSize(): number {
    return this.probation.size;
  }

  get protectedSize(): number {
    return this.protected_.size;
  }

  onAccess(key: string): void {
    if (this.window.has(key)) {
      this.window.delete(key);
      this.window.add(key); // MRU
      this.hitCount++;
      return;
    }

    if (this.protected_.has(key)) {
      this.protected_.delete(key);
      this.protected_.add(key); // MRU
      this.hitCount++;
      return;
    }

    if (this.probation.has(key)) {
      this.probation.delete(key);
      this.protected_.add(key); // Promote to Protected on 2nd hit
      this.promotionCount++;
      this.hitCount++;

      // Protected overflow -> demote oldest to Probation
      if (this.protected_.size > this.maxProtected) {
        const oldestProtKey = this.protected_.values().next().value!;
        this.protected_.delete(oldestProtKey);
        this.probation.add(oldestProtKey);
        this.demotionCount++;
      }
      return;
    }

    this.missCount++;
  }

  onSet(key: string, isUpdate: boolean): WTinyLfuAdmissionDecision {
    if (isUpdate) {
      if (this.window.has(key)) {
        this.window.delete(key);
        this.window.add(key);
      } else if (this.protected_.has(key)) {
        this.protected_.delete(key);
        this.protected_.add(key);
      } else if (this.probation.has(key)) {
        this.probation.delete(key);
        this.probation.add(key);
      }
      return { admit: true };
    }

    // New key: admit to Window
    this.window.add(key);

    if (this.window.size <= this.maxWindow) {
      this.admissionCount++;
      return { admit: true };
    }

    // Window overflow: pop candidate from Window
    const candKey = this.window.values().next().value!;
    this.window.delete(candKey);

    // If main cache has headroom, admit to Probation
    if (this.probation.size + this.protected_.size < this.maxProbation + this.maxProtected) {
      this.probation.add(candKey);
      this.admissionCount++;
      return { admit: true };
    }

    // Main space full: TinyLFU gate
    let victimKey: string;
    let victimIsProbation = true;

    if (this.probation.size > 0) {
      victimKey = this.probation.values().next().value!;
    } else {
      victimKey = this.protected_.values().next().value!;
      victimIsProbation = false;
    }

    const candFreq = this.sketch.estimate(candKey);
    const victimFreq = this.sketch.estimate(victimKey);

    if (candFreq > victimFreq) {
      // Candidate wins: evict victim, admit candidate to Probation
      if (victimIsProbation) {
        this.probation.delete(victimKey);
      } else {
        this.protected_.delete(victimKey);
      }
      this.probation.add(candKey);
      this.admissionCount++;
      return { admit: true, evictKey: victimKey, candidateKey: candKey };
    } else {
      // Candidate loses: rejected
      this.rejectionCount++;
      return { admit: false, candidateKey: candKey };
    }
  }

  onDelete(key: string): void {
    this.window.delete(key);
    this.probation.delete(key);
    this.protected_.delete(key);
  }

  clear(): void {
    this.window.clear();
    this.probation.clear();
    this.protected_.clear();
    this.hitCount = 0;
    this.missCount = 0;
    this.admissionCount = 0;
    this.rejectionCount = 0;
    this.promotionCount = 0;
    this.demotionCount = 0;
  }

  getStats(): WTinyLfuStats {
    const totalRequests = this.hitCount + this.missCount;
    return {
      capacity: this.maxTotal,
      size: this.window.size + this.probation.size + this.protected_.size,
      windowSize: this.window.size,
      probationSize: this.probation.size,
      protectedSize: this.protected_.size,
      hits: this.hitCount,
      misses: this.missCount,
      hitRate: totalRequests > 0 ? this.hitCount / totalRequests : 0,
      admissions: this.admissionCount,
      rejections: this.rejectionCount,
      promotions: this.promotionCount,
      demotions: this.demotionCount,
    };
  }

  getSegment(key: string): 'window' | 'probation' | 'protected' | null {
    if (this.window.has(key)) return 'window';
    if (this.probation.has(key)) return 'probation';
    if (this.protected_.has(key)) return 'protected';
    return null;
  }
}
