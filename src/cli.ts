/**
 * TriCache CLI — Developer & Troubleshooting Inspector
 *
 * Usage:
 *   npx tricache inspect [--redis redis://localhost:6379] [--namespace <ns>]
 *   npx tricache ping [--redis redis://localhost:6379]
 *   npx tricache clear [--redis redis://localhost:6379] [--namespace <ns>] [--prefix <prefix>]
 */

import { parseArgs } from 'node:util';
import { CacheService } from './cache-service.js';

export async function runCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const options = {
    redis: { type: 'string' as const, short: 'r' },
    port: { type: 'string' as const, short: 'p' },
    namespace: { type: 'string' as const, short: 'n' },
    prefix: { type: 'string' as const },
    disk: { type: 'string' as const, short: 'd' },
    help: { type: 'boolean' as const, short: 'h' },
    version: { type: 'boolean' as const, short: 'v' },
  };

  let parsed;
  try {
    parsed = parseArgs({
      args,
      options,
      allowPositionals: true,
      strict: false,
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}\n`);
    printHelp();
    process.exit(1);
  }

  const { values, positionals } = parsed;
  const command = positionals[0] || 'inspect';

  if (values.help || command === 'help') {
    printHelp();
    return;
  }

  if (values.version || command === 'version') {
    console.log('tricache v0.7.1');
    return;
  }

  const redisStr = typeof values.redis === 'string' ? values.redis : undefined;
  const redisHost = redisStr ? redisStr.replace(/^redis:\/\//, '').split(':')[0] : undefined;
  const redisPort = typeof values.port === 'string'
    ? parseInt(values.port, 10)
    : (redisStr && redisStr.includes(':') ? parseInt(redisStr.split(':')[1], 10) : 6379);
  const namespace = typeof values.namespace === 'string' ? values.namespace : undefined;
  const diskCacheDir = typeof values.disk === 'string' ? values.disk : undefined;

  const cache = new CacheService({
    redisHost,
    redisPort,
    namespace,
    diskCacheDir,
    disableRedis: !redisHost,
  });

  try {
    if (command === 'inspect') {
      const ping = await cache.ping();
      const metrics = cache.metrics();
      const stats = cache.stats();
      const hot = cache.hotKeys(5);

      const divPct = (n: number) => `${(n * 100).toFixed(1)}%`;
      const l1MaxKB = Math.round((cache.options.l1MaxBytes ?? 200 * 1024 * 1024) / 1024);

      console.log(`
┌──────────────────────────────────────────────────────────────┐
│  TriCache Engine Dashboard (Namespace: ${namespace || '(default)'})
├──────────────────────────────────────────────────────────────┤
│  Tiers Active:    L1 (RAM) → L1.5 (NVMe Disk) → L2 (${redisHost ? 'Redis' : 'Disabled'})
│  Latencies:       L1: ${ping.l1}ms | Disk: ${ping.disk}ms | L2: ${ping.l2 !== null ? `${ping.l2}ms` : 'N/A'}
│  L1 Entries:      ${stats.l1.entries} (${stats.l1.sizeKB} KB / ${l1MaxKB} KB)
│  Disk Files:      ${stats.disk.files} (${stats.disk.sizeKB} KB / ${stats.disk.maxKB} KB)
├──────────────────────────────────────────────────────────────┤
│  L1 Hit Ratio:    ${divPct(metrics.gets.l1HitRate)} (${metrics.gets.l1Hits} hits)
│  L2 Hit Ratio:    ${divPct(metrics.gets.l2HitRate)} (${metrics.gets.l2Hits} hits)
│  Disk Hit Ratio:  ${divPct(metrics.gets.diskHitRate)} (${metrics.gets.diskHits} hits)
│  Stampedes Saved: ${metrics.gets.stampedePrevented} coalesced requests
├──────────────────────────────────────────────────────────────┤
│  🔥 Top Hot Keys (Count-Min Sketch):`);

      if (hot.length === 0) {
        console.log('│    (no hot keys recorded yet)');
      } else {
        hot.forEach(({ key, hits, sizeBytes }, idx) => {
          const size = sizeBytes > 1024 ? `${(sizeBytes / 1024).toFixed(1)} KB` : `${sizeBytes} B`;
          console.log(`│    ${idx + 1}. ${key.padEnd(24)} (${hits} hits, ${size})`);
        });
      }
      console.log('└──────────────────────────────────────────────────────────────┘\n');
    } else if (command === 'ping') {
      const ping = await cache.ping();
      console.log(`TriCache Ping Results:`);
      console.log(`  • L1 RAM:  ${ping.l1}ms`);
      console.log(`  • Disk:    ${ping.disk}ms`);
      console.log(`  • L2 Redis:${ping.l2 !== null ? ` ${ping.l2}ms` : ' Disabled'}`);
    } else if (command === 'clear') {
      const prefix = typeof values.prefix === 'string' ? values.prefix : undefined;
      await cache.clear(prefix);
      console.log(`Cleared cache${prefix ? ` for prefix "${prefix}"` : ' (all entries)'} in namespace "${namespace || '(default)'}".`);
    } else {
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      process.exit(1);
    }
  } finally {
    await cache.destroy();
  }
}

function printHelp(): void {
  console.log(`
TriCache CLI — Developer & Troubleshooting Tool

Usage:
  tricache <command> [options]

Commands:
  inspect    Display full dashboard including hit ratios, latencies, and hot keys (default)
  ping       Measure response latency across L1 (RAM), L1.5 (Disk), and L2 (Redis)
  clear      Flush all entries or keys matching a prefix

Options:
  -r, --redis <host|url>   Redis connection host or URL (e.g. localhost, redis://127.0.0.1:6379)
  -p, --port <port>        Redis port (default: 6379)
  -n, --namespace <ns>     Cache namespace
  --prefix <prefix>        Key prefix filter for clear command
  -d, --disk <path>        Custom disk cache directory path
  -h, --help               Show this help message
  -v, --version            Display version number
`);
}
