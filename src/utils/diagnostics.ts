/** Produce a bounded, JSON-safe diagnostic view without retaining opaque credential holders. */
export function redactDiagnostics(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'string' && /^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.username) url.username = '[REDACTED]';
      if (url.password) url.password = '[REDACTED]';
      for (const key of url.searchParams.keys()) {
        if (/key|token|secret|password|credential|authorization|cookie/i.test(key)) url.searchParams.set(key, '[REDACTED]');
      }
      return url.toString();
    } catch { return '[REDACTED URL]'; }
  }
  if (value == null || typeof value !== 'object') return typeof value === 'function' ? undefined : value;
  if (depth >= 8) return '[OMITTED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redactDiagnostics(item, seen, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'function') continue; // In particular, never preserve an opaque toJSON().
    result[key] = /key|token|secret|password|credential|authorization|cookie|headers/i.test(key)
      ? item == null ? item : '[REDACTED]'
      : redactDiagnostics(item, seen, depth + 1);
  }
  return result;
}
