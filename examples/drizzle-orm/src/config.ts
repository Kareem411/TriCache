import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** File-backed SQLite so `pnpm seed` and `pnpm demo` share the same data. */
export const DB_PATH = process.env.DB_PATH ?? path.join(root, 'data', 'demo.sqlite');

/**
 * Hard TTL passed to `withCache` / `cache.wrap` (`ttl` seconds).
 * Kept short so background SWR is observable without waiting a full minute.
 * Production would typically use something like `ttl: 300` with `swr: 60`.
 */
export const QUERY_TTL_SEC = envInt('QUERY_TTL_SEC', 2);

/** Stale-While-Revalidate grace passed to the adapter (`swr` seconds). */
export const QUERY_SWR_SEC = envInt('QUERY_SWR_SEC', 60);

/**
 * Simulated SELECT cost (ms). Cache hits skip SQLite + this delay, so HIT vs
 * MISS is obvious in wall-clock time as well as `cache.metrics()`.
 */
export const QUERY_LATENCY_MS = envInt('QUERY_LATENCY_MS', 200);
