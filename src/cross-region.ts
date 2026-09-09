/**
 * tricache — Multi-Cluster / Geo-Distributed Cross-Region Invalidation Relay
 *
 * Enables multi-region architectures (e.g. us-east-1 + eu-central-1) with independent
 * Redis clusters to synchronize invalidations across regions without expensive
 * active-active Redis Enterprise licenses.
 */

export interface CrossRegionInvalidationEvent {
  /** Unique ID of this invalidation event (UUIDv4) */
  id: string;
  /** Region where the invalidation originated, e.g. 'us-east-1' */
  originRegion: string;
  /** Instance ID that initiated the invalidation */
  originInstanceId: string;
  /** Invalidation operation */
  op: 'del' | 'del-glob' | 'tag_incr';
  /** Cache key or tag name */
  key: string;
  /** New tag version for generational tag invalidation */
  tagVersion?: number;
  /** Timestamp when the event was created */
  timestamp: number;
  /** Optional namespace of the origin cache */
  namespace?: string;
}

export interface ICrossRegionRelay {
  /**
   * Broadcasts an invalidation event across regions (via HTTP mesh, SNS, SQS, EventBridge, or custom bus).
   */
  broadcast(event: CrossRegionInvalidationEvent): Promise<void>;
}

export interface CrossRegionRelayOptions {
  /**
   * Region identifier for this instance, e.g. 'us-east-1' or 'eu-central-1'.
   */
  currentRegion: string;

  /**
   * Cross-region relay implementation.
   */
  relay: ICrossRegionRelay;

  /**
   * Optional shared secret or bearer token for authenticating HTTP webhook mesh calls.
   */
  authSecret?: string;

  /**
   * Max entries stored in the deduplication cache for preventing invalidation loop echoes.
   * Default: 10,000.
   */
  dedupCacheSize?: number;

  /**
   * Whether writes via `set()` should also broadcast cross-region.
   * Default: `false` (only explicit invalidations `delete()`, `deletePattern()`,
   * and `invalidateTag()` broadcast cross-region, avoiding inter-region thrashing
   * when independent caches populate from local databases).
   */
  broadcastOnSet?: boolean;
}

export interface HttpMeshRelayOptions {
  /**
   * Array of peer regional webhook endpoints (e.g. ['https://eu.internal.api/cache/invalidation']).
   */
  peerUrls: string[];

  /**
   * Optional authentication secret sent in the `Authorization: Bearer <secret>` header.
   */
  authSecret?: string;

  /**
   * Request timeout in milliseconds for each peer. Default: 3000 ms.
   */
  timeoutMs?: number;

  /**
   * Optional fetch implementation (defaults to globalThis.fetch).
   */
  fetchFn?: typeof fetch;
}

/**
 * Creates an HTTP-based peer mesh relay using native Node 22 `fetch()`.
 * Broadcasts events concurrently to all configured peer URLs.
 */
export function createHttpMeshRelay(options: HttpMeshRelayOptions): ICrossRegionRelay {
  const peerUrls = options.peerUrls;
  const timeoutMs = options.timeoutMs ?? 3000;
  const fetcher = options.fetchFn ?? globalThis.fetch;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (options.authSecret) {
    headers['Authorization'] = `Bearer ${options.authSecret}`;
    headers['X-TriCache-Auth'] = options.authSecret;
  }

  return {
    async broadcast(event: CrossRegionInvalidationEvent): Promise<void> {
      if (!peerUrls.length) return;

      const body = JSON.stringify(event);
      await Promise.allSettled(
        peerUrls.map(async (url) => {
          const res = await fetcher(url, {
            method: 'POST',
            headers,
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!res.ok) {
            throw new Error(`HttpMeshRelay: peer ${url} returned HTTP ${res.status} ${res.statusText}`);
          }
        }),
      );
    },
  };
}

/**
 * Type-checking helper for custom cross-region relays (AWS SNS/SQS, EventBridge, Kafka, NATS).
 */
export function createCustomCrossRegionRelay(relay: ICrossRegionRelay): ICrossRegionRelay {
  return relay;
}

/**
 * In-memory cross-region mesh bus designed for unit testing and multi-region simulations.
 */
export function createMemoryCrossRegionRelay(): ICrossRegionRelay & {
  register(region: string, handler: (event: CrossRegionInvalidationEvent) => Promise<unknown> | unknown): () => void;
  getBroadcastCount(): number;
  clear(): void;
} {
  const handlers = new Map<string, Set<(event: CrossRegionInvalidationEvent) => Promise<unknown> | unknown>>();
  let broadcastCount = 0;

  return {
    async broadcast(event: CrossRegionInvalidationEvent): Promise<void> {
      broadcastCount++;
      const promises: Promise<unknown>[] = [];
      for (const [region, set] of handlers.entries()) {
        // Only deliver to handlers in DIFFERENT regions
        if (region !== event.originRegion) {
          for (const fn of set) {
            promises.push(Promise.resolve(fn(event)));
          }
        }
      }
      await Promise.allSettled(promises);
    },

    register(region: string, handler: (event: CrossRegionInvalidationEvent) => Promise<unknown> | unknown): () => void {
      if (!handlers.has(region)) {
        handlers.set(region, new Set());
      }
      handlers.get(region)!.add(handler);
      return () => {
        handlers.get(region)?.delete(handler);
      };
    },

    getBroadcastCount(): number {
      return broadcastCount;
    },

    clear(): void {
      handlers.clear();
      broadcastCount = 0;
    },
  };
}

export interface WebhookRequestLike {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface WebhookResponseLike {
  status: number;
  body: { ok: boolean; message?: string };
}

/**
 * Creates a generic webhook handler to receive incoming cross-region invalidation requests.
 * Compatible with Express, Fastify, Next.js route handlers, or Node's `http.createServer`.
 */
export function createCrossRegionWebhookHandler(
  cache: { receiveCrossRegionInvalidation(event: CrossRegionInvalidationEvent): Promise<boolean> | boolean },
  options: { authSecret?: string } = {},
) {
  return async function handleCrossRegionWebhook(req: WebhookRequestLike): Promise<WebhookResponseLike> {
    if (options.authSecret) {
      const authHeader = req.headers['authorization'] ?? req.headers['Authorization'];
      const customHeader = req.headers['x-tricache-auth'] ?? req.headers['X-TriCache-Auth'];

      const bearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : authHeader;

      const provided = (typeof customHeader === 'string' ? customHeader : bearer);

      if (!provided || provided !== options.authSecret) {
        return {
          status: 401,
          body: { ok: false, message: 'Unauthorized: invalid or missing auth secret' },
        };
      }
    }

    try {
      let event: CrossRegionInvalidationEvent;
      if (typeof req.body === 'string') {
        event = JSON.parse(req.body) as CrossRegionInvalidationEvent;
      } else if (req.body && typeof req.body === 'object') {
        event = req.body as CrossRegionInvalidationEvent;
      } else {
        return {
          status: 400,
          body: { ok: false, message: 'Invalid payload: body must be JSON object' },
        };
      }

      const accepted = await cache.receiveCrossRegionInvalidation(event);
      return {
        status: 200,
        body: { ok: true, message: accepted ? 'Invalidation applied' : 'Invalidation ignored (deduplicated or self)' },
      };
    } catch (err) {
      return {
        status: 400,
        body: { ok: false, message: (err as Error).message },
      };
    }
  };
}
