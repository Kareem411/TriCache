/**
 * tricache — three-tier cache for Node.js
 *
 * L1 (RAM) → L1.5 (disk) → L2 (Redis/Valkey) → your fetch function
 *
 * Quick start:
 *   import { CacheService, CachePriority } from 'tricache';
 *
 *   const cache = CacheService.create({ redisHost: 'localhost' });
 *
 *   const user = await cache.get(
 *     `user:${userId}`,
 *     () => db.users.findById(userId),
 *     300,                          // 5-minute TTL
 *   );
 *
 *   await cache.delete(`user:${userId}`);
 */

export { CacheService }        from './cache-service';
export { CacheEncryption, type EncryptionMode } from './encryption';
export { SmartMemoryCache }    from './smart-memory-cache';
export { DiskTier }            from './disk-tier';
export { WasmBloomFilter }     from './wasm/bloom-filter-wasm';
export { type CompressionAlgorithm } from './compression';
export { CacheCodec, defaultCodec, type CacheCodecOptions } from './codec';
export {
  createHttpSnapshotAdapter,
  createCustomSnapshotAdapter,
  createMemorySnapshotAdapter,
  type IRemoteSnapshotAdapter,
  type RemoteSnapshotOptions,
  type HttpSnapshotAdapterOptions,
} from './remote-snapshot';
export {
  createHttpMeshRelay,
  createCustomCrossRegionRelay,
  createMemoryCrossRegionRelay,
  createCrossRegionWebhookHandler,
  type CrossRegionInvalidationEvent,
  type ICrossRegionRelay,
  type CrossRegionRelayOptions,
  type HttpMeshRelayOptions,
  type WebhookRequestLike,
  type WebhookResponseLike,
} from './cross-region';

export {
  CachePriority,
  consoleLogger,
  type ILogger,
  type CacheOptions,
  type CacheMetrics,
  type CategoryLimit,
  type SmartCacheEntry,
  type DiskCacheEntry,
  type CacheHit,
  type EvictionReason,
  type CachePingResult,
  type ICacheTracer,
  type ICacheSpan,
  type ICacheSpanLink,
  type WrapOptions,
  type LockOptions,
  type ICacheCounter,
  type ICacheObservableGauge,
  type ICacheBatchObservableCallback,
  type ICacheMeter,
} from './types';

export {
  parseTraceParent,
  formatTraceParent,
  type ParsedTraceParent,
} from './utils/tracing';

export {
  tricacheDashboard,
  createNextDashboardHandlers,
  startDashboardServer,
  handleDashboardRequest,
  type DashboardOptions,
  type StandaloneDashboardOptions,
  type DashboardPeerInstance,
  type DashboardActionEvent,
} from './dashboard/index';
