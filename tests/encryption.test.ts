/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { CacheEncryption } from '../src/encryption';
import type { ILogger } from '../src/types';

const silentLogger: ILogger = {
  debug: () => {},
  info:  () => {},
  warn:  () => {},
  error: () => {},
};

function makeKey(length: number, char = 'k'): string {
  return Buffer.from(char.repeat(length)).toString('base64');
}

describe('CacheEncryption unit tests', () => {
  const key256 = makeKey(32, 'a');
  const key128 = makeKey(16, 'b');
  const keyXor = makeKey(16, 'x');

  describe('Encryption modes — encrypt & decrypt round-trips', () => {
    it('encrypts and decrypts with aes-256-gcm (default)', () => {
      const enc = new CacheEncryption(key256, silentLogger, 'aes-256-gcm');
      expect(enc.isEnabled).toBe(true);
      expect(enc.mode).toBe('aes-256-gcm');

      const plaintext = 'sensitive user payload 12345';
      const ciphertext = enc.encrypt(plaintext);
      expect(ciphertext).not.toBe(plaintext);
      expect(ciphertext.startsWith('enc:v1:')).toBe(true);

      const decrypted = enc.decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);
    });

    it('encrypts and decrypts with aes-128-gcm', () => {
      const enc = new CacheEncryption(key128, silentLogger, 'aes-128-gcm');
      expect(enc.isEnabled).toBe(true);
      expect(enc.mode).toBe('aes-128-gcm');

      const plaintext = 'aes-128-gcm test string 🍕';
      const ciphertext = enc.encrypt(plaintext);
      expect(ciphertext).not.toBe(plaintext);
      expect(ciphertext.startsWith('a128:v1:')).toBe(true);

      const decrypted = enc.decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);
    });

    it('encrypts and decrypts with aes-128-ctr', () => {
      const enc = new CacheEncryption(key128, silentLogger, 'aes-128-ctr');
      expect(enc.isEnabled).toBe(true);
      expect(enc.mode).toBe('aes-128-ctr');

      const plaintext = 'aes-128-ctr test string 🔥⚡';
      const ciphertext = enc.encrypt(plaintext);
      expect(ciphertext).not.toBe(plaintext);
      expect(ciphertext.startsWith('ctr:v1:')).toBe(true);

      const decrypted = enc.decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);
    });

    it('encrypts and decrypts with xor obfuscation', () => {
      const enc = new CacheEncryption(keyXor, silentLogger, 'xor');
      expect(enc.isEnabled).toBe(true);
      expect(enc.mode).toBe('xor');

      const plaintext = 'xor obfuscated data';
      const ciphertext = enc.encrypt(plaintext);
      expect(ciphertext).not.toBe(plaintext);
      expect(ciphertext.startsWith('xor:v1:')).toBe(true);

      const decrypted = enc.decrypt(ciphertext);
      expect(decrypted).toBe(plaintext);
    });

    it('returns plaintext unchanged when encryption is not enabled', () => {
      const enc = new CacheEncryption(undefined, silentLogger);
      expect(enc.isEnabled).toBe(false);

      const plaintext = 'unencrypted data';
      expect(enc.encrypt(plaintext)).toBe(plaintext);
      expect(enc.decrypt(plaintext)).toBe(plaintext);
    });
  });

  describe('Buffer encryption — encryptBuffer & decryptBuffer', () => {
    it('encrypts and decrypts binary buffers in aes-256-gcm mode', () => {
      const enc = new CacheEncryption(key256, silentLogger, 'aes-256-gcm');
      const data = Buffer.from('binary buffer data 12345');

      const encrypted = enc.encryptBuffer(data);
      expect(encrypted).not.toEqual(data);

      const decrypted = enc.decryptBuffer(encrypted);
      expect(decrypted.toString()).toBe(data.toString());
    });

    it('encrypts and decrypts binary buffers in aes-128-gcm mode', () => {
      const enc = new CacheEncryption(key128, silentLogger, 'aes-128-gcm');
      const data = Buffer.from('binary buffer data 128 gcm');

      const encrypted = enc.encryptBuffer(data);
      expect(encrypted).not.toEqual(data);

      const decrypted = enc.decryptBuffer(encrypted);
      expect(decrypted.toString()).toBe(data.toString());
    });

    it('encrypts and decrypts binary buffers in aes-128-ctr mode', () => {
      const enc = new CacheEncryption(key128, silentLogger, 'aes-128-ctr');
      const data = Buffer.from('binary buffer data 128 ctr');

      const encrypted = enc.encryptBuffer(data);
      expect(encrypted).not.toEqual(data);

      const decrypted = enc.decryptBuffer(encrypted);
      expect(decrypted.toString()).toBe(data.toString());
    });

    it('encrypts and decrypts binary buffers in xor mode', () => {
      const enc = new CacheEncryption(keyXor, silentLogger, 'xor');
      const data = Buffer.from('binary buffer data xor');

      const encrypted = enc.encryptBuffer(data);
      expect(encrypted).not.toEqual(data);

      const decrypted = enc.decryptBuffer(encrypted);
      expect(decrypted.toString()).toBe(data.toString());
    });

    it('returns buffer unchanged when buffer is unencrypted or short', () => {
      const enc = new CacheEncryption(key256, silentLogger);
      const shortBuf = Buffer.from('short');
      expect(enc.decryptBuffer(shortBuf)).toBe(shortBuf);
    });
  });

  describe('Tamper resistance and integrity', () => {
    it('throws error when ciphertext is tampered with in aes-256-gcm mode', () => {
      const enc = new CacheEncryption(key256, silentLogger, 'aes-256-gcm');
      const ciphertext = enc.encrypt('important payload');

      // Tamper with ciphertext payload
      const tampered = ciphertext.slice(0, -4) + 'AAAA';
      expect(() => enc.decrypt(tampered)).toThrow();
    });

    it('throws error when buffer tag is tampered with in aes-256-gcm mode', () => {
      const enc = new CacheEncryption(key256, silentLogger, 'aes-256-gcm');
      const encrypted = enc.encryptBuffer(Buffer.from('payload'));

      // Flip a bit in the auth tag portion
      encrypted[25] ^= 0xff;
      expect(() => enc.decryptBuffer(encrypted)).toThrow();
    });
  });

  describe('Key rotation fallback & error paths', () => {
    const primaryKey  = makeKey(32, '1');
    const fallbackKey = makeKey(32, '2');
    const thirdKey    = makeKey(32, '3');

    it('decrypts with primary key without touching fallback key', () => {
      const enc = new CacheEncryption(primaryKey, silentLogger, 'aes-256-gcm', fallbackKey);
      const ciphertext = enc.encrypt('primary data');
      expect(enc.decrypt(ciphertext)).toBe('primary data');
    });

    it('decrypts with fallback key when ciphertext was encrypted with previous key', () => {
      const oldEnc = new CacheEncryption(fallbackKey, silentLogger, 'aes-256-gcm');
      const newEnc = new CacheEncryption(primaryKey, silentLogger, 'aes-256-gcm', fallbackKey);

      const ciphertext = oldEnc.encrypt('old key data');
      expect(newEnc.decrypt(ciphertext)).toBe('old key data');
    });

    it('re-throws primaryErr when both primary and previous keys fail to decrypt string', () => {
      const otherEnc = new CacheEncryption(thirdKey, silentLogger, 'aes-256-gcm');
      const ciphertext = otherEnc.encrypt('third key data');

      const enc = new CacheEncryption(primaryKey, silentLogger, 'aes-256-gcm', fallbackKey);

      let thrownError: Error | null = null;
      try {
        enc.decrypt(ciphertext);
      } catch (err) {
        thrownError = err as Error;
      }

      expect(thrownError).not.toBeNull();
      expect(thrownError).toBeInstanceOf(Error);
    });

    it('re-throws primaryErr when both primary and previous keys fail to decrypt buffer', () => {
      const otherEnc = new CacheEncryption(thirdKey, silentLogger, 'aes-256-gcm');
      const cipherBuf = otherEnc.encryptBuffer(Buffer.from('third key buffer'));

      const enc = new CacheEncryption(primaryKey, silentLogger, 'aes-256-gcm', fallbackKey);

      let thrownError: Error | null = null;
      try {
        enc.decryptBuffer(cipherBuf);
      } catch (err) {
        thrownError = err as Error;
      }

      expect(thrownError).not.toBeNull();
      expect(thrownError).toBeInstanceOf(Error);
    });
  });

  describe('Worker initialization accessor (toWorkerInit)', () => {
    it('exports key material and mode correctly for worker pool init', () => {
      const enc = new CacheEncryption(key256, silentLogger, 'aes-256-gcm', key128, 'aes-128-gcm');
      const init = enc.toWorkerInit();

      expect(init.keyBase64).toBe(key256);
      expect(init.mode).toBe('aes-256-gcm');
      expect(init.prevKeyBase64).toBe(key128);
      expect(init.prevMode).toBe('aes-128-gcm');
    });
  });

  describe('Invalid-key handling — strict mode', () => {
    it('throws at construction on a wrong-length AES key when strictKeyValidation is set', () => {
      // 16-byte key supplied for an aes-256-gcm mode — must fail CLOSED.
      expect(
        () => new CacheEncryption(key128, silentLogger, 'aes-256-gcm', undefined, undefined, { strictKeyValidation: true }),
      ).toThrow(/requires exactly 32 bytes/);
    });

    it('throws at construction on an undersized XOR key when strictKeyValidation is set', () => {
      // Empty base64 payload — XOR requires ≥ 1 byte.
      expect(
        () => new CacheEncryption('', silentLogger, 'xor', undefined, undefined, { strictKeyValidation: true }),
      ).toThrow();
    });

    it('default remains fail-open with a logged error (backward compat)', () => {
      const errorCalls: unknown[][] = [];
      const logger: ILogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (...args: unknown[]) => { errorCalls.push(args); },
      };
      const enc = new CacheEncryption(makeKey(5, 'q'), logger, 'aes-256-gcm');
      expect(enc.isEnabled).toBe(false);
      expect(errorCalls.length).toBeGreaterThan(0);
    });
  });
});
