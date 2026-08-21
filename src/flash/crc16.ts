/** CRC-16/XMODEM (poly 0x1021, init 0), same as Python binascii.crc_hqx / histool. */

const TABLE = new Uint16Array(256)

for (let i = 0; i < 256; i++) {
  let crc = i << 8
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) : crc << 1
    crc &= 0xffff
  }
  TABLE[i] = crc
}

export function crc16(data: Uint8Array, init = 0): number {
  let crc = init & 0xffff
  for (let i = 0; i < data.length; i++) {
    crc = ((crc << 8) ^ TABLE[((crc >> 8) ^ data[i]) & 0xff]) & 0xffff
  }
  return crc
}
