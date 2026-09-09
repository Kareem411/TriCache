import {
  base64ToUint8Array,
  uint8ArrayToBase64,
  utf8ToUint8Array,
  uint8ArrayToUtf8,
} from './utils/base64';

export type WebCryptoMode = 'aes-256-gcm' | 'aes-128-gcm';

const PREFIX_256 = 'enc:v1:';
const PREFIX_128 = 'a128:v1:';
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = IV_LEN + TAG_LEN; // 28 bytes

export interface WebCryptoOptions {
  keyBase64: string;
  prevKeyBase64?: string;
  mode?: WebCryptoMode;
}

/**
 * Pure Web Crypto API implementation of TriCache AEAD encryption.
 * Compatible with Cloudflare Workers, Fastly Compute, Vercel Edge, Deno, and modern browsers.
 *
 * Interoperates with Node.js `CacheEncryption` by reordering Web Crypto's trailing tag
 * into TriCache's standard wire envelope:
 *   Envelope = IV[12] || Tag[16] || Ciphertext[N]
 */
export class WebCryptoEncryption {
  readonly isEnabled: boolean;
  private readonly mode: WebCryptoMode;
  private keyPromise: Promise<CryptoKey> | null = null;
  private prevKeyPromise: Promise<CryptoKey> | null = null;

  constructor(options?: WebCryptoOptions) {
    if (!options?.keyBase64) {
      this.isEnabled = false;
      this.mode = 'aes-256-gcm';
      return;
    }

    this.isEnabled = true;
    this.mode = options.mode ?? 'aes-256-gcm';

    const expectedBytes = this.mode === 'aes-256-gcm' ? 32 : 16;
    const rawKey = base64ToUint8Array(options.keyBase64);
    if (rawKey.length !== expectedBytes) {
      throw new Error(
        `WebCryptoEncryption: key length mismatch for ${this.mode}. Expected ${expectedBytes} bytes, received ${rawKey.length} bytes.`,
      );
    }

    this.keyPromise = this._importKey(rawKey);

    if (options.prevKeyBase64) {
      const rawPrevKey = base64ToUint8Array(options.prevKeyBase64);
      if (rawPrevKey.length === expectedBytes) {
        this.prevKeyPromise = this._importKey(rawPrevKey);
      }
    }
  }

  private async _importKey(rawBytes: Uint8Array): Promise<CryptoKey> {
    const cryptoSubtle = globalThis.crypto?.subtle;
    if (!cryptoSubtle) {
      throw new Error('WebCryptoEncryption: globalThis.crypto.subtle is not available in this environment.');
    }
    // Web Crypto requires raw ArrayBuffer
    const keyBuf = rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength) as ArrayBuffer;
    return cryptoSubtle.importKey(
      'raw',
      keyBuf,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  /**
   * Encrypts a plaintext string into a TriCache standard wire envelope.
   * Format: `enc:v1:<base64(IV[12] | Tag[16] | Ciphertext)>`
   */
  async encrypt(plaintext: string): Promise<string> {
    if (!this.isEnabled || !this.keyPromise) return plaintext;

    const cryptoObj = globalThis.crypto;
    const key = await this.keyPromise;
    const iv = cryptoObj.getRandomValues(new Uint8Array(IV_LEN));
    const plaintextBytes = utf8ToUint8Array(plaintext);

    // Web Crypto outputs: Ciphertext || Tag[16]
    const encryptedBuf = await cryptoObj.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer,
        tagLength: 128,
      },
      key,
      plaintextBytes.buffer.slice(plaintextBytes.byteOffset, plaintextBytes.byteOffset + plaintextBytes.byteLength) as ArrayBuffer,
    );

    const encryptedBytes = new Uint8Array(encryptedBuf);
    const ctLen = encryptedBytes.length - TAG_LEN;
    const ciphertext = encryptedBytes.subarray(0, ctLen);
    const tag = encryptedBytes.subarray(ctLen);

    // Reorder to TriCache wire layout: IV[12] || Tag[16] || Ciphertext[N]
    const envelope = new Uint8Array(HEADER_LEN + ctLen);
    envelope.set(iv, 0);
    envelope.set(tag, IV_LEN);
    envelope.set(ciphertext, HEADER_LEN);

    const prefix = this.mode === 'aes-128-gcm' ? PREFIX_128 : PREFIX_256;
    return prefix + uint8ArrayToBase64(envelope);
  }

  /**
   * Decrypts a TriCache standard wire envelope into plaintext.
   * Handles envelopes created by both WebCryptoEncryption and Node.js CacheEncryption.
   */
  async decrypt(envelopeStr: string): Promise<string> {
    if (!this.isEnabled || !this.keyPromise) return envelopeStr;

    let base64Data: string;
    if (envelopeStr.startsWith(PREFIX_256)) {
      base64Data = envelopeStr.slice(PREFIX_256.length);
    } else if (envelopeStr.startsWith(PREFIX_128)) {
      base64Data = envelopeStr.slice(PREFIX_128.length);
    } else {
      // Unencrypted or unrecognized prefix
      return envelopeStr;
    }

    const envelopeBytes = base64ToUint8Array(base64Data);
    if (envelopeBytes.length < HEADER_LEN) {
      throw new Error(`WebCryptoEncryption: malformed envelope, length ${envelopeBytes.length} < header ${HEADER_LEN}`);
    }

    try {
      const activeKey = await this.keyPromise;
      return await this._decryptWithKey(activeKey, envelopeBytes);
    } catch (primaryErr) {
      if (this.prevKeyPromise) {
        try {
          const prevKey = await this.prevKeyPromise;
          return await this._decryptWithKey(prevKey, envelopeBytes);
        } catch {
          // Re-throw primary error on key rotation failure
        }
      }
      throw primaryErr;
    }
  }

  private async _decryptWithKey(key: CryptoKey, envelopeBytes: Uint8Array): Promise<string> {
    const cryptoSubtle = globalThis.crypto.subtle;
    const iv = envelopeBytes.subarray(0, IV_LEN);
    const tag = envelopeBytes.subarray(IV_LEN, HEADER_LEN);
    const ciphertext = envelopeBytes.subarray(HEADER_LEN);

    // Web Crypto decrypt expects: Ciphertext || Tag[16]
    const webCryptoInput = new Uint8Array(ciphertext.length + TAG_LEN);
    webCryptoInput.set(ciphertext, 0);
    webCryptoInput.set(tag, ciphertext.length);

    const ivBuf = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer;
    const dataBuf = webCryptoInput.buffer.slice(webCryptoInput.byteOffset, webCryptoInput.byteOffset + webCryptoInput.byteLength) as ArrayBuffer;

    const decryptedBuf = await cryptoSubtle.decrypt(
      {
        name: 'AES-GCM',
        iv: ivBuf,
        tagLength: 128,
      },
      key,
      dataBuf,
    );

    return uint8ArrayToUtf8(new Uint8Array(decryptedBuf));
  }
}
