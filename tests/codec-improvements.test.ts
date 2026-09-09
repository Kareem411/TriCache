import { describe, it, expect, afterEach } from 'vitest';
import { CacheService } from '../src/cache-service.js';
import { CacheCodec, defaultCodec } from '../src/codec.js';
import { pack as rawPack } from 'msgpackr';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

class UserModel {
  public id: number;
  public username: string;
  public passwordHash: string;
  public internalRole: string;

  constructor(id: number, username: string, passwordHash: string, internalRole: string) {
    this.id = id;
    this.username = username;
    this.passwordHash = passwordHash;
    this.internalRole = internalRole;
  }

  /**
   * HTTP projection: strips sensitive credentials and internal role.
   */
  toJSON() {
    return {
      id: this.id,
      username: this.username,
    };
  }
}

describe('msgpackr 2.1.0 & CacheCodec Improvements', () => {
  let svc: CacheService | null = null;
  let diskDir: string | null = null;

  afterEach(async () => {
    if (svc) {
      await svc.destroy();
      svc = null;
    }
    if (diskDir) {
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
      diskDir = null;
    }
  });

  describe('Record structure deduplication (useRecords: true)', () => {
    it('produces significantly more compact binary payloads for structured object arrays', () => {
      const records = Array.from({ length: 100 }, (_, i) => ({
        id: i,
        name: `User_${i}`,
        email: `user_${i}@example.com`,
        active: i % 2 === 0,
        role: 'operator',
        department: 'Engineering',
      }));

      const rawPacked = rawPack(records); // standard MessagePack (no records)
      const recordPacked = defaultCodec.encode(records); // CacheCodec with useRecords: true

      // Verify measurable size reduction (typically ~40% to ~55% smaller)
      expect(recordPacked.length).toBeLessThan(rawPacked.length * 0.65);

      // Verify exact round-trip decoding
      const decoded = defaultCodec.decode<typeof records>(recordPacked);
      expect(decoded).toEqual(records);
    });

    it('round-trips structured arrays through CacheService with full fidelity', async () => {
      svc = new CacheService({
        disableRedis: true,
        disableDisk: true,
      });

      const records = Array.from({ length: 50 }, (_, i) => ({
        sku: `SKU-${i}`,
        inventory: i * 10,
        available: true,
        vendor: 'TriCache-Warehouse',
      }));

      await svc.set('inventory:catalog', records, 60);
      const fetched = await svc.get('inventory:catalog', async () => []);
      expect(fetched).toEqual(records);
    });
  });

  describe('Durable state serialization (serializeToJSON option - msgpackr 2.1.0)', () => {
    it('honors toJSON() by default (serializeToJSON: true)', async () => {
      const user = new UserModel(101, 'kareem', 'sha256$supersecret', 'superadmin');

      // 1. Direct codec encode/decode verifies binary format honors toJSON
      const decoded = defaultCodec.decode(defaultCodec.encode(user));
      expect(decoded).toEqual({
        id: 101,
        username: 'kareem',
      });
      expect(decoded).not.toHaveProperty('passwordHash');

      // 2. CacheService persistence across disk spill tier
      diskDir = mkdtempSync(path.join(os.tmpdir(), 'tricache-tojson-disk-'));
      svc = new CacheService({
        diskCacheDir: diskDir,
        disableRedis: true,
        l1MaxEntries: 1,
        l1MaxBytes: 100,
      });

      await svc.set('user:default', user, 60);
      await svc.set('user:evictor', { pad: 'x'.repeat(200) }, 60);
      for (let i = 0; i < 40; i++) {
        if ((svc as any).disk.stats.files > 0) break;
        await new Promise(r => setTimeout(r, 25));
      }
      const cached = await svc.get<Record<string, unknown>>('user:default', async () => ({}));
      expect(cached).toEqual({
        id: 101,
        username: 'kareem',
      });
      expect(cached).not.toHaveProperty('passwordHash');
    });

    it('preserves internal properties when serializeToJSON: false is configured', async () => {
      const rawCodec = new CacheCodec({ useToJSON: false });
      const user = new UserModel(102, 'alice', 'argon2$securehash', 'billing_admin');

      // 1. Direct codec encode/decode preserves own properties
      const decoded = rawCodec.decode(rawCodec.encode(user));
      expect(decoded).toEqual({
        id: 102,
        username: 'alice',
        passwordHash: 'argon2$securehash',
        internalRole: 'billing_admin',
      });

      // 2. CacheService configured with serializeToJSON: false preserves properties on disk restore
      diskDir = mkdtempSync(path.join(os.tmpdir(), 'tricache-raw-disk-'));
      svc = new CacheService({
        diskCacheDir: diskDir,
        disableRedis: true,
        serializeToJSON: false,
        l1MaxEntries: 1,
        l1MaxBytes: 100,
      });

      await svc.set('user:raw', user, 60);
      await svc.set('user:evictor', { pad: 'x'.repeat(200) }, 60);

      for (let i = 0; i < 40; i++) {
        if ((svc as any).disk.stats.files > 0) break;
        await new Promise(r => setTimeout(r, 25));
      }

      const rawCached = await svc.get<Record<string, unknown>>('user:raw', async () => ({}));

      expect(rawCached).toEqual({
        id: 102,
        username: 'alice',
        passwordHash: 'argon2$securehash',
        internalRole: 'billing_admin',
      });
    });
  });

  describe('Rich type preservation (moreTypes: true)', () => {
    it('round-trips Sets, TypedArrays, and Dates through CacheCodec', () => {
      const complexData = {
        tags: new Set(['fast', 'zero-json', 'high-throughput']),
        buffer: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
        created: new Date('2026-09-09T12:00:00.000Z'),
      };

      const encoded = defaultCodec.encode(complexData);
      const decoded = defaultCodec.decode<typeof complexData>(encoded);

      expect(decoded.tags).toBeInstanceOf(Set);
      expect(Array.from(decoded.tags)).toEqual(['fast', 'zero-json', 'high-throughput']);
      expect(decoded.buffer).toBeInstanceOf(Uint8Array);
      expect(Array.from(decoded.buffer)).toEqual([0xde, 0xad, 0xbe, 0xef]);
      expect(decoded.created).toBeInstanceOf(Date);
      expect(decoded.created.toISOString()).toBe('2026-09-09T12:00:00.000Z');
    });

    it('preserves rich types across disk spill tier', async () => {
      diskDir = mkdtempSync(path.join(os.tmpdir(), 'tricache-codec-disk-'));
      svc = new CacheService({
        diskCacheDir: diskDir,
        disableRedis: true,
        l1MaxEntries: 1, // force immediate spill
        l1MaxBytes: 200,
      });

      const payload = {
        categories: new Set(['database', 'in-memory']),
        score: 99.5,
      };

      await svc.set('item:rich', payload, 60);

      // Force L1 eviction to spill item:rich to disk
      await svc.set('item:evictor', { pad: 'x'.repeat(300) }, 60);

      for (let i = 0; i < 40; i++) {
        if ((svc as any).disk.stats.files > 0) break;
        await new Promise(r => setTimeout(r, 25));
      }

      const restored = await svc.get<typeof payload>('item:rich', async () => ({
        categories: new Set(),
        score: 0,
      }));

      expect(restored).not.toBeNull();
      expect(restored!.categories).toBeInstanceOf(Set);
      expect(Array.from(restored!.categories)).toEqual(['database', 'in-memory']);
      expect(restored!.score).toBe(99.5);
    });
  });

  describe('Security & DoS rejection (msgpackr 2.1.0 memory amplification fix)', () => {
    it('immediately rejects malformed array32 header declaring 20 million elements without memory allocation', () => {
      // 0xdd is MessagePack array32 header followed by a 4-byte big-endian length of 20,000,000 (0x01312d00)
      // Total buffer size is only 5 bytes. In msgpackr 2.0.5 this allocated a 20M element Array (~153MB).
      // In msgpackr 2.1.0, this immediately throws without allocation.
      const maliciousPayload = Buffer.from([0xdd, 0x01, 0x31, 0x2d, 0x00]);

      expect(() => {
        defaultCodec.decode(maliciousPayload);
      }).toThrow(/Unexpected end of MessagePack data/);
    });

    it('immediately rejects malformed map32 header declaring excessive elements', () => {
      // 0xdf is MessagePack map32 header followed by 20,000,000 entries length
      const maliciousMap = Buffer.from([0xdf, 0x01, 0x31, 0x2d, 0x00]);

      expect(() => {
        defaultCodec.decode(maliciousMap);
      }).toThrow(/Unexpected end of MessagePack data/);
    });
  });
});
