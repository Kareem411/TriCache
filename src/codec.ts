import { Packr, type Options as MsgpackrOptions } from 'msgpackr';

/**
 * Configuration options for the TriCache binary codec.
 */
export interface CacheCodecOptions {
  /**
   * When true (default), objects with a toJSON() method will have toJSON() invoked.
   * When false (msgpackr 2.1.0+), the object's own internal properties are serialized directly,
   * avoiding accidental HTTP response projections on durable cached state.
   */
  useToJSON?: boolean;
  /**
   * Enable msgpackr record structure extension (default: true).
   * Generates compact record definitions that yield 30-50% smaller encodings for repeated object shapes.
   */
  useRecords?: boolean;
  /**
   * Enable serialization of additional built-in types (Map, Set, TypedArray, Error, RegExp).
   * Default: true.
   */
  moreTypes?: boolean;
  /**
   * Decode MessagePack maps as plain JavaScript objects.
   * Default: true (ensures plain JS objects and standard maps decode to plain objects).
   */
  mapsAsObjects?: boolean;
}

/**
 * CacheCodec wraps msgpackr's Packr/Unpackr to provide unified, high-performance binary
 * serialization across L1 in-memory buffers, L1.5 disk spill, and cold-start snapshots.
 */
export class CacheCodec {
  private readonly packr: Packr;

  constructor(options?: CacheCodecOptions) {
    const packrOptions: MsgpackrOptions = {
      useToJSON:     options?.useToJSON ?? true,
      useRecords:    options?.useRecords ?? true,
      moreTypes:     options?.moreTypes ?? true,
      mapsAsObjects: options?.mapsAsObjects ?? true,
    };
    this.packr = new Packr(packrOptions);
  }

  /**
   * Serializes a JavaScript value to a binary MessagePack Buffer.
   */
  encode(data: unknown): Buffer {
    const packed = this.packr.pack(data);
    return Buffer.isBuffer(packed)
      ? packed
      : Buffer.from((packed as Uint8Array).buffer, (packed as Uint8Array).byteOffset, (packed as Uint8Array).byteLength);
  }

  /**
   * Deserializes a binary MessagePack Buffer or Uint8Array back to a JavaScript value.
   */
  decode<T = unknown>(data: Buffer | Uint8Array): T {
    return this.packr.unpack(data) as T;
  }
}

/**
 * Default singleton codec configured for high-speed packing, record deduplication, and rich types.
 */
export const defaultCodec = new CacheCodec({
  useToJSON:  true,
  useRecords: true,
  moreTypes:  true,
});
