import { performance } from 'perf_hooks';
import {
  compressBuffer,
  decompressBuffer,
  initZstd,
  type CompressionAlgorithm,
} from '../src/compression.ts';
import { CacheService } from '../src/cache-service.ts';

// ---------------------------------------------------------------------------
// Synthetic Test Payloads
// ---------------------------------------------------------------------------

function generateSmallPayload(): string {
  return JSON.stringify({
    userId: 'usr_98234710293',
    tenantId: 'org_acme_corp',
    email: 'alex.developer@acmewidgets.example.com',
    roles: ['admin', 'billing', 'developer'],
    permissions: ['read:users', 'write:users', 'read:invoices', 'manage:clusters'],
    session: {
      token: 'jwt.eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.s6bV8g8s7d8f9s7d6f5s7d6f5s7d6f',
      ip: '192.168.1.104',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0',
      createdAt: 1718000000000,
      expiresAt: 1718086400000,
    },
    metadata: {
      preferredRegion: 'us-east-1',
      locale: 'en-US',
      featureFlags: { betaUI: true, v2Checkout: false, darkTheme: true },
    },
  });
}

function generateMediumPayload(): string {
  const items = Array.from({ length: 200 }, (_, i) => ({
    id: `prod_${i + 1000}`,
    sku: `SKU-${(i * 37) % 9999}-${i}`,
    title: `High-Performance Microservice Gateway Router Module v${(i % 5) + 1}.${i % 10}`,
    description: `Enterprise-grade asynchronous edge compute router with intelligent tier-0 failover, distributed lock arbitration, and telemetry backplane support.`,
    category: ['networking', 'compute', 'edge-infrastructure'][i % 3],
    price: 199.99 + (i % 50),
    currency: 'USD',
    inventory: 50 + (i % 500),
    tags: [`tag-${i % 10}`, 'infrastructure', 'cloud-native', 'high-availability'],
    attributes: {
      cores: (i % 16) + 1,
      ramGB: [4, 8, 16, 32, 64][i % 5],
      throughputGbps: 10 + (i % 40),
      testedOn: ['us-east-1', 'eu-west-1', 'ap-southeast-1'],
    },
  }));
  return JSON.stringify({ catalog: 'enterprise-cloud-hardware', count: items.length, items });
}

function generateLargePayload(): string {
  const records = Array.from({ length: 1000 }, (_, i) => ({
    id: `log_${i + 10000}`,
    timestamp: 1718000000000 + i * 100,
    traceId: `4bf92f3577b34da6a3ce929d0e0e4736-${i}`,
    spanId: `00f067aa0ba902b7-${i % 256}`,
    service: ['api-gateway', 'auth-service', 'billing-engine', 'cache-worker', 'db-replica'][i % 5],
    level: ['INFO', 'WARN', 'DEBUG', 'ERROR'][i % 4],
    message: `HTTP POST /v1/orders/checkout execution completed with status 200. Cache tier hit: L1 RAM. Latency: ${(i % 30) + 1.2}ms`,
    http: {
      method: 'POST',
      path: `/api/v2/workspaces/${(i % 50) + 1}/deployments`,
      status: 200,
      clientIp: `10.0.${(i >> 8) & 0xff}.${i & 0xff}`,
      userAgent: 'TriCache-Agent/1.0.0 (x86_64; Node.js v22.12.0)',
      bytesSent: 4096 + (i * 17) % 8192,
    },
    context: {
      tenant: `tenant_${i % 20}`,
      user: `usr_${i % 100}`,
      retryCount: i % 3,
      flags: ['rate_limited', 'geo_routed', 'swr_refreshed'],
    },
  }));
  return JSON.stringify({ batchId: 'batch_analytics_99182', total: records.length, records });
}

// ---------------------------------------------------------------------------
// Benchmark Execution Engine
// ---------------------------------------------------------------------------

interface AlgoResult {
  algo: CompressionAlgorithm;
  origBytes: number;
  compBytes: number;
  ratioPct: number; // percentage reduced
  compOpsSec: number;
  compThroughputMBs: number;
  compLatencyUs: number;
  decompOpsSec: number;
  decompThroughputMBs: number;
  decompLatencyUs: number;
  integrityVerified: boolean;
}

function runBenchmark(
  payloadName: string,
  rawPayload: string,
  iterations: number,
  warmup: number,
): AlgoResult[] {
  const rawBuf = Buffer.from(rawPayload, 'utf8');
  const algos: CompressionAlgorithm[] = ['none', 'lz4', 'zstd', 'brotli', 'gzip'];
  const results: AlgoResult[] = [];

  for (const algo of algos) {
    // 1. Warmup
    for (let i = 0; i < warmup; i++) {
      const c = compressBuffer(rawBuf, algo);
      decompressBuffer(c, algo);
    }

    // 2. Measure Compression
    const compStart = performance.now();
    let lastComp: Buffer<any> = rawBuf;
    for (let i = 0; i < iterations; i++) {
      lastComp = compressBuffer(rawBuf, algo);
    }
    const compDurationMs = performance.now() - compStart;
    const compOpsSec = Math.round((iterations / compDurationMs) * 1000);
    const compThroughputMBs = Number(((rawBuf.length * iterations) / (1024 * 1024) / (compDurationMs / 1000)).toFixed(2));
    const compLatencyUs = Number(((compDurationMs / iterations) * 1000).toFixed(1));

    // 3. Verify Decompression Integrity
    const decompressed = decompressBuffer(lastComp, algo);
    const integrityVerified = decompressed.toString('utf8') === rawPayload;

    // 4. Measure Decompression
    const decompStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      decompressBuffer(lastComp, algo);
    }
    const decompDurationMs = performance.now() - decompStart;
    const decompOpsSec = Math.round((iterations / decompDurationMs) * 1000);
    const decompThroughputMBs = Number(((rawBuf.length * iterations) / (1024 * 1024) / (decompDurationMs / 1000)).toFixed(2));
    const decompLatencyUs = Number(((decompDurationMs / iterations) * 1000).toFixed(1));

    const origBytes = rawBuf.length;
    const compBytes = lastComp.length;
    const ratioPct = Number((((origBytes - compBytes) / origBytes) * 100).toFixed(1));

    results.push({
      algo,
      origBytes,
      compBytes,
      ratioPct,
      compOpsSec,
      compThroughputMBs,
      compLatencyUs,
      decompOpsSec,
      decompThroughputMBs,
      decompLatencyUs,
      integrityVerified,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// CacheService End-to-End Benchmark
// ---------------------------------------------------------------------------

async function runCacheServiceBenchmark(rawPayload: string, iterations = 2000) {
  const algos: ('none' | 'lz4' | 'zstd' | 'brotli' | 'gzip')[] = ['none', 'lz4', 'zstd', 'brotli', 'gzip'];
  const testObj = JSON.parse(rawPayload);
  const cacheResults: Record<
    string,
    {
      setOpsSec: number;
      getOpsSec: number;
      serializeOpsSec: number;
      deserializeOpsSec: number;
      serializedBytes: number;
    }
  > = {};

  for (const algo of algos) {
    const cache = new CacheService({
      disableDisk: true,
      disableRedis: true,
      compression: algo,
      compressionThresholdBytes: 64,
    });
    await cache.ready();

    // Warmup
    for (let i = 0; i < 50; i++) {
      await cache.set(`warm:${i}`, testObj, 60);
      await cache.getIfFresh(`warm:${i}`);
    }

    // Measure SET
    const setStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      await cache.set(`bench:key:${i}`, testObj, 300);
    }
    const setDurationMs = performance.now() - setStart;
    const setOpsSec = Math.round((iterations / setDurationMs) * 1000);

    // Measure GET
    const getStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      await cache.getIfFresh(`bench:key:${i}`);
    }
    const getDurationMs = performance.now() - getStart;
    const getOpsSec = Math.round((iterations / getDurationMs) * 1000);

    // Measure end-to-end CacheService serialization + compression
    const serializeStart = performance.now();
    let serialized = '';
    for (let i = 0; i < iterations; i++) {
      serialized = await (cache as any)._serializeAndEncrypt(rawPayload);
    }
    const serializeDurationMs = performance.now() - serializeStart;
    const serializeOpsSec = Math.round((iterations / serializeDurationMs) * 1000);

    const deserializeStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      await (cache as any)._decryptAndDeserialize(serialized);
    }
    const deserializeDurationMs = performance.now() - deserializeStart;
    const deserializeOpsSec = Math.round((iterations / deserializeDurationMs) * 1000);

    cacheResults[algo] = {
      setOpsSec,
      getOpsSec,
      serializeOpsSec,
      deserializeOpsSec,
      serializedBytes: Buffer.byteLength(serialized, 'utf8'),
    };

    await cache.destroy();
  }

  return cacheResults;
}

// ---------------------------------------------------------------------------
// Main Runner & Formatter
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(90));
  console.log('       TRICACHE COMPRESSION ENGINE BENCHMARK & COMPARATIVE EVALUATION');
  console.log('='.repeat(90));
  console.log(`Node.js: ${process.version} | Platform: ${process.platform} (${process.arch})`);
  console.log('Initializing WebAssembly Zstandard runtime...');
  await initZstd();
  console.log('Zstandard WASM initialized successfully.\n');

  const testSuites = [
    {
      name: 'Small Payload (Session / Auth Claim)',
      data: generateSmallPayload(),
      iterations: 10_000,
      warmup: 500,
    },
    {
      name: 'Medium Payload (Catalog / Product List)',
      data: generateMediumPayload(),
      iterations: 2_000,
      warmup: 100,
    },
    {
      name: 'Large Payload (Analytics Log / Large Dataset)',
      data: generateLargePayload(),
      iterations: 500,
      warmup: 25,
    },
  ];

  for (const suite of testSuites) {
    const rawLen = Buffer.byteLength(suite.data, 'utf8');
    const kb = (rawLen / 1024).toFixed(1);
    console.log(`\n>>> TEST SUITE: ${suite.name} [${rawLen} bytes / ~${kb} KB] (${suite.iterations.toLocaleString()} iterations)`);
    console.log('-'.repeat(90));

    const results = runBenchmark(suite.name, suite.data, suite.iterations, suite.warmup);

    console.log(
      'Algorithm'.padEnd(10) +
      'Comp Size'.padStart(12) +
      'Reduction'.padStart(11) +
      'Comp Speed'.padStart(14) +
      'Comp Latency'.padStart(15) +
      'Decomp Speed'.padStart(15) +
      'Decomp Latency'.padStart(16) +
      'Integrity'.padStart(11)
    );
    console.log('-'.repeat(104));

    for (const r of results) {
      const sizeStr = `${r.compBytes.toLocaleString()} B`;
      const ratioStr = r.algo === 'none' ? '0.0%' : `-${r.ratioPct}%`;
      const compSpeedStr = `${r.compOpsSec.toLocaleString()} ops/s`;
      const compLatStr = `${r.compLatencyUs} µs`;
      const decompSpeedStr = `${r.decompOpsSec.toLocaleString()} ops/s`;
      const decompLatStr = `${r.decompLatencyUs} µs`;
      const validStr = r.integrityVerified ? 'PASS [OK]' : 'FAIL [X]';

      console.log(
        r.algo.toUpperCase().padEnd(10) +
        sizeStr.padStart(12) +
        ratioStr.padStart(11) +
        compSpeedStr.padStart(14) +
        compLatStr.padStart(15) +
        decompSpeedStr.padStart(15) +
        decompLatStr.padStart(16) +
        validStr.padStart(11)
      );
    }
  }

  console.log('\n\n' + '='.repeat(90));
  console.log('       END-TO-END CACHESERVICE INTEGRATION BENCHMARK (Medium Payload ~52 KB)');
  console.log('='.repeat(90));
  console.log('Measuring CacheService set() and get() throughput with direct compression layer...');

  const mediumData = generateMediumPayload();
  const cacheResults = await runCacheServiceBenchmark(mediumData, 1000);

  console.log(
    'Algorithm'.padEnd(12) +
    'set() ops/sec'.padStart(16) +
    'get() ops/sec'.padStart(16) +
    'Serialize+Cmp'.padStart(18) +
    'Deserialize+Decmp'.padStart(20) +
    'Payload Size'.padStart(15)
  );
  console.log('-'.repeat(97));

  for (const [algo, data] of Object.entries(cacheResults)) {
    console.log(
      algo.toUpperCase().padEnd(12) +
      `${data.setOpsSec.toLocaleString()} ops/s`.padStart(16) +
      `${data.getOpsSec.toLocaleString()} ops/s`.padStart(16) +
      `${data.serializeOpsSec.toLocaleString()} ops/s`.padStart(18) +
      `${data.deserializeOpsSec.toLocaleString()} ops/s`.padStart(20) +
      `${data.serializedBytes.toLocaleString()} B`.padStart(15)
    );
  }

  console.log('\n' + '='.repeat(90));
  console.log('BENCHMARK COMPLETE');
  console.log('='.repeat(90));
}

main().catch(console.error);
