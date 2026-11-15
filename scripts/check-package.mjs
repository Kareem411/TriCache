#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const entries = Object.keys(manifest.exports).map(key => key === '.' ? manifest.name : `${manifest.name}${key.slice(1)}`);
for (const conditions of Object.values(manifest.exports)) {
  for (const format of ['import', 'require']) {
    const files = conditions[format];
    assert.equal(typeof files, 'object', `Missing conditional ${format} declarations`);
    for (const file of [files.types, files.default]) assert.ok(existsSync(path.join(root, file)), `Missing package file ${file}; run pnpm build first`);
  }
}

const approvedTemp = process.platform === 'win32' && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
const temp = mkdtempSync(path.join(existsSync(approvedTemp) ? approvedTemp : os.tmpdir(), 'tricache-consumer-'));
const link = path.join(temp, 'node_modules', manifest.name);
try {
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ type: 'module' }));
  const imports = entries.map((entry, index) => `import * as entry${index} from ${JSON.stringify(entry)};\nvoid entry${index};`).join('\n');
  writeFileSync(path.join(temp, 'consumer.mts'), imports);
  writeFileSync(path.join(temp, 'consumer.cts'), imports);
  writeFileSync(path.join(temp, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'Node16', moduleResolution: 'Node16', strict: true, noEmit: true,
      skipLibCheck: false, types: ['node'], typeRoots: [path.join(root, 'node_modules', '@types')], ignoreDeprecations: '6.0' },
    files: ['consumer.mts', 'consumer.cts'],
  }));
  const check = spawnSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(temp, 'tsconfig.json')], { cwd: temp, encoding: 'utf8' });
  if (check.status !== 0) throw new Error(check.stdout + check.stderr);

  const code = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    for (const entry of ${JSON.stringify(entries)}) { await import(entry); require(entry); }
    const data = new Map();
    const driver = { get: async key => data.get(key) ?? null, setex: async (key, ttl, value) => { data.set(key, value); } };
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const options = { disableRedis: false, redisClient: driver, invalidationBackplane: false, disableDisk: true,
      compression: 'none', workerThreads: true, workerPoolSize: 1, workerThresholdBytes: 1, oomProtection: false,
      encryptionKey: Buffer.alloc(32, 7).toString('base64'), logger };
    for (const { CacheService } of [await import('tricache'), require('tricache')]) {
      const warm = new CacheService(options), cold = new CacheService(options);
      try {
        assert.ok(warm._workerPool?.isAvailable, 'Compiled encryption worker unavailable');
        await warm.set('worker:smoke', { payload: 'x'.repeat(140000) }, 60);
        assert.ok(data.get('worker:smoke').startsWith('enc:v1:'));
        assert.equal((await cold.get('worker:smoke', async () => { throw new Error('Unexpected origin fetch'); })).payload.length, 140000);
      } finally { await warm.destroy(); await cold.destroy(); }
    }
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: temp, encoding: 'utf8', timeout: 30000 });
  if (run.status !== 0) throw new Error(run.stdout + run.stderr);
  console.log(`Package consumers passed: ESM + CommonJS types/runtime (${entries.length} entry points), compiled worker round trip`);
} finally {
  if (existsSync(link)) {
    if (process.platform === 'win32') rmdirSync(link);
    else unlinkSync(link); // Never traverse the workspace junction during cleanup.
  }
  rmSync(temp, { recursive: true, force: true });
}
