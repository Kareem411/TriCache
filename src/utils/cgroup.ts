import fs from 'node:fs';
import v8 from 'node:v8';

/** Unbounded / sentinel limit threshold for cgroup memory (e.g. 9223372036854771712 or MAX_INT) */
const UNBOUNDED_CGROUP_THRESHOLD = 9_000_000_000_000_000_000;

/** Default safety ceiling for autonomous L1 memory allocations: 512 MB */
export const DEFAULT_AUTONOMOUS_L1_CEILING_BYTES = 512 * 1024 * 1024;

/** Minimum floor for autonomous L1 allocations: 16 MB */
export const MIN_AUTONOMOUS_L1_FLOOR_BYTES = 16 * 1024 * 1024;

/**
 * Reads the container memory limit from Linux cgroups (v2 or v1).
 *
 * Defaults to `Infinity` when running outside Linux, when cgroup limits are unset ('max'),
 * or when permission errors (EACCES / ENOENT) occur in hardened distroless environments.
 */
export function readCgroupMemoryLimit(): number {
  if (process.platform !== 'linux') {
    return Infinity;
  }

  // 1. Probe cgroup v2: /sys/fs/cgroup/memory.max
  try {
    if (fs.existsSync('/sys/fs/cgroup/memory.max')) {
      const raw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
      if (raw === 'max') {
        return Infinity;
      }
      const bytes = parseInt(raw, 10);
      if (Number.isFinite(bytes) && bytes > 0 && bytes < UNBOUNDED_CGROUP_THRESHOLD) {
        return bytes;
      }
    }
  } catch {
    // EACCES, ENOENT, or unreadable — fall through to cgroup v1 or Infinity
  }

  // 2. Probe cgroup v1: /sys/fs/cgroup/memory/memory.limit_in_bytes
  try {
    if (fs.existsSync('/sys/fs/cgroup/memory/memory.limit_in_bytes')) {
      const raw = fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim();
      const bytes = parseInt(raw, 10);
      if (Number.isFinite(bytes) && bytes > 0 && bytes < UNBOUNDED_CGROUP_THRESHOLD) {
        return bytes;
      }
    }
  } catch {
    // EACCES, ENOENT, or unreadable
  }

  return Infinity;
}

/** Current cgroup usage includes tmpfs/page-cache charges that are absent from process RSS. */
export function readCgroupMemoryUsage(): number | null {
  if (process.platform !== 'linux') return null;
  for (const file of ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes']) {
    try {
      const value = Number(fs.readFileSync(file, 'utf8').trim());
      if (Number.isFinite(value) && value >= 0) return value;
    } catch { /* unavailable or unreadable */ }
  }
  return null;
}

/**
 * Returns the V8 JavaScript heap size limit in bytes.
 * Safely guards against missing or mock environments.
 */
export function getV8HeapLimit(): number {
  try {
    const stats = v8.getHeapStatistics();
    if (stats && Number.isFinite(stats.heap_size_limit) && stats.heap_size_limit > 0) {
      return stats.heap_size_limit;
    }
  } catch {
    // Fallback if v8 module is mocked or unavailable
  }
  return Infinity;
}

export interface AutonomousL1Options {
  cgroupLimit?: number;
  v8HeapLimit?: number;
  defaultCeilingBytes?: number;
}

/**
 * Computes an autonomous, safe memory bound for TriCache L1 RAM.
 *
 * Evaluates both the container cgroup limit (max 40% of container RAM)
 * and the V8 heap limit (max 50% of V8 heap limit from --max-old-space-size),
 * capped at a default 512MB ceiling.
 */
export function resolveAutonomousL1MaxBytes(options?: AutonomousL1Options): number {
  const cgroup = options?.cgroupLimit !== undefined ? options.cgroupLimit : readCgroupMemoryLimit();
  const v8Limit = options?.v8HeapLimit !== undefined ? options.v8HeapLimit : getV8HeapLimit();
  const ceiling = options?.defaultCeilingBytes ?? DEFAULT_AUTONOMOUS_L1_CEILING_BYTES;

  const cgroupCap = Number.isFinite(cgroup) && cgroup > 0 ? cgroup * 0.40 : Infinity;
  const v8Cap = Number.isFinite(v8Limit) && v8Limit > 0 ? v8Limit * 0.50 : Infinity;

  const resolved = Math.min(cgroupCap, v8Cap, ceiling);

  if (!Number.isFinite(resolved) || resolved <= 0) {
    return ceiling;
  }

  return Math.max(MIN_AUTONOMOUS_L1_FLOOR_BYTES, Math.floor(resolved));
}
