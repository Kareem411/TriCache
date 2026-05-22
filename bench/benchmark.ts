/**
 * tricache benchmark — measures L1 throughput and stampede prevention.
 *
 * Run: node --import tsx bench/benchmark.ts
 *   or: pnpm bench
 */

import { CacheService } from '../src/cache-service';
import { SmartMemoryCache } from '../src/smart-memory-cache';
import { CachePriority, consoleLogger } from '../src/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number, unit = ''): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 }) + unit;
}

async function bench(label: string, fn: () => Promise<void> | void, iters = 100_000): Promise<void> {
  // Warmup
  for (let i = 0; i < Math.min(iters / 10, 1000); i++) await fn();

  const start = performance.now();
  for (let i = 0; i < iters; i++) await fn();
  const ms = performance.now() - start;

  const opsPerSec = Math.round((iters / ms) * 1000);
  const nsPerOp  = Math.round((ms / iters) * 1_000_000);
  console.log(`  ${label.padEnd(42)} ${fmt(opsPerSec, ' ops/s').padStart(16)}   ${fmt(nsPerOp, ' ns/op').padStart(12)}`);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

const cache = CacheService.reset({ disableRedis: true });

const l1 = new SmartMemoryCache({
  maxBytes:   200 * 1024 * 1024,
  maxEntries: 10_000,
  categories: { default: { maxEntries: 10_000, maxSizeBytes: 200 * 1024 * 1024 } },
  logger:     consoleLogger,
});

// Pre-populate L1 with 1000 entries
for (let i = 0; i < 1_000; i++) {
  l1.set(`key:${i}`, { id: i, name: `item-${i}`, data: 'x'.repeat(64) }, 60_000, { priority: CachePriority.NORMAL });
}

// ── Benchmarks ────────────────────────────────────────────────────────────────

console.log('\n  tricache benchmark\n');
console.log('  ' + '─'.repeat(74));

// L1 hot hit (key is known to be in cache)
let i = 0;
await bench('L1 get — hot hit (always in cache)', () => {
  l1.get(`key:${i++ % 1000}`);
});

// L1 cold miss (bloom filter short-circuit)
await bench('L1 get — cold miss (bloom filter)', () => {
  l1.get(`missing:${i++ % 1000}`);
});

// L1 set (small entry, no compression)
await bench('L1 set — small value (< 512B, no compression)', () => {
  l1.set(`bench:small:${i++ % 1000}`, { v: i }, 60_000);
});

// L1 set (large entry, msgpackr compression)
const bigPayload = { data: 'y'.repeat(2048), items: Array.from({ length: 10 }, (_, k) => ({ id: k, val: k * 2 })) };
await bench('L1 set — large value (≥ 512B, msgpackr)', () => {
  l1.set(`bench:large:${i++ % 1000}`, bigPayload, 60_000);
});

// CacheService.get — L1 hit path (no fetchFn called)
await cache.set('bench:warm', { x: 1 }, 300);
await bench('CacheService.get — L1 warm hit', async () => {
  await cache.get('bench:warm', () => Promise.resolve({ x: 1 }), 300);
});

// CacheService.get — miss path with instant fetch
let fetchCount = 0;
await bench('CacheService.get — L1 miss → fetchFn', async () => {
  const k = `miss:${i++ % 100}`; // rotate keys to keep misses real
  cache.delete(k);
  await cache.get(k, async () => ({ fetched: ++fetchCount }), 1);
}, 10_000);

// Stampede prevention: 10 concurrent gets for the same key
await bench('Stampede prevention (10 concurrent gets, 1 fetch)', async () => {
  const key = `herd:${i++}`;
  let calls = 0;
  await Promise.all(Array.from({ length: 10 }, () =>
    cache.get(key, async () => { calls++; return { v: calls }; }, 60)
  ));
}, 5_000);

console.log('  ' + '─'.repeat(74));
console.log('\n  Done.\n');
process.exit(0);
