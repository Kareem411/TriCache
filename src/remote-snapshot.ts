/**
 * tricache — Remote Blob Storage Cold-Start Hydration
 *
 * Enables stateless containers (Kubernetes, AWS ECS/Fargate, Google Cloud Run, Fly.io)
 * to persist and hydrate L1 cache snapshots from remote object storage (S3, GCS, R2, Azure, MinIO, or HTTP).
 */

export interface IRemoteSnapshotAdapter {
  /**
   * Read the latest snapshot blob from remote storage.
   * Returns null if no snapshot exists yet (e.g. 404 Not Found / first deploy).
   */
  get(): Promise<Buffer | Uint8Array | null>;

  /**
   * Write the snapshot blob to remote storage.
   */
  put(data: Buffer): Promise<void>;
}

export interface RemoteSnapshotOptions {
  /**
   * Remote storage adapter implementation.
   */
  adapter: IRemoteSnapshotAdapter;

  /**
   * Maximum age in milliseconds of a remote snapshot before it is rejected as stale.
   * Default: 2 hours (7,200,000 ms).
   */
  maxAgeMs?: number;

  /**
   * Whether to trigger an asynchronous remote snapshot upload during graceful shutdown (SIGTERM/SIGINT).
   * Ensure your container orchestration allows sufficient termination grace period (e.g. >= 10s).
   * Default: true.
   */
  saveOnShutdown?: boolean;

  /**
   * Optional periodic background upload interval in milliseconds.
   * Ensures remote snapshots stay fresh even in the event of ungraceful container termination (SIGKILL / OOM / spot eviction).
   * Default: undefined (disabled).
   */
  intervalMs?: number;
}

export interface HttpSnapshotAdapterOptions {
  /**
   * URL to fetch the snapshot from (e.g. S3 presigned GET URL or internal blob service).
   */
  getUrl: string;

  /**
   * URL to upload the snapshot to via HTTP PUT. If omitted, defaults to `getUrl`.
   */
  putUrl?: string;

  /**
   * Optional HTTP headers (e.g. Authorization or custom metadata).
   */
  headers?: Record<string, string>;
}

/**
 * Creates an HTTP-based remote snapshot adapter using standard global `fetch()`.
 * Ideal for S3/R2 presigned URLs, internal storage gateways, or serverless webhooks.
 */
export function createHttpSnapshotAdapter(options: HttpSnapshotAdapterOptions): IRemoteSnapshotAdapter {
  const getUrl = options.getUrl;
  const putUrl = options.putUrl ?? getUrl;
  const headers = options.headers ?? {};

  return {
    async get(): Promise<Buffer | null> {
      const res = await fetch(getUrl, {
        method: 'GET',
        headers,
      });

      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`HttpSnapshotAdapter: GET failed with status ${res.status} ${res.statusText}`);
      }

      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    },

    async put(data: Buffer): Promise<void> {
      const res = await fetch(putUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          ...headers,
        },
        body: data as unknown as BodyInit,
      });

      if (!res.ok) {
        throw new Error(`HttpSnapshotAdapter: PUT failed with status ${res.status} ${res.statusText}`);
      }
    },
  };
}

/**
 * Helper to define and type-check a custom remote snapshot adapter (e.g. AWS SDK v3, GCS, Azure Blob).
 */
export function createCustomSnapshotAdapter(adapter: IRemoteSnapshotAdapter): IRemoteSnapshotAdapter {
  return adapter;
}

/**
 * In-memory snapshot adapter designed for unit testing, CI pipelines, and ephemeral mock environments.
 */
export function createMemorySnapshotAdapter(): IRemoteSnapshotAdapter & {
  getBuffer(): Buffer | null;
  clear(): void;
} {
  let stored: Buffer | null = null;

  return {
    async get(): Promise<Buffer | null> {
      return stored ? Buffer.from(stored) : null;
    },
    async put(data: Buffer): Promise<void> {
      stored = Buffer.from(data);
    },
    getBuffer(): Buffer | null {
      return stored;
    },
    clear(): void {
      stored = null;
    },
  };
}
