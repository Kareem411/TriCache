/**
 * Regression tests for the DiskTier encryption-mode bug.
 *
 * Before the fix, DiskTier hardcoded AES-256-GCM and pulled the raw key bytes
 * off CacheEncryption. Any non-default encryptionMode (aes-128-gcm, aes-128-ctr,
 * xor) produced a key of the wrong length → createCipheriv() threw → the error
 * was caught and logged at DEBUG level → save() silently returned → the entire
 * disk tier became a permanent no-op for anyone following the README's advice
 * to use aes-128-gcm for the performance win.
 *
 * These tests drive DiskTier directly with a real CacheEncryption instance in
 * each mode and assert a save→load round-trip actually works (previously it did
 * not — load() returned null because nothing was ever written).
 */
import { describe, it, expect } from 'vitest';
import { DiskTier } from '../src/disk-tier';
import { CacheEncryption, type EncryptionMode } from '../src/encryption';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';

const NOOP_LOGGER = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
} as const;

// Best-effort recursive delete — on Windows a freshly-written cache file can
// retain a brief handle, so retrying avoids EPERM masking real test results.
function cleanup(dir: string): void {
  for (let i = 0; i < 5; i++) {
    try { cleanup(dir); return; }
    catch { /* retry */ }
  }
}

function keyFor(mode: EncryptionMode): string {
  // 32 bytes for aes-256, 16 for the aes-128 variants, 32 for xor (any >= 1).
  const len = mode === 'aes-256-gcm' ? 32 : 16;
  return Buffer.alloc(len, 7).toString('base64');
}

function makeDiskTier(mode: EncryptionMode): { tier: DiskTier; dir: string } {
  const dir = join(tmpdir(), `tricache-diskenc-${mode}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const enc = new CacheEncryption(keyFor(mode), NOOP_LOGGER as any, mode);
  const tier = new DiskTier({
    dir,
    maxBytes: 10 * 1024 * 1024,
    entryMaxBytes: 1024 * 1024,
    forbiddenPrefixes: [],
    encryption: enc.isEnabled ? enc : null,
    logger: NOOP_LOGGER as any,
  });
  return { tier, dir };
}

async function roundTrip(tier: DiskTier, key: string, value: unknown): Promise<unknown> {
  await tier.save(key, {
    value: Buffer.from(JSON.stringify(value)),
    isCompressed: false,
    expiresAt: Date.now() + 60_000,
    size: 100,
    hits: 1,
    lastAccess: Date.now(),
    priority: 2,
  } as any);
  const loaded = tier.load(key);
  if (!loaded) return undefined;
  return JSON.parse((loaded as any).value.toString('utf8'));
}

describe('DiskTier encryption mode support (was: hardcoded aes-256-gcm, silent no-op on other modes)', () => {
  for (const mode of ['aes-256-gcm', 'aes-128-gcm', 'aes-128-ctr', 'xor'] as EncryptionMode[]) {
    it(`save→load round-trips under ${mode}`, async () => {
      const { tier, dir } = makeDiskTier(mode);
      try {
        const got = await roundTrip(tier, 'user:42', { name: 'Ada', n: 42 });
        expect(got).toEqual({ name: 'Ada', n: 42 });
      } finally {
        cleanup(dir);
      }
    });
  }

  it('aes-128-gcm (the README-recommended perf mode) actually spills to disk, not a silent no-op', async () => {
    const { tier, dir } = makeDiskTier('aes-128-gcm');
    try {
      // Before the fix, save() threw (wrong key length) + debug-logged + returned;
      // load() then returned null because nothing was ever written. With the fix,
      // the value round-trips through the disk tier.
      const got = await roundTrip(tier, 'k1', { ok: true });
      expect(got).toEqual({ ok: true });
      // Note: DiskTier deletes the file on read (promote-to-L1 semantics), so a
      // second load returns null by design — that's why we only assert the round-trip.
    } finally {
      cleanup(dir);
    }
  });

  it('unencrypted (no encryption instance) still round-trips', async () => {
    const dir = join(tmpdir(), `tricache-diskenc-none-${Date.now()}`);
    const tier = new DiskTier({
      dir, maxBytes: 10 * 1024 * 1024, entryMaxBytes: 1024 * 1024,
      forbiddenPrefixes: [], encryption: null, logger: NOOP_LOGGER as any,
    });
    try {
      const got = await roundTrip(tier, 'plain', { x: 1 });
      expect(got).toEqual({ x: 1 });
    } finally {
      cleanup(dir);
    }
  });
});
