/** Redis Cluster CRC16/XMODEM hash slots, including the first non-empty hash tag. */
export function redisHashSlot(key: string): number {
  const open = key.indexOf('{');
  const close = open < 0 ? -1 : key.indexOf('}', open + 1);
  const bytes = Buffer.from(close > open + 1 ? key.slice(open + 1, close) : key, 'utf8');
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0);
    crc &= 0xffff;
  }
  return crc & 0x3fff;
}
