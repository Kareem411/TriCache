import crypto from 'crypto';

export interface KeyDerivationOptions {
  /** Custom key derivation function. Overrides default URL and query string serialization. */
  keyGenerator?: (req: any) => string;
  /** Optional list of header names (case-insensitive) to include in the cache key. */
  headerWhitelist?: string[];
  /** Opt in to authenticated request caching with an identity-aware key. Default: false. */
  cacheAuthenticated?: boolean;
}

export type HttpHeaderValue = string | number | string[] | undefined | null;

export function readHttpHeader(headers: any, name: string): HttpHeaderValue {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  const lower = name.toLowerCase();
  return headers[lower] ?? headers[name] ?? Object.entries(headers).find(([key]) => key.toLowerCase() === lower)?.[1] as HttpHeaderValue;
}

export function hasCacheBypassDirective(value: HttpHeaderValue): boolean {
  if (value == null) return false;
  return String(value).split(',').some(part => /^(?:private|no-cache|no-store)(?:\s*=|\s*$)/i.test(part.trim()));
}

/** Shared-cache safety checks applied BEFORE a response enters storage or singleflight results. */
export function isShareableHttpResponse(
  status: number,
  header: (name: string) => HttpHeaderValue,
  options: KeyDerivationOptions = {},
): boolean {
  if (status === 206 || hasCacheBypassDirective(header('cache-control')) || header('set-cookie')) return false;
  if (String(header('content-type') ?? '').toLowerCase().includes('text/event-stream')) return false;
  const vary = String(header('vary') ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const keyedHeaders = new Set(options.headerWhitelist?.map(name => name.toLowerCase()));
  return !vary.includes('*') && (Boolean(options.keyGenerator) || vary.every(name => keyedHeaders.has(name)));
}

export function isCacheableHttpResponse(status: number, header: (name: string) => HttpHeaderValue, options?: KeyDerivationOptions): boolean {
  return status >= 200 && status < 300 && isShareableHttpResponse(status, header, options);
}

export function matchesETag(header: HttpHeaderValue, etag: string): boolean {
  if (header == null) return false;
  const normalized = etag.replace(/^W\//, '');
  return String(header).split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === normalized);
}

/**
 * Generates a deterministic HTTP cache key from request method, URL path, sorted query parameters,
 * and optional whitelisted headers.
 *
 * Example:
 *   GET /api/products?sort=desc&page=2
 *   GET /api/products?page=2&sort=desc
 *   Both map to: http:GET:/api/products?page=2&sort=desc
 */
export function buildDeterministicKey(req: any, options?: KeyDerivationOptions): string {
  if (options?.keyGenerator) {
    return options.keyGenerator(req);
  }

  const method = (req.method || 'GET').toUpperCase();
  const rawUrl = req.originalUrl || req.url || '/';

  const qIdx = rawUrl.indexOf('?');
  const path = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  let queryString = '';

  if (qIdx >= 0) {
    const rawQuery = rawUrl.slice(qIdx + 1);
    try {
      const params = new URLSearchParams(rawQuery);
      params.sort();
      queryString = params.toString();
    } catch {
      queryString = rawQuery;
    }
  }

  let key = `http:${method}:${path}`;
  if (queryString) {
    key += `?${queryString}`;
  }

  if (options?.headerWhitelist && options.headerWhitelist.length > 0 && req.headers) {
    const sortedHeaders = [...new Set(options.headerWhitelist.map(h => h.toLowerCase()))].sort();
    for (const h of sortedHeaders) {
      const normalizedHeader = h.toLowerCase();
      const val = readHttpHeader(req.headers, normalizedHeader);
      if (val !== undefined && val !== null && val !== '') {
        const headerStr = Array.isArray(val) ? val.join(',') : String(val);
        const identity = /authorization|cookie|token|api-key/.test(normalizedHeader)
          ? crypto.createHash('sha256').update(headerStr).digest('hex') : encodeURIComponent(headerStr);
        key += `|h:${normalizedHeader}=${identity}`;
      }
    }
  }

  return key;
}

/**
 * Checks if request specifies Cache-Control bypass directives (no-cache, no-store)
 * or matches a custom skipCache predicate.
 */
export function shouldSkipCache(req: any, customSkip?: (req: any) => boolean, options: KeyDerivationOptions = {}): boolean {
  if (customSkip && customSkip(req)) return true;
  if (hasCacheBypassDirective(readHttpHeader(req.headers, 'cache-control')) || readHttpHeader(req.headers, 'range')) return true;
  const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key', 'x-auth-token'].filter(name => readHttpHeader(req.headers, name));
  if (sensitiveHeaders.length > 0) {
    if (!options.cacheAuthenticated) return true;
    const keyedHeaders = new Set(options.headerWhitelist?.map(name => name.toLowerCase()));
    if (!options.keyGenerator && !sensitiveHeaders.every(name => keyedHeaders.has(name))) return true;
  }
  return false;
}

/**
 * Compute a weak ETag (W/"...") from string, Buffer, or JSON-serializable object.
 */
export function generateETag(data: unknown): string {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data) ?? '', 'utf8');
  const hash = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 16);
  return `W/"${bytes.length.toString(16)}-${hash}"`;
}
