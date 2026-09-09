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
async function nodeToWebRequest(req: IncomingMessage): Promise<Request> {
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
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    if (chunks.length > 0) {
      body = Buffer.concat(chunks);
    }
  }

  const controller = new AbortController();
  req.on('close', () => {
    if (req.destroyed || !req.complete) {
      controller.abort();
    }
  });

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
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      nodeRes.write(value);
    }
  } finally {
    nodeRes.end();
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
      const webReq = await nodeToWebRequest(req);
      const webRes = await handleDashboardRequest(webReq, options);
      await pipeWebResponseToNode(webRes, res);
    } catch (err) {
      if (typeof next === 'function') {
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
  const port = options.port || 9090;
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
    }),
  };
}
