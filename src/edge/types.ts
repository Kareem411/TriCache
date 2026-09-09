import type { ICacheTracer } from '../types';

/**
 * Pluggable asynchronous key-value storage adapter for Edge runtimes (L2 tier).
 */
export interface IEdgeRemoteStorage {
  /** Fetch a stored value by key. Returns null on miss. */
  get(key: string): Promise<string | null>;

  /** Store a value with an optional TTL in seconds. */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;

  /** Delete a key. */
  delete(key: string): Promise<void>;

  /** Optional batch read. Returns array matching keys order (null for missing). */
  mget?(keys: string[]): Promise<(string | null)[]>;

  /** Optional batch write. */
  mset?(entries: Record<string, string>, ttlSeconds?: number): Promise<void>;

  /** Optional clear by prefix or all keys. */
  clear?(prefix?: string): Promise<void>;

  /** Optional atomic or monotonic tag version increment for generational tag invalidation. */
  incrementTagVersion?(tag: string): Promise<number>;

  /** Optional tag version retrieval. */
  getTagVersion?(tag: string): Promise<number>;

  /** Optional batch tag version retrieval. */
  batchGetTagVersions?(tags: string[]): Promise<Record<string, number>>;
}

/**
 * Options for cache read operations in Edge environments.
 */
export interface EdgeGetOptions {
  /** Cache tags associated with this entry for bulk invalidation. */
  tags?: string[];

  /**
   * Stale-While-Revalidate window in seconds.
   * If entry is older than TTL but within (TTL + swr), stale data is returned
   * immediately while a background fetcher runs to refresh the cache.
   */
  swr?: number;

  /**
   * Execution context provided by Edge platforms (Cloudflare Workers, Vercel Edge).
   * Critical: In edge isolates, background tasks spawned without ctx.waitUntil()
   * are terminated as soon as the HTTP response terminates.
   */
  ctx?: {
    waitUntil: (promise: Promise<unknown>) => void;
  };
}

/**
 * Options for configuring the EdgeCacheService.
 */
export interface EdgeCacheOptions {
  /**
   * Maximum number of keys held in L1 in-memory LRU. Default: 10,000.
   */
  maxKeys?: number;

  /**
   * Approximate maximum memory in bytes for L1 cache (calculated via UTF-8 length * 2).
   * Default: 32 MB (33,554,432 bytes).
   */
  maxBytes?: number;

  /** Default TTL in seconds when not specified on get/set. Default: 300 (5 min). */
  defaultTtlSeconds?: number;

  /** Optional remote L2 storage adapter (Upstash, Cloudflare KV, Cloudflare DO). */
  remoteStorage?: IEdgeRemoteStorage;

  /** Optional at-rest encryption configuration via Web Crypto (AES-GCM). */
  encryption?: {
    keyBase64: string;
    prevKeyBase64?: string;
    mode?: 'aes-256-gcm' | 'aes-128-gcm';
  };

  /** Multi-tenant key namespace prefix. */
  namespace?: string;

  /** OpenTelemetry-compatible tracer for distributed tracing. */
  tracer?: ICacheTracer;
}

/**
 * Configuration for Upstash REST Redis adapter.
 */
export interface UpstashRedisOptions {
  /** Upstash REST URL (e.g. "https://us1-clean-slug-12345.upstash.io"). */
  url: string;

  /** Upstash REST bearer token. */
  token: string;

  /** Optional custom fetch implementation (defaults to globalThis.fetch). */
  fetch?: typeof globalThis.fetch;
}

/**
 * Minimal interface representing Cloudflare Workers KVNamespace binding.
 */
export interface CloudflareKVNamespace {
  get(key: string, options?: { type?: 'text' | 'json' | 'arrayBuffer' | 'stream'; cacheTtl?: number }): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
  list?(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

/**
 * Minimal interface representing Cloudflare Durable Objects storage binding (state.storage).
 */
export interface CloudflareDOStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  put<T = unknown>(entries: Record<string, T>): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  list?<T = unknown>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>>;
}
