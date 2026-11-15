import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleDashboardRequest } from './handler.js';
import type { DashboardOptions, StandaloneDashboardOptions } from './types.js';

export * from './types.js';
export { handleDashboardRequest, safeCompare, buildMetricsPayload, resolveInstanceId } from './handler.js';
export { DASHBOARD_HTML, DASHBOARD_GZIP_BUFFER } from './html.js';

/**
 * Convert a Node.js IncomingMessage into a Web Standards Request.
 */
async function nodeToWebRequest(req: IncomingMessage, res: ServerResponse, maxBytes: number): Promise<Request> {
  const protocol = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url || '/', `${protocol}://${host}`);

  const headers = new Headers();
  for (const [key, val] of Object.entries(req.headers)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      for (const item of val) headers.append(key, item);
    } else {
      headers.set(key, val);
    }
  }

  let body: Uint8Array | null = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks: Buffer[] = [];
    let size = 0;
    const parsed = (req as IncomingMessage & { body?: unknown }).body;
    if (req.readableEnded && parsed !== undefined) chunks.push(Buffer.from(JSON.stringify(parsed)));
    else for await (const chunk of req) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += bytes.length;
      if (size > maxBytes) throw Object.assign(new Error('Request body exceeds dashboard limit'), { status: 413 });
      chunks.push(bytes);
    }
    if (chunks.length > 0) {
      body = Buffer.concat(chunks);
      if (body.length > maxBytes) throw Object.assign(new Error('Request body exceeds dashboard limit'), { status: 413 });
    }
  }

  const controller = new AbortController();
  req.once('aborted', () => controller.abort());
  res.once('close', () => controller.abort());

  const init: RequestInit & { duplex?: string } = {
    method: req.method,
    headers,
    body: body ? (body as unknown as BodyInit) : null,
    signal: controller.signal,
  };
  if (body) {
    init.duplex = 'half';
  }

  return new Request(url.toString(), init);
}

/**
 * Pipe a Web Standards Response back into a Node.js ServerResponse.
 */
async function pipeWebResponseToNode(webRes: Response, nodeRes: ServerResponse): Promise<void> {
  nodeRes.statusCode = webRes.status;
  webRes.headers.forEach((val, key) => {
    nodeRes.setHeader(key, val);
  });

  if (!webRes.body) {
    nodeRes.end();
    return;
  }

  const reader = webRes.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  nodeRes.once('close', cancel);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (nodeRes.destroyed) break;
      if (!nodeRes.write(value)) await new Promise<void>((resolve, reject) => {
        const cleanup = () => { nodeRes.off('drain', onDrain); nodeRes.off('close', onClose); };
        const onDrain = () => { cleanup(); resolve(); };
        const onClose = () => { cleanup(); reject(new Error('Dashboard response closed')); };
        nodeRes.once('drain', onDrain);
        nodeRes.once('close', onClose);
      });
    }
  } finally {
    nodeRes.off('close', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    if (!nodeRes.destroyed) nodeRes.end();
  }
}

/**
 * Connect/Express/Fastify middleware adapter for the TriCache observability dashboard.
 *
 * @example
 * ```typescript
 * import { tricacheDashboard } from 'tricache/dashboard';
 *
 * app.use('/admin/cache', tricacheDashboard({
 *   cache,
 *   auth: { username: 'admin', password: process.env.DASHBOARD_PASSWORD },
 *   readOnly: process.env.NODE_ENV === 'production',
 * }));
 * ```
 */
export function tricacheDashboard(options: DashboardOptions) {
  return async (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void): Promise<void> => {
    try {
      const webReq = await nodeToWebRequest(req, res, options.maxRequestBytes ?? 65536);
      const webRes = await handleDashboardRequest(webReq, options);
      await pipeWebResponseToNode(webRes, res);
    } catch (err) {
      if (res.destroyed) return;
      if ((err as { status?: number }).status === 413) {
        res.statusCode = 413;
        res.setHeader('Connection', 'close');
        res.end(JSON.stringify({ error: 'Request body too large' }));
      } else if (typeof next === 'function') {
        next(err);
      } else {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    }
  };
}

/**
 * Next.js App Router route handlers for the TriCache dashboard.
 *
 * @example
 * ```typescript
 * // app/admin/cache/[...slug]/route.ts
 * import { createNextDashboardHandlers } from 'tricache/dashboard';
 * import { cache } from '@/lib/cache';
 *
 * export const { GET, POST } = createNextDashboardHandlers({
 *   cache,
 *   basePath: '/admin/cache',
 *   readOnly: true,
 * });
 * ```
 */
export function createNextDashboardHandlers(options: DashboardOptions) {
  const handler = async (req: Request): Promise<Response> => {
    return handleDashboardRequest(req, options);
  };
  return {
    GET: handler,
    POST: handler,
  };
}

/**
 * Starts a standalone, dedicated HTTP management server for the TriCache dashboard.
 * Ideal for microservices, background workers, and Kubernetes pods via `kubectl port-forward`.
 *
 * @example
 * ```typescript
 * import { startDashboardServer } from 'tricache/dashboard';
 *
 * const mgmt = await startDashboardServer({
 *   cache,
 *   port: 9090,
 *   host: '127.0.0.1',
 *   authSecret: process.env.MANAGEMENT_SECRET,
 * });
 * console.log(`Observability dashboard running at http://localhost:${mgmt.port}`);
 * ```
 */
export async function startDashboardServer(options: StandaloneDashboardOptions): Promise<{
  server: http.Server;
  port: number;
  host: string;
  close: () => Promise<void>;
}> {
  const port = options.port ?? 9090;
  const host = options.host || '127.0.0.1';

  const middleware = tricacheDashboard(options);
  const server = http.createServer((req, res) => {
    middleware(req, res).catch(err => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const actualAddress = server.address();
  const actualPort = typeof actualAddress === 'object' && actualAddress ? actualAddress.port : port;

  return {
    server,
    port: actualPort,
    host,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()));
      server.closeAllConnections();
    }),
  };
}
