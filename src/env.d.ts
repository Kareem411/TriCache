declare module 'lz4js' {
  const lz4js: {
    compress: (buf: Uint8Array | Buffer) => Uint8Array;
    decompress: (buf: Uint8Array | Buffer) => Uint8Array;
  };
  export default lz4js;
}

declare module 'zstd-codec' {
  export const ZstdCodec: {
    run: (callback: (zstd: any) => void) => void;
  };
}
