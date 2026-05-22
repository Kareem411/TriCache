/**
 * AES-256-GCM encryption for L2 (Redis) values and disk snapshots at rest.
 *
 * Key:
 *   Pass a base64-encoded 32-byte secret via CacheOptions.encryptionKey
 *   or the CACHE_ENCRYPTION_KEY environment variable.
 *   Generate with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Encrypted Redis value format:
 *   `enc:v1:` + base64( IV[12] | AuthTag[16] | Ciphertext[N] )
 *
 * Encrypted disk/snapshot format:
 *   MAGIC[8] | IV[12] | AuthTag[16] | Ciphertext[N]
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import type { ILogger } from './types';

const AES_ALGO = 'aes-256-gcm' as const;
const IV_BYTES  = 12; // 96-bit IV (NIST recommended for GCM)
const TAG_BYTES = 16; // 128-bit auth tag

// ── Redis value envelope ──────────────────────────────────────────────────────
const ENC_REDIS_PREFIX = 'enc:v1:';

// ── Snapshot / disk envelope ─────────────────────────────────────────────────
/** "TRIC1ENC" magic header — identifies an encrypted binary blob */
const BINARY_MAGIC = Buffer.from([0x54, 0x52, 0x49, 0x43, 0x31, 0x45, 0x4e, 0x43]);

// ─────────────────────────────────────────────────────────────────────────────

export class CacheEncryption {
  private _key: Buffer | null = null;

  constructor(keyBase64: string | undefined, logger: ILogger) {
    if (!keyBase64) {
      if (process.env.NODE_ENV === 'production') {
        logger.warn(
          'SECURITY: encryption key not set — cache data stored unencrypted at rest',
          { hint: 'Set encryptionKey option or CACHE_ENCRYPTION_KEY env var' },
        );
      }
      return;
    }
    try {
      const buf = Buffer.from(keyBase64, 'base64');
      if (buf.length !== 32) {
        throw new Error(`Key must be exactly 32 bytes (got ${buf.length})`);
      }
      this._key = buf;
      logger.debug('Cache encryption enabled (AES-256-GCM)');
    } catch (err) {
      logger.error('Invalid encryption key — falling back to plaintext', {}, err as Error);
    }
  }

  get isEnabled(): boolean { return this._key !== null; }

  // ── String (Redis) ────────────────────────────────────────────────────────

  /**
   * Encrypt a string for Redis storage.
   * Returns `enc:v1:<base64>` when a key is configured; otherwise returns the
   * original string unchanged (backward-compatible).
   */
  encrypt(plaintext: string): string {
    if (!this._key) return plaintext;
    const iv  = randomBytes(IV_BYTES);
    const c   = createCipheriv(AES_ALGO, this._key, iv);
    const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    const tag = c.getAuthTag();
    return ENC_REDIS_PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
  }

  /**
   * Decrypt a Redis value.
   * Handles both the new `enc:v1:…` format and legacy plaintext seamlessly.
   */
  decrypt(value: string): string {
    if (!value.startsWith(ENC_REDIS_PREFIX)) return value;
    if (!this._key) throw new Error('Cannot decrypt: encryption key is not set');
    const combined = Buffer.from(value.slice(ENC_REDIS_PREFIX.length), 'base64');
    const iv  = combined.subarray(0, IV_BYTES);
    const tag = combined.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ct  = combined.subarray(IV_BYTES + TAG_BYTES);
    const d   = createDecipheriv(AES_ALGO, this._key, iv);
    d.setAuthTag(tag);
    return d.update(ct).toString('utf8') + d.final('utf8');
  }

  // ── Buffer (disk / snapshot) ──────────────────────────────────────────────

  /** Encrypt a raw Buffer. Returns MAGIC | IV | AuthTag | Ciphertext when a key is set. */
  encryptBuffer(data: Buffer): Buffer {
    if (!this._key) return data;
    const iv  = randomBytes(IV_BYTES);
    const c   = createCipheriv(AES_ALGO, this._key, iv);
    const enc = Buffer.concat([c.update(data), c.final()]);
    const tag = c.getAuthTag();
    return Buffer.concat([BINARY_MAGIC, iv, tag, enc]);
  }

  /**
   * Decrypt a raw Buffer from disk/snapshot.
   * Returns the original buffer if it does not carry the magic header (legacy/unencrypted).
   */
  decryptBuffer(data: Buffer): Buffer {
    const mLen = BINARY_MAGIC.length;
    if (data.length < mLen || !data.subarray(0, mLen).equals(BINARY_MAGIC)) return data;
    if (!this._key) throw new Error('Cannot decrypt buffer: encryption key is not set');
    const iv  = data.subarray(mLen, mLen + IV_BYTES);
    const tag = data.subarray(mLen + IV_BYTES, mLen + IV_BYTES + TAG_BYTES);
    const ct  = data.subarray(mLen + IV_BYTES + TAG_BYTES);
    const d   = createDecipheriv(AES_ALGO, this._key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  }
}
