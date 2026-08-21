import { CacheService } from '../cache-service.js';
import type { CachePriority } from '../types.js';

export interface CacheableOptions {
  /**
   * Static key string or dynamic key generator function.
   * Example: (id: string) => `user:${id}`
   */
  key?: string | ((...args: any[]) => string);
  /** TTL in seconds (or milliseconds if specified / detected). Default: 300 s. */
  ttl?: number;
  /** Explicit time unit for the ttl option. Default: 'seconds'. */
  ttlUnit?: 'seconds' | 'milliseconds';
  /** Stale-While-Revalidate grace period in seconds. */
  swr?: number;
  /** Semantic tags for invalidation. */
  tags?: string[] | ((...args: any[]) => string[]);
  /** Dependency cascade patterns. */
  dependsOn?: string[] | ((...args: any[]) => string[]);
  /** Cache eviction priority. */
  priority?: CachePriority;
  /** 0–1 fraction of TTL elapsed for background recompute. */
  refreshAhead?: number;
  /** XFetch probabilistic early expiration factor (0.5–2.0). */
  xfetchBeta?: number;
  /** Condition predicate to determine whether caching should occur. */
  condition?: (...args: any[]) => boolean;
}

export interface CacheEvictOptions {
  /** Key or pattern to delete. */
  key?: string | ((...args: any[]) => string);
  /** Tags to invalidate. */
  tags?: string[] | ((...args: any[]) => string[]);
  /** Invalidate before method execution (default: false = after successful execution). */
  beforeInvocation?: boolean;
}

function resolveCacheInstance(ctx: any): CacheService {
  return ctx?.cacheService || ctx?.cache || ctx?.cacheStore?.cache || CacheService.create();
}

/**
 * Declarative method decorator that caches the return value of an async method.
 *
 * Automatically intercepts calls, checks TriCache (L1 -> L1.5 -> L2), and falls
 * back to executing the decorated method on cache miss with thundering-herd protection.
 *
 * @example
 * ```typescript
 * @Injectable()
 * export class UserService {
 *   @Cacheable({ key: (id) => `user:${id}`, ttl: 300, tags: ['users'] })
 *   async findById(id: string) {
 *     return this.db.find(id);
 *   }
 * }
 * ```
 */
export function Cacheable(options: CacheableOptions = {}): MethodDecorator {
  return function (
    target: any,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<any>,
  ) {
    const originalMethod = descriptor.value;
    const methodName = String(propertyKey);
    const className = target?.constructor?.name || 'Service';

    descriptor.value = async function (...args: any[]) {
      if (options.condition && !options.condition(...args)) {
        return originalMethod.apply(this, args);
      }

      const cache = resolveCacheInstance(this);
      const key = typeof options.key === 'function'
        ? options.key(...args)
        : (typeof options.key === 'string' ? options.key : `${className}:${methodName}:${JSON.stringify(args)}`);

      let ttlSeconds = options.ttl ?? 300;
      const rawTtl = options.ttl;
      if (typeof rawTtl === 'number') {
        if (options.ttlUnit === 'milliseconds' || (rawTtl >= 1000 && rawTtl % 1000 === 0 && options.ttlUnit !== 'seconds')) {
          ttlSeconds = Math.round(rawTtl / 1000);
        }
      }

      const tags = typeof options.tags === 'function' ? options.tags(...args) : options.tags;
      const dependsOn = typeof options.dependsOn === 'function' ? options.dependsOn(...args) : options.dependsOn;

      return cache.wrap(
        key,
        () => originalMethod.apply(this, args),
        {
          ttl: ttlSeconds,
          swr: options.swr,
          tags,
          dependsOn,
          priority: options.priority,
          refreshAhead: options.refreshAhead,
          xfetchBeta: options.xfetchBeta,
        },
      );
    };

    return descriptor;
  };
}

/**
 * Declarative method decorator that invalidates cache keys or tags upon method execution.
 *
 * @example
 * ```typescript
 * @Injectable()
 * export class UserService {
 *   @CacheEvict({ tags: ['users'] })
 *   async update(id: string, dto: UpdateUserDto) {
 *     return this.db.update(id, dto);
 *   }
 * }
 * ```
 */
export function CacheEvict(options: CacheEvictOptions = {}): MethodDecorator {
  return function (
    _target: any,
    _propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<any>,
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const cache = resolveCacheInstance(this);

      const performEviction = async () => {
        if (options.key) {
          const k = typeof options.key === 'function' ? options.key(...args) : options.key;
          await cache.delete(k);
        }
        if (options.tags) {
          const t = typeof options.tags === 'function' ? options.tags(...args) : options.tags;
          await cache.invalidateTags(t);
        }
      };

      if (options.beforeInvocation) {
        await performEviction();
      }

      const result = await originalMethod.apply(this, args);

      if (!options.beforeInvocation) {
        await performEviction();
      }

      return result;
    };

    return descriptor;
  };
}
