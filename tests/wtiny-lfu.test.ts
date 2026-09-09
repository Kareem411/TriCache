import { describe, it, expect } from 'vitest';
import { WTinyLfuCache, TinyLfuSketch, WTinyLfuPolicy } from '../src/wtiny-lfu.js';

describe('Window TinyLFU (W-TinyLFU) Admission Policy', () => {
  describe('TinyLfuSketch', () => {
    it('estimates frequency and decays on threshold', () => {
      const sketch = new TinyLfuSketch(256, 100);

      expect(sketch.estimate('key-a')).toBe(0);

      sketch.increment('key-a');
      sketch.increment('key-a');
      sketch.increment('key-a');
      expect(sketch.estimate('key-a')).toBe(3);

      sketch.increment('key-b');
      expect(sketch.estimate('key-b')).toBe(1);

      // Force decay
      sketch.decay();
      expect(sketch.estimate('key-a')).toBe(1); // 3 >>> 1 = 1
      expect(sketch.estimate('key-b')).toBe(0); // 1 >>> 1 = 0
    });
  });

  describe('WTinyLfuCache Architecture', () => {
    it('initializes segments with proper proportional capacities', () => {
      const cache = new WTinyLfuCache({
        capacity: 100,
        windowPercent: 0.10, // 10% Window (10)
        protectedPercent: 0.80, // 80% Protected of 90 = 72, Probation = 18
      });

      expect(cache.capacity).toBe(100);
      expect(cache.size).toBe(0);

      const stats = cache.stats();
      expect(stats.windowSize).toBe(0);
      expect(stats.probationSize).toBe(0);
      expect(stats.protectedSize).toBe(0);
    });

    it('admits new items into Window cache first', () => {
      const cache = new WTinyLfuCache({
        capacity: 20,
        windowPercent: 0.20, // Window = 4
      });

      cache.set('item:1', 'val1');
      cache.set('item:2', 'val2');

      expect(cache.getSegment('item:1')).toBe('window');
      expect(cache.getSegment('item:2')).toBe('window');
      expect(cache.get('item:1')).toBe('val1');
    });

    it('promotes entries from Probation to Protected on second hit', () => {
      const cache = new WTinyLfuCache({
        capacity: 10,
        windowPercent: 0.10, // Window = 1
        protectedPercent: 0.70,
      });

      // Window capacity is 1
      cache.set('w1', 1); // in Window
      cache.set('w2', 2); // w1 evicted from Window -> enters Probation

      expect(cache.getSegment('w1')).toBe('probation');
      expect(cache.getSegment('w2')).toBe('window');

      // Access w1 while in Probation -> should promote to Protected
      const val = cache.get('w1');
      expect(val).toBe(1);
      expect(cache.getSegment('w1')).toBe('protected');

      const stats = cache.stats();
      expect(stats.promotions).toBe(1);
    });

    it('demotes oldest Protected item to Probation when Protected overflows', () => {
      const cache = new WTinyLfuCache({
        capacity: 6,
        windowPercent: 0.16, // Window = 1
        protectedPercent: 0.60, // Main = 5: Protected = 3, Probation = 2
      });

      // Fill and promote 3 items to Protected
      cache.set('k1', 1);
      cache.set('k2', 2); // k1 -> probation
      cache.get('k1');    // k1 -> protected (1/3)

      cache.set('k3', 3); // k2 -> probation
      cache.get('k2');    // k2 -> protected (2/3)

      cache.set('k4', 4); // k3 -> probation
      cache.get('k3');    // k3 -> protected (3/3: protected full)

      expect(cache.getSegment('k1')).toBe('protected');
      expect(cache.getSegment('k2')).toBe('protected');
      expect(cache.getSegment('k3')).toBe('protected');

      // Promote 4th item to Protected: should cause oldest protected (k1) to demote to probation
      cache.set('k5', 5); // k4 -> probation
      cache.get('k4');    // k4 -> protected (triggers demotion of k1)

      expect(cache.getSegment('k4')).toBe('protected');
      expect(cache.getSegment('k1')).toBe('probation'); // Demoted!

      const stats = cache.stats();
      expect(stats.demotions).toBe(1);
    });

    it('TinyLFU admission gate admits candidate with higher frequency over victim', () => {
      const cache = new WTinyLfuCache({
        capacity: 4,
        windowPercent: 0.25, // Window = 1, Main = 3 (Probation = 1, Protected = 2)
      });

      // Populate cache completely
      cache.set('a', 10); // in window
      cache.set('b', 20); // a -> probation, b in window
      cache.get('a');     // a -> protected
      cache.set('c', 30); // b -> probation, c in window
      cache.get('b');     // b -> protected
      cache.set('d', 40); // c -> probation (victim), d in window

      expect(cache.getSegment('c')).toBe('probation'); // victim in probation

      // Give new candidate 'cand' a high frequency before admission
      for (let i = 0; i < 5; i++) {
        cache.set('cand', 999);
      }
      // 'cand' is now at Window, with frequency >= 5. Victim 'c' has frequency ~ 1.
      // Next insertion pushes 'cand' out of Window to compete with 'c'.
      const result = cache.set('pusher', 123);

      // 'cand' should beat 'c' at the TinyLFU admission gate
      expect(result.evicted?.key).toBe('c');
      expect(cache.getSegment('cand')).toBe('probation');
      expect(cache.has('c')).toBe(false);
    });

    it('TinyLFU admission gate drops candidate with lower frequency', () => {
      const cache = new WTinyLfuCache({
        capacity: 4,
        windowPercent: 0.25, // Window = 1, Main = 3 (Probation = 1, Protected = 2)
      });

      cache.set('a', 10);
      cache.set('b', 20);
      cache.get('a');
      cache.set('c', 30);
      cache.get('b');
      cache.set('d', 40); // c is in probation

      // Build frequency on victim 'c'
      cache.get('c');
      cache.get('c');
      cache.get('c'); // 'c' has multiple accesses

      // Insert brand new candidate 'one-hit-wonder' with frequency 1
      cache.set('one-hit-wonder', 1);

      // Next insert pushes 'one-hit-wonder' out of window.
      // Since freq('one-hit-wonder') < freq('c'), candidate must be dropped!
      const result = cache.set('next', 2);

      expect(result.rejected?.key).toBe('one-hit-wonder');
      expect(cache.has('one-hit-wonder')).toBe(false);
      expect(cache.has('c')).toBe(true); // 'c' survived!
    });
  });

  describe('Mathematical Scan Resistance Benchmark Test', () => {
    it('guarantees scan resistance: a 1000-key sequential flood never displaces protected hot keys', () => {
      const cache = new WTinyLfuCache<string, number>({
        capacity: 50,
        windowPercent: 0.04, // 2 items in Window
        protectedPercent: 0.80, // Main = 48: 38 Protected, 10 Probation
      });

      // 1. Prime 25 hot keys with high frequency and promote them to Protected
      const hotKeys = Array.from({ length: 25 }, (_, i) => `hot:item:${i}`);
      for (const k of hotKeys) {
        cache.set(k, 1);
      }
      // Push trailing hot keys through Window into Probation
      cache.set('flush:1', 0);
      cache.set('flush:2', 0);

      // Hit all hot keys to promote from Probation into Protected and build frequency
      for (const k of hotKeys) {
        for (let hit = 0; hit < 10; hit++) {
          cache.get(k);
        }
      }

      // Verify all hot keys are in Protected segment
      for (const k of hotKeys) {
        expect(cache.getSegment(k)).toBe('protected');
      }

      // 2. Unleash a massive 1,000-key sequential database scan (each key accessed only once)
      for (let scan = 0; scan < 1000; scan++) {
        cache.set(`scan:item:${scan}`, scan);
      }

      // 3. Scan Resistance Proof: ALL 25 hot keys MUST still reside in cache with 100% hit rate
      let hotHits = 0;
      for (const k of hotKeys) {
        if (cache.has(k)) hotHits++;
      }

      expect(hotHits).toBe(hotKeys.length); // 100% retention!

      // Telemetry asserts that scan keys were rejected by TinyLFU admission gate
      const stats = cache.stats();
      expect(stats.rejections).toBeGreaterThan(900);
      expect(stats.protectedSize).toBe(hotKeys.length);
    });
  });

  describe('Edge Cases & Cache Lifecycle', () => {
    it('updates value in place when setting an existing key', () => {
      const cache = new WTinyLfuCache<string, string>({ capacity: 10 });

      cache.set('user:1', 'Alice');
      expect(cache.get('user:1')).toBe('Alice');

      cache.set('user:1', 'Bob');
      expect(cache.get('user:1')).toBe('Bob');
      expect(cache.size).toBe(1);
    });

    it('correctly deletes keys and clears state', () => {
      const cache = new WTinyLfuCache<string, number>({ capacity: 10 });

      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      expect(cache.delete('b')).toBe(true);
      expect(cache.delete('non-existent')).toBe(false);
      expect(cache.has('b')).toBe(false);

      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.stats().size).toBe(0);
    });

    it('iterates through all entries across all segments', () => {
      const cache = new WTinyLfuCache<string, number>({ capacity: 10 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      const keys = Array.from(cache.keys());
      expect(keys).toContain('a');
      expect(keys).toContain('b');
      expect(keys).toContain('c');

      const entries = Array.from(cache.entries());
      expect(entries).toEqual(expect.arrayContaining([
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ]));
    });
  });

  describe('WTinyLfuPolicy Controller', () => {
    it('coordinates segment promotion and admission decisions for tiered caches', () => {
      const sketch = new TinyLfuSketch(256);
      const policy = new WTinyLfuPolicy(4, sketch, 0.25, 0.50); // Window=1, Main=3 (Prot=1, Prob=2)

      // Admit k1 into Window
      const d1 = policy.onSet('k1', false);
      expect(d1.admit).toBe(true);
      expect(policy.getSegment('k1')).toBe('window');

      // Admit k2: k1 pushed to Probation
      const d2 = policy.onSet('k2', false);
      expect(d2.admit).toBe(true);
      expect(policy.getSegment('k1')).toBe('probation');
      expect(policy.getSegment('k2')).toBe('window');

      // Access k1 in Probation -> promoted to Protected
      policy.onAccess('k1');
      expect(policy.getSegment('k1')).toBe('protected');

      // Delete k1
      policy.onDelete('k1');
      expect(policy.getSegment('k1')).toBeNull();

      // Clear
      policy.clear();
      expect(policy.windowSize).toBe(0);
      expect(policy.probationSize).toBe(0);
      expect(policy.protectedSize).toBe(0);
    });
  });
});
