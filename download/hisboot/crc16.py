"""CRC-16/XMODEM (poly 0x1021, init 0), same as loaderboot crc16_ccitt."""

import binascii


def crc16(data: bytes, init: int = 0) -> int:
    return binascii.crc_hqx(data, init) & 0xFFFF
