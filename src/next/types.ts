import type { CacheOptions } from '../types';

/**
 * Next.js 16 modern CacheHandler value shape for `"use cache"` components.
 */
export interface CacheHandlerValue {
  /**
   * Cached value — either a ReadableStream (for RSC payloads), or a serializable JS object / string.
   */
  value: unknown;
  /**
   * Tags associated with this cache entry at write time.
   */
  tags?: string[];
  /**
   * Stored timestamp (ms).
   */
  timestamp?: number;
  /**
   * Remaining / configured TTL (seconds).
   */
  ttl?: number;
}

/**
 * Stored representation in TriCache for Next.js CacheHandler entries.
 */
export interface StoredNextCacheEntry {
  /** Serialized payload or binary buffer (for streams) */
  data: unknown;
  /** Indicates whether the original value was a ReadableStream */
  isStream: boolean;
  /** Associated tags */
  tags: string[];
  /** Creation timestamp */
  timestamp: number;
  /** Configured TTL (seconds) */
  ttl: number;
  /** Captured soft tag versions at write time */
  softTagVersions?: Record<string, number>;
}

export type CacheLifePreset =
  | 'default'
  | 'seconds'
  | 'minutes'
  | 'hours'
  | 'days'
  | 'weeks'
  | 'max';

export interface CacheLifeProfile {
  stale?: number;
  revalidate?: number;
  expire?: number;
}

/**
 * Context passed to CacheHandler methods by Next.js runtime.
 */
export interface CacheHandlerContext {
  tags?: string[];
  softTags?: string[];
  revalidate?: number | false;
  cacheLife?: CacheLifePreset | CacheLifeProfile | string;
}

/**
 * Options for configuring TriCache Next.js integration.
 */
export interface NextCacheHandlerOptions extends CacheOptions {
  /**
   * Custom namespace for Next.js cache entries. Default: `'next'`
   */
  namespace?: string;
  /**
   * Explicitly force in-memory build phase mode (skips Redis socket connections).
   * Automatically inferred when `process.env.NEXT_PHASE === 'phase-production-build'`
   * or `process.env.NEXT_PHASE === 'phase-export'`.
   */
  isBuildPhase?: boolean;
}

/**
 * Legacy Next.js IncrementalCache value shape.
 */
export type IncrementalCacheValue =
  | {
      kind: 'PAGE';
      html: string;
      pageData: unknown;
      headers?: Record<string, string | string[]>;
      status?: number;
    }
  | {
      kind: 'FETCH';
      data: {
        headers: Record<string, string>;
        body: string;
        status?: number;
        url?: string;
      };
    }
  | {
      kind: 'REDIRECT';
      props: Record<string, unknown>;
    }
  | {
      kind: 'IMAGE';
      etag: string;
      buffer: Buffer;
      extension: string;
      isAppImage?: boolean;
    }
  | {
      kind: 'ROUTE';
      body: Buffer;
      status: number;
      headers: Record<string, string | string[]>;
    };

/**
 * Legacy Next.js IncrementalCache entry shape.
 */
export interface IncrementalCacheEntry {
  curRevalidate?: number | false;
  revalidateAfter?: number | false;
  isStale?: boolean;
  value: IncrementalCacheValue | null;
}
