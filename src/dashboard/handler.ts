import { createHash, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import { DASHBOARD_HTML, DASHBOARD_GZIP_BUFFER } from './html.js';
import type { DashboardOptions } from './types.js';

/**
 * Timing-safe string comparison routine using SHA-256 digests to neutralize
 * both length-leakage side-channels and buffer-length mismatch exceptions.
 */
export function safeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * Standard Security Headers applied to HTML responses.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
};

/**
 * Resolve local instance/pod identifier from options or environment.
 */
export function resolveInstanceId(custom?: string): string {
  if (custom && custom.trim()) return custom.trim();
  if (process.env.POD_NAME) return process.env.POD_NAME;
  if (process.env.HOSTNAME) return process.env.HOSTNAME;
  try {
    return os.hostname();
  } catch {
    return 'tricache-node';
  }
}

/**
 * Build the JSON snapshot payload for /api/metrics and SSE stream events.
 */
export function buildMetricsPayload(options: DashboardOptions): Record<string, unknown> {
  const metrics = options.cache.metrics();
  return {
    title: options.title || 'TriCache Observability',
    instanceId: resolveInstanceId(options.instanceId),
    nodeVersion: process.version,
    readOnly: !!options.readOnly,
    peerInstances: options.peerInstances || [],
    metrics: {
      ...metrics,
      health: {
        status: metrics.l2CircuitBreaker?.state === 'open' ? 'degraded' : 'healthy',
        circuitBreaker: metrics.l2CircuitBreaker?.state || 'closed',
        uptimeMs: metrics.uptimeMs,
      },
    },
    timestamp: Date.now(),
  };
}

/**
 * Validate incoming authentication against configured Basic Auth or Bearer secret.
 */
function verifyAuth(req: Request, options: DashboardOptions): { authorized: boolean; user?: string } {
  const url = new URL(req.url, 'http://localhost');

  // 1. Basic Auth check
  if (options.auth) {
    const authHeader = req.headers.get('authorization') || '';
    if (!authHeader.toLowerCase().startsWith('basic ')) {
      return { authorized: false };
    }
    const b64 = authHeader.slice(6).trim();
    let decoded = '';
    try {
      decoded = Buffer.from(b64, 'base64').toString('utf-8');
    } catch {
      return { authorized: false };
    }
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) return { authorized: false };

    const username = decoded.slice(0, colonIdx);
    const password = decoded.slice(colonIdx + 1);

    const userMatch = safeCompare(username, options.auth.username);
    const passMatch = safeCompare(password, options.auth.password);

    if (userMatch && passMatch) {
      return { authorized: true, user: username };
    }
    return { authorized: false };
  }

  // 2. Bearer Secret check
  if (options.authSecret) {
    const authHeader = req.headers.get('authorization') || '';
    if (authHeader.toLowerCase().startsWith('bearer ')) {
      const token = authHeader.slice(7).trim();
      if (safeCompare(token, options.authSecret)) {
        return { authorized: true, user: 'token-client' };
      }
    }
    // Check URL query parameter fallback
    const queryToken = url.searchParams.get('token');
    if (queryToken && safeCompare(queryToken, options.authSecret)) {
      return { authorized: true, user: 'token-client' };
    }
    return { authorized: false };
  }

  // No auth required
  return { authorized: true, user: 'anonymous' };
}

/**
 * Validate CSRF protection on mutating endpoints.
 * Requires mandatory 'X-TriCache-Action: 1' and origin/host verification.
 */
function verifyCsrf(req: Request): boolean {
  // Enforce custom header which cannot be sent by standard cross-origin forms
  const customHeader = req.headers.get('x-tricache-action');
  if (customHeader !== '1') {
    return false;
  }

  // Origin / Referer validation if present
  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) return false;
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Framework-agnostic Web Standards request handler for the TriCache dashboard.
 * Accepts a Web Standard Request and returns a Web Standard Response.
 */
export async function handleDashboardRequest(req: Request, options: DashboardOptions): Promise<Response> {
  // 1. Authenticate request
  const authResult = verifyAuth(req, options);
  if (!authResult.authorized) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        ...(options.auth ? { 'WWW-Authenticate': 'Basic realm="TriCache Dashboard"' } : {}),
      },
    });
  }

  const url = new URL(req.url, 'http://localhost');
  let pathname = url.pathname;

  // Strip basePath if present
  const basePath = (options.basePath || '').replace(/\/+$/, '');
  if (basePath && pathname.startsWith(basePath)) {
    pathname = pathname.slice(basePath.length) || '/';
  }

  // Normalize path
  if (!pathname.startsWith('/')) {
    pathname = '/' + pathname;
  }

  // Route 1: SSE Live Metric Stream
  if (pathname === '/api/stream' && req.method === 'GET') {
    const encoder = new TextEncoder();
    const intervalMs = Math.max(500, options.streamIntervalMs || 2000);

    let ticker: NodeJS.Timeout | null = null;

    const stream = new ReadableStream({
      start(controller) {
        // Send immediate initial frame
        try {
          const initial = buildMetricsPayload(options);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(initial)}\n\n`));
        } catch { /* ignore */ }

        // Start periodic broadcast ticker
        ticker = setInterval(() => {
          try {
            const data = buildMetricsPayload(options);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            if (ticker) clearInterval(ticker);
            try { controller.close(); } catch { /* ignore */ }
          }
        }, intervalMs);

        // Tie ticker directly to request abort signal to prevent event loop leaks
        if (req.signal) {
          req.signal.addEventListener('abort', () => {
            if (ticker) {
              clearInterval(ticker);
              ticker = null;
            }
            try { controller.close(); } catch { /* ignore */ }
          });
        }
      },
      cancel() {
        if (ticker) {
          clearInterval(ticker);
          ticker = null;
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  // Route 2: Snapshot Metrics JSON
  if (pathname === '/api/metrics' && req.method === 'GET') {
    const payload = buildMetricsPayload(options);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  }

  // Route 3: Mutating Action - Invalidate Tag
  if (pathname === '/api/actions/invalidate-tag' && req.method === 'POST') {
    const clientIp = req.headers.get('x-forwarded-for') || undefined;

    // Check Read-Only Mode
    if (options.readOnly) {
      return new Response(JSON.stringify({ ok: false, error: 'Dashboard is in read-only mode' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // CSRF Check
    if (!verifyCsrf(req)) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid or missing CSRF headers' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const body = await req.json() as { tag?: string };
      const tag = body?.tag?.trim();
      if (!tag) {
        return new Response(JSON.stringify({ ok: false, error: 'Tag parameter is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      await options.cache.invalidateTag(tag);

      // Audit log hook
      options.onAction?.({
        action: 'invalidate-tag',
        target: tag,
        user: authResult.user,
        ip: clientIp,
        timestamp: Date.now(),
        success: true,
      });

      return new Response(JSON.stringify({ ok: true, tag }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      options.onAction?.({
        action: 'invalidate-tag',
        user: authResult.user,
        ip: clientIp,
        timestamp: Date.now(),
        success: false,
        error: errMsg,
      });
      return new Response(JSON.stringify({ ok: false, error: errMsg }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Route 4: Mutating Action - Clear Cache
  if (pathname === '/api/actions/clear' && req.method === 'POST') {
    const clientIp = req.headers.get('x-forwarded-for') || undefined;

    // Check Read-Only Mode
    if (options.readOnly) {
      return new Response(JSON.stringify({ ok: false, error: 'Dashboard is in read-only mode' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // CSRF Check
    if (!verifyCsrf(req)) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid or missing CSRF headers' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      await options.cache.clear();

      options.onAction?.({
        action: 'clear',
        user: authResult.user,
        ip: clientIp,
        timestamp: Date.now(),
        success: true,
      });

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      options.onAction?.({
        action: 'clear',
        user: authResult.user,
        ip: clientIp,
        timestamp: Date.now(),
        success: false,
        error: errMsg,
      });
      return new Response(JSON.stringify({ ok: false, error: errMsg }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Route 5: Embedded SPA UI (Default)
  if (pathname === '/' || pathname === '/index.html' || pathname === '') {
    const acceptEncoding = req.headers.get('accept-encoding') || '';

    // Serve pre-gzipped binary payload if client accepts gzip
    if (acceptEncoding.includes('gzip')) {
      return new Response(new Uint8Array(DASHBOARD_GZIP_BUFFER), {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Content-Length': String(DASHBOARD_GZIP_BUFFER.length),
          ...SECURITY_HEADERS,
        },
      });
    }

    // Fallback uncompressed
    return new Response(DASHBOARD_HTML, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        ...SECURITY_HEADERS,
      },
    });
  }

  // 404 Not Found
  return new Response(JSON.stringify({ error: 'Not Found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}
