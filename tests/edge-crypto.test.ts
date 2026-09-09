import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { CacheEncryption } from '../src/encryption';
import { WebCryptoEncryption } from '../src/edge/crypto';
import { uint8ArrayToBase64, base64ToUint8Array } from '../src/edge/utils/base64';

describe('Universal Edge Portability: Web Crypto AEAD & Cross-Compatibility', () => {
  const key256 = crypto.randomBytes(32).toString('base64');
  const key128 = crypto.randomBytes(16).toString('base64');
  const prevKey256 = crypto.randomBytes(32).toString('base64');

  it('performs two-way cross-decryption with Node CacheEncryption (AES-256-GCM)', async () => {
    const nodeEnc = new CacheEncryption(key256, 'aes-256-gcm');
    const edgeEnc = new WebCryptoEncryption({ keyBase64: key256, mode: 'aes-256-gcm' });

    const message = 'Hello Universal Edge Caching with TriCache! 🚀';

    // 1. Node encrypt -> Edge decrypt
    const nodeCiphertext = nodeEnc.encrypt(message);
    expect(nodeCiphertext.startsWith('enc:v1:')).toBe(true);
    const edgeDecrypted = await edgeEnc.decrypt(nodeCiphertext);
    expect(edgeDecrypted).toBe(message);

    // 2. Edge encrypt -> Node decrypt
    const edgeCiphertext = await edgeEnc.encrypt(message);
    expect(edgeCiphertext.startsWith('enc:v1:')).toBe(true);
    const nodeDecrypted = nodeEnc.decrypt(edgeCiphertext);
    expect(nodeDecrypted).toBe(message);
  });

  it('performs two-way cross-decryption with Node CacheEncryption (AES-128-GCM)', async () => {
    const nodeEnc = new CacheEncryption(key128, 'aes-128-gcm');
    const edgeEnc = new WebCryptoEncryption({ keyBase64: key128, mode: 'aes-128-gcm' });

    const message = 'Fast 128-bit AEAD payload across Cloudflare Isolates and Node';

    // 1. Node encrypt -> Edge decrypt
    const nodeCiphertext = nodeEnc.encrypt(message);
    expect(nodeCiphertext.startsWith('a128:v1:')).toBe(true);
    const edgeDecrypted = await edgeEnc.decrypt(nodeCiphertext);
    expect(edgeDecrypted).toBe(message);

    // 2. Edge encrypt -> Node decrypt
    const edgeCiphertext = await edgeEnc.encrypt(message);
    expect(edgeCiphertext.startsWith('a128:v1:')).toBe(true);
    const nodeDecrypted = nodeEnc.decrypt(edgeCiphertext);
    expect(nodeDecrypted).toBe(message);
  });

  it('supports seamless key rotation fallback using prevKeyBase64', async () => {
    const oldEdgeEnc = new WebCryptoEncryption({ keyBase64: prevKey256, mode: 'aes-256-gcm' });
    const rotatedEdgeEnc = new WebCryptoEncryption({
      keyBase64: key256,
      prevKeyBase64: prevKey256,
      mode: 'aes-256-gcm',
    });

    const msg = 'Rotated key secret';
    const oldEnvelope = await oldEdgeEnc.encrypt(msg);

    // Rotated instance successfully decrypts data encrypted under old key
    const decrypted = await rotatedEdgeEnc.decrypt(oldEnvelope);
    expect(decrypted).toBe(msg);
  });

  it('rejects tampered ciphertexts and invalid auth tags', async () => {
    const edgeEnc = new WebCryptoEncryption({ keyBase64: key256 });
    const cipher = await edgeEnc.encrypt('Sensitive Bank Record');

    // Corrupt one character in the base64 ciphertext
    const prefix = 'enc:v1:';
    const rawB64 = cipher.slice(prefix.length);
    const tampered = prefix + rawB64.slice(0, 10) + (rawB64[10] === 'A' ? 'B' : 'A') + rawB64.slice(11);

    await expect(edgeEnc.decrypt(tampered)).rejects.toThrow();
  });

  it('encodes and decodes large binary payloads (> 64 KB) without RangeError call stack overflow', () => {
    // 128 KB binary payload
    const largeSize = 128 * 1024;
    const bytes = new Uint8Array(largeSize);
    for (let i = 0; i < largeSize; i++) {
      bytes[i] = i % 256;
    }

    const b64 = uint8ArrayToBase64(bytes);
    expect(typeof b64).toBe('string');
    expect(b64.length).toBeGreaterThan(largeSize);

    const roundtrip = base64ToUint8Array(b64);
    expect(roundtrip.length).toBe(largeSize);
    expect(roundtrip[0]).toBe(0);
    expect(roundtrip[1000]).toBe(1000 % 256);
    expect(roundtrip[largeSize - 1]).toBe((largeSize - 1) % 256);
  });

  it('validates key byte lengths during initialization', () => {
    // 10-byte key (too short for aes-256-gcm)
    const invalidKey = crypto.randomBytes(10).toString('base64');
    expect(() => new WebCryptoEncryption({ keyBase64: invalidKey, mode: 'aes-256-gcm' })).toThrow(
      /key length mismatch for aes-256-gcm. Expected 32 bytes, received 10 bytes/,
    );

    // 32-byte key for aes-128-gcm (expects 16 bytes)
    const tooLongKey = crypto.randomBytes(32).toString('base64');
    expect(() => new WebCryptoEncryption({ keyBase64: tooLongKey, mode: 'aes-128-gcm' })).toThrow(
      /key length mismatch for aes-128-gcm. Expected 16 bytes, received 32 bytes/,
    );
  });

  it('passes through plaintext when encryption is disabled', async () => {
    const disabledEnc = new WebCryptoEncryption();
    expect(disabledEnc.isEnabled).toBe(false);

    const plain = 'unencrypted data';
    expect(await disabledEnc.encrypt(plain)).toBe(plain);
    expect(await disabledEnc.decrypt(plain)).toBe(plain);
  });

  it('returns unrecognized prefixes as-is on decrypt', async () => {
    const enc = new WebCryptoEncryption({ keyBase64: key256 });
    expect(await enc.decrypt('raw-unencrypted-string')).toBe('raw-unencrypted-string');
  });
});
