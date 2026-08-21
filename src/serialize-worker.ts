/**
 * serialize-worker — worker-thread entry point for off-main-thread encryption/decryption/compression.
 *
 * Receives messages from WorkerPool:
 *   { id: number; type: 'encrypt'; payload: string }
 *   { id: number; type: 'decrypt'; payload: string }
 *
 * Posts back:
 *   { id: number; result: string }   — on success
 *   { id: number; error: string }    — on failure
 *
 * The encryption key and mode are received once via workerData at thread creation,
 * so no key material travels with every per-message IPC call.
 */

import { parentPort, workerData } from 'worker_threads';
import { CacheEncryption } from './encryption.ts';
import type { EncryptionMode } from './encryption.ts';
import type { ILogger } from './types.ts';
import {
  compressBuffer,
  decompressBuffer,
  PREFIX_COMPRESSED,
  PREFIX_ENC_COMPRESSED,
  type CompressionAlgorithm,
} from './compression.ts';

interface WorkerInit {
  keyBase64:     string;
  mode:          EncryptionMode;
  prevKeyBase64: string | undefined;
  prevMode:      EncryptionMode | undefined;
  compression?:  CompressionAlgorithm;
  compressionThresholdBytes?: number;
}

// Minimal no-op logger — worker thread does not log to avoid interleaved I/O.
const silentLogger: ILogger = {
  debug: () => {},
  info:  () => {},
  warn:  () => {},
  error: () => {},
};

const { keyBase64, mode, prevKeyBase64, prevMode, compression, compressionThresholdBytes } =
  workerData as WorkerInit;

const enc = new CacheEncryption(
  keyBase64 || undefined,
  silentLogger,
  mode,
  prevKeyBase64 || undefined,
  prevMode,
);

const cmpAlgo = compression ?? 'none';
const cmpThreshold = compressionThresholdBytes ?? 1024;

parentPort!.on(
  'message',
  ({ id, type, payload }: { id: number; type: 'encrypt' | 'decrypt'; payload: string | Uint8Array }) => {
    try {
      const textPayload =
        typeof payload === 'string'
          ? payload
          : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8');

      if (type === 'encrypt') {
        let result: string;
        if (cmpAlgo !== 'none' && textPayload.length > cmpThreshold) {
          const compressed = compressBuffer(Buffer.from(textPayload, 'utf8'), cmpAlgo);
          if (enc.isEnabled) {
            const encrypted = enc.encryptBuffer(compressed);
            result = PREFIX_ENC_COMPRESSED + encrypted.toString('base64');
          } else {
            result = PREFIX_COMPRESSED + compressed.toString('base64');
          }
        } else {
          result = enc.encrypt(textPayload);
        }

        if (result.length >= 131_072) {
          const outBuf = Buffer.from(result, 'utf8');
          const transferable = new ArrayBuffer(outBuf.byteLength);
          new Uint8Array(transferable).set(outBuf);
          const outputUint8 = new Uint8Array(transferable);
          parentPort!.postMessage({ id, result: outputUint8, isTransfer: true }, [transferable]);
        } else {
          parentPort!.postMessage({ id, result });
        }
      } else {
        let result: string;
        if (textPayload.startsWith(PREFIX_ENC_COMPRESSED)) {
          const rawBuf = Buffer.from(textPayload.slice(PREFIX_ENC_COMPRESSED.length), 'base64');
          const decryptedBuf = enc.decryptBuffer(rawBuf);
          const decompressed = decompressBuffer(decryptedBuf, cmpAlgo !== 'none' ? cmpAlgo : 'brotli');
          result = decompressed.toString('utf8');
        } else if (textPayload.startsWith(PREFIX_COMPRESSED)) {
          const rawBuf = Buffer.from(textPayload.slice(PREFIX_COMPRESSED.length), 'base64');
          const decompressed = decompressBuffer(rawBuf, cmpAlgo !== 'none' ? cmpAlgo : 'brotli');
          result = decompressed.toString('utf8');
        } else {
          result = enc.decrypt(textPayload);
        }

        if (result.length >= 131_072) {
          const outBuf = Buffer.from(result, 'utf8');
          const transferable = new ArrayBuffer(outBuf.byteLength);
          new Uint8Array(transferable).set(outBuf);
          const outputUint8 = new Uint8Array(transferable);
          parentPort!.postMessage({ id, result: outputUint8, isTransfer: true }, [transferable]);
        } else {
          parentPort!.postMessage({ id, result });
        }
      }
    } catch (e) {
      parentPort!.postMessage({ id, error: (e as Error).message });
    }
  },
);
