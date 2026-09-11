import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import TriCacheHandler, {
  TriCacheISRHandler,
  createNextCacheHandler,
} from '../src/next';

function makeStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const uint8 = encoder.encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(uint8);
      controller.close();
    },
  });
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = Buffer.concat(chunks);
  return total.toString('utf8');
}

describe('Next.js 16 Modern App Router CacheHandler (TriCacheHandler)', () => {
  let handler: TriCacheHandler;

  beforeEach(() => {
    handler = new TriCacheHandler({
      namespace: `test-next-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      disableRedis: true,
      disableDisk: true,
    });
  });

  it('stores and retrieves plain JSON / object entries', async () => {
    const payload = { user: 'Alice', posts: [1, 2, 3] };
    await handler.set(
      'page:home',
      Promise.resolve({
        value: payload,
        tags: ['home', 'users'],
        ttl: 60,
      }),
      { tags: ['home'] },
    );

    const hit = await handler.get('page:home');
    expect(hit).not.toBeUndefined();
    expect(hit?.value).toEqual(payload);
    expect(hit?.tags).toContain('home');
    expect(hit?.tags).toContain('users');
  });

  it('drains incoming ReadableStream on set() and creates a fresh unlocked stream on get()', async () => {
    const text = '<html><body>Hello RSC Stream</body></html>';
    const stream = makeStream(text);

    await handler.set(
      'rsc:stream-key',
      Promise.resolve({
        value: stream,
        tags: ['rsc'],
      }),
    );

    // First read from cache
    const hit1 = await handler.get('rsc:stream-key');
    expect(hit1).not.toBeUndefined();
    expect(typeof (hit1!.value as any).getReader).toBe('function');
    const readText1 = await readStream(hit1!.value as ReadableStream<Uint8Array>);
    expect(readText1).toBe(text);

    // Second independent read from cache — must return a brand new, unlocked stream
    const hit2 = await handler.get('rsc:stream-key');
    expect(hit2).not.toBeUndefined();
    expect(typeof (hit2!.value as any).getReader).toBe('function');
    const readText2 = await readStream(hit2!.value as ReadableStream<Uint8Array>);
    expect(readText2).toBe(text);
  });

  it('invalidates tagged entries via updateTags()', async () => {
    await handler.set(
      'card:1',
      Promise.resolve({ value: { id: 1 }, tags: ['cards'] }),
    );
    await handler.set(
      'card:2',
      Promise.resolve({ value: { id: 2 }, tags: ['cards'] }),
    );
    await handler.set(
      'post:1',
      Promise.resolve({ value: { id: 101 }, tags: ['posts'] }),
    );

    expect(await handler.get('card:1')).not.toBeUndefined();
    expect(await handler.get('card:2')).not.toBeUndefined();
    expect(await handler.get('post:1')).not.toBeUndefined();

    // Invalidate 'cards'
    await handler.updateTags(['cards']);

    expect(await handler.get('card:1')).toBeUndefined();
    expect(await handler.get('card:2')).toBeUndefined();
    expect(await handler.get('post:1')).not.toBeUndefined();
  });

  it('evaluates softTags at read time against generational tag versions', async () => {
    await handler.set(
      'layout:blog',
      Promise.resolve({ value: 'blog layout' }),
      { softTags: ['_N_T_/blog'] },
    );

    // Initial read with matching softTag -> hit
    const hit1 = await handler.get('layout:blog', { softTags: ['_N_T_/blog'] });
    expect(hit1?.value).toBe('blog layout');

    // Invalidate soft tag
    await handler.updateTags(['_N_T_/blog']);

    // Subsequent read with invalidated softTag -> miss
    const hit2 = await handler.get('layout:blog', { softTags: ['_N_T_/blog'] });
    expect(hit2).toBeUndefined();
  });

  it('skips caching when revalidate is 0 and caches long-term when revalidate is false', async () => {
    // revalidate: 0 -> dynamic, not cached
    await handler.set(
      'dyn:key',
      Promise.resolve({ value: 'dynamic' }),
      { revalidate: 0 },
    );
    expect(await handler.get('dyn:key')).toBeUndefined();

    // revalidate: false -> static indefinite (1 year)
    await handler.set(
      'static:key',
      Promise.resolve({ value: 'static' }),
      { revalidate: false },
    );
    const hitStatic = await handler.get('static:key');
    expect(hitStatic?.value).toBe('static');
    expect(hitStatic?.ttl).toBe(31_536_000);
  });

  it('catches mid-flight stream errors on set() without throwing or caching partial data', async () => {
    const errorStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial chunk'));
        controller.error(new Error('Connection aborted by client'));
      },
    });

    await expect(
      handler.set(
        'stream:err',
        Promise.resolve({ value: errorStream }),
      ),
    ).resolves.not.toThrow();

    expect(await handler.get('stream:err')).toBeUndefined();
  });

  it('correctly handles multi-chunk asynchronous RSC streams with delayed Suspense boundaries', async () => {
    function createAsyncRSCStream(): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      const chunks = [
        '<!-- $ --><div>Header</div><!-- /$ -->',
        '<!-- $? --><template id="B:1"></template><!-- /$ -->',
        '<div hidden id="S:1"><div>Async Suspense Content (resolved)</div></div>',
      ];

      return new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const chunk of chunks) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
    }

    const asyncStream = createAsyncRSCStream();

    await handler.set(
      'rsc:async-suspense',
      Promise.resolve({
        value: asyncStream,
        tags: ['page', 'suspense'],
        ttl: 300,
      }),
      { tags: ['page'] },
    );

    const hit1 = await handler.get('rsc:async-suspense');
    expect(hit1).not.toBeUndefined();
    const content1 = await readStream(hit1?.value as ReadableStream<Uint8Array>);
    expect(content1).toBe(
      '<!-- $ --><div>Header</div><!-- /$ -->' +
      '<!-- $? --><template id="B:1"></template><!-- /$ -->' +
      '<div hidden id="S:1"><div>Async Suspense Content (resolved)</div></div>',
    );

    const hit2 = await handler.get('rsc:async-suspense');
    expect(hit2).not.toBeUndefined();
    const content2 = await readStream(hit2?.value as ReadableStream<Uint8Array>);
    expect(content2).toBe(content1);
  });

  it('propagates Next.js 16 updateTags across instances via backplane message simulation', async () => {
    const ns = `test-e2e-${Date.now()}`;
    const instanceA = new TriCacheHandler({ namespace: ns, tagStrategy: 'generational', disableRedis: true, disableDisk: true });
    const instanceB = new TriCacheHandler({ namespace: ns, tagStrategy: 'generational', disableRedis: true, disableDisk: true });

    // Instance B caches feed in L1
    await instanceB.set('feed:user1', Promise.resolve({ value: 'feed-data-v1', tags: ['feed'] }));
    expect(await instanceB.get('feed:user1')).not.toBeUndefined();

    // Instance A updates tags
    await instanceA.updateTags(['feed']);

    // Simulate backplane message arriving at Instance B
    (instanceB as any).cache._handleBackplaneMessage(JSON.stringify({
      op: 'tag_incr',
      key: 'feed',
      src: (instanceA as any).cache.instanceId,
      tagVersion: 1,
    }));

    // Instance B should now see cache miss
    const hitAfter = await instanceB.get('feed:user1');
    expect(hitAfter).toBeUndefined();
  });

  it('refreshTags() operates fail-soft without throwing', async () => {
    await expect(handler.refreshTags()).resolves.not.toThrow();
  });

  it('getExpiration() returns 0', async () => {
    const exp = await handler.getExpiration(['some-tag']);
    expect(exp).toBe(0);
  });
});

describe('Next.js 15/16 Legacy ISR CacheHandler (TriCacheISRHandler)', () => {
  let isrHandler: TriCacheISRHandler;

  beforeEach(() => {
    isrHandler = new TriCacheISRHandler({
      namespace: `test-isr-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      disableRedis: true,
      disableDisk: true,
    });
  });

  it('stores and retrieves ISR PAGE entries with requestCache caching', async () => {
    const pageVal = {
      kind: 'PAGE' as const,
      html: '<h1>ISR Page</h1>',
      pageData: { title: 'ISR Page' },
    };

    await isrHandler.set('page:about', pageVal, { tags: ['about'], revalidate: 60 });

    const hit = await isrHandler.get('page:about');
    expect(hit).not.toBeNull();
    expect(hit?.value).toEqual(pageVal);

    // Resetting request cache still hits TriCache backend
    isrHandler.resetRequestCache();
    const hit2 = await isrHandler.get('page:about');
    expect(hit2?.value).toEqual(pageVal);
  });

  it('revalidates tagged entries via revalidateTag()', async () => {
    const fetchVal = {
      kind: 'FETCH' as const,
      data: {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: 123 }),
      },
    };

    await isrHandler.set('fetch:api', fetchVal, { tags: ['api-tag'] });
    expect(await isrHandler.get('fetch:api')).not.toBeNull();

    // Next.js 16 supports cacheLife parameter
    await isrHandler.revalidateTag('api-tag', 'hours');

    expect(await isrHandler.get('fetch:api')).toBeNull();
  });
});

describe('createNextCacheHandler Factory & Build Phase Guards', () => {
  const origEnv = process.env.NEXT_PHASE;

  afterEach(() => {
    process.env.NEXT_PHASE = origEnv;
  });

  it('creates custom subclass with custom options', async () => {
    const ConfiguredHandler = createNextCacheHandler({
      namespace: 'custom-next-ns',
      disableRedis: true,
      disableDisk: true,
    });

    const instance = new ConfiguredHandler();
    await instance.set(
      'custom:key',
      Promise.resolve({ value: 'hello' }),
    );

    const hit = await instance.get('custom:key');
    expect(hit?.value).toBe('hello');
  });

  it('automatically detects NEXT_PHASE=phase-production-build and bypasses Redis', async () => {
    process.env.NEXT_PHASE = 'phase-production-build';

    const handler = new TriCacheHandler({
      namespace: 'build-test',
      // Even if redisHost is provided, build phase disables Redis connection hangs
      redisHost: '127.0.0.1',
      redisPort: 65534,
      disableDisk: true,
    });

    // Should store in memory without attempting socket connection to non-existent Redis
    await handler.set('build:key', Promise.resolve({ value: 'built' }));
    const hit = await handler.get('build:key');
    expect(hit?.value).toBe('built');
  });

  it('maps Next.js 16 cacheLife preset profiles to TTL and SWR', async () => {
    const handler = new TriCacheHandler({
      namespace: `cachelife-${Date.now()}`,
      disableRedis: true,
      disableDisk: true,
    });

    // Test 'hours' preset -> revalidate 3600s, expire 86400s
    await handler.set(
      'product:view:1',
      Promise.resolve({ value: { id: 1, title: 'Shoe' } }),
      { cacheLife: 'hours' },
    );

    const hitHours = await handler.get('product:view:1');
    expect(hitHours).not.toBeUndefined();
    expect(hitHours?.ttl).toBe(3600);

    // Test 'seconds' preset -> revalidate 1s
    await handler.set(
      'stock:price:aapl',
      Promise.resolve({ value: 180.5 }),
      { cacheLife: 'seconds' },
    );

    const hitSeconds = await handler.get('stock:price:aapl');
    expect(hitSeconds?.ttl).toBe(1);

    // Test custom inline profile object
    await handler.set(
      'custom:profile:item',
      Promise.resolve({ value: 'custom-data' }),
      { cacheLife: { revalidate: 120, expire: 600 } },
    );

    const hitCustom = await handler.get('custom:profile:item');
    expect(hitCustom?.ttl).toBe(120);
  });
});
