/**
 * Lightweight W3C TraceContext (traceparent) helpers for distributed context propagation.
 *
 * Implements W3C Trace Context Level 1:
 * Format: {version}-{traceId}-{spanId}-{traceFlags}
 * Example: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 */

export interface ParsedTraceParent {
  version: string;
  traceId: string;
  spanId: string;
  traceFlags: number;
}

/**
 * Parses a standard W3C traceparent header string into its components.
 * Returns null if the header is malformed.
 */
export function parseTraceParent(header: string | undefined | null): ParsedTraceParent | null {
  if (!header || typeof header !== 'string') return null;
  const parts = header.trim().split('-');
  if (parts.length < 4) return null;

  const [version, traceId, spanId, flagsStr] = parts;

  // Validate hex lengths
  if (version.length !== 2 || traceId.length !== 32 || spanId.length !== 16 || flagsStr.length !== 2) {
    return null;
  }

  // All-zero trace-id or span-id are invalid per W3C specification
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) {
    return null;
  }

  const traceFlags = parseInt(flagsStr, 16);
  if (Number.isNaN(traceFlags)) return null;

  return {
    version,
    traceId,
    spanId,
    traceFlags,
  };
}

/**
 * Formats trace components into a valid W3C traceparent header string.
 */
export function formatTraceParent(traceId: string, spanId: string, traceFlags = 1): string {
  const flagsHex = traceFlags.toString(16).padStart(2, '0');
  return `00-${traceId}-${spanId}-${flagsHex}`;
}
