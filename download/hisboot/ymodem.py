"""Ymodem-CRC sender/receiver used by WS63 loaderboot."""

from __future__ import annotations

import os
import struct
import time
from typing import Callable, Optional

from .crc16 import crc16
from .fwpkg import FwpkgImage

SOH = 0x01
STX = 0x02
EOT = 0x04
ACK = 0x06
NAK = 0x15
CAN = 0x18
CHAR_C = ord("C")

WAIT_C_TIMEOUT = 15.0
ACK_TIMEOUT = 3.0
XMIT_TIMEOUT = 60.0
RECV_TIMEOUT = 15.0


class YmodemError(RuntimeError):
    pass


def _read_byte(ser, timeout: float) -> Optional[int]:
    old = ser.timeout
    ser.timeout = timeout
    try:
        data = ser.read(1)
    finally:
        ser.timeout = old
    if not data:
        return None
    return data[0]


def wait_char(ser, expected: int, timeout: float) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        remain = max(0.01, deadline - time.time())
        b = _read_byte(ser, remain)
        if b == expected:
            return True
        if b == CAN:
            raise YmodemError("receiver cancelled (CAN)")
    return False


def wait_ack(ser, timeout: float = ACK_TIMEOUT) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        remain = max(0.01, deadline - time.time())
        b = _read_byte(ser, remain)
        if b == ACK:
            return True
        if b == NAK:
            return False
        if b == CAN:
            raise YmodemError("receiver cancelled (CAN)")
    return False


def _progress(done: int, total: int, cb: Optional[Callable[[int, int], None]]) -> None:
    if cb:
        cb(done, total)
        return
    if total <= 0:
        return
    width = 32
    filled = int(width * done / total)
    bar = "#" * filled + "-" * (width - filled)
    pct = 100.0 * done / total
    print(f"\r  [{bar}] {pct:5.1f}%  {done}/{total} blk", end="", flush=True)
    if done >= total:
        print()


def _header_block(name: str, size: int) -> bytes:
    payload = bytearray(128)
    encoded = f"{name}\x00{size}\x00".encode("ascii", errors="replace")
    payload[: len(encoded)] = encoded[:128]
    crc = crc16(bytes(payload))
    return bytes([SOH, 0x00, 0xFF]) + bytes(payload) + struct.pack(">H", crc)


def _empty_header() -> bytes:
    payload = bytes(128)
    crc = crc16(payload)
    return bytes([SOH, 0x00, 0xFF]) + payload + struct.pack(">H", crc)


def _data_block(seq: int, chunk: bytes, use_1k: bool = True) -> bytes:
    if use_1k:
        size = 1024
        start = STX
    else:
        size = 128
        start = SOH
    data = bytearray(size)
    data[: len(chunk)] = chunk
    crc = crc16(bytes(data))
    seq_b = seq & 0xFF
    return bytes([start, seq_b, 0xFF - seq_b]) + bytes(data) + struct.pack(">H", crc)


def send_block(ser, blk: bytes, timeout: float = XMIT_TIMEOUT) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        ser.write(blk)
        ser.flush()
        if wait_ack(ser):
            return
    raise YmodemError("ymodem ACK timeout")


def send_image(
    ser,
    image: FwpkgImage,
    progress: Optional[Callable[[int, int], None]] = None,
) -> None:
    if not wait_char(ser, CHAR_C, WAIT_C_TIMEOUT):
        raise YmodemError(f"timeout waiting for Ymodem 'C' ({image.name})")

    send_block(ser, _header_block(image.name, image.length))

    total_blk = (image.length + 1023) // 1024 if image.length else 0
    sent_blk = 0
    remaining = image.length
    seq = 1
    with open(image.path, "rb") as f:
        f.seek(image.offset)
        while remaining > 0:
            n = min(1024, remaining)
            chunk = f.read(n)
            if len(chunk) != n:
                raise YmodemError(f"short read while sending {image.name}")
            send_block(ser, _data_block(seq, chunk, use_1k=True))
            remaining -= n
            seq = (seq + 1) & 0xFF
            sent_blk += 1
            _progress(sent_blk, total_blk, progress)

    ser.write(bytes([EOT]))
    ser.flush()
    # Device may NAK the first EOT (standard ymodem); retry until ACK.
    deadline = time.time() + XMIT_TIMEOUT
    while time.time() < deadline:
        if wait_ack(ser):
            break
        ser.write(bytes([EOT]))
        ser.flush()
    else:
        raise YmodemError("timeout waiting EOT ACK")

    # Optional 'C' before the finishing empty header.
    wait_char(ser, CHAR_C, 1.0)
    send_block(ser, _empty_header())


def _read_exact(ser, n: int, timeout: float) -> bytes:
    buf = bytearray()
    deadline = time.time() + timeout
    old = ser.timeout
    try:
        while len(buf) < n:
            remain = deadline - time.time()
            if remain <= 0:
                raise YmodemError("timeout reading ymodem payload")
            ser.timeout = remain
            chunk = ser.read(n - len(buf))
            if not chunk:
                continue
            buf.extend(chunk)
    finally:
        ser.timeout = old
    return bytes(buf)


def receive_to_file(
    ser,
    out_path: str,
    expected_len: Optional[int] = None,
    progress: Optional[Callable[[int, int], None]] = None,
) -> int:
    """Receive one Ymodem file. Returns written byte count."""
    ser.write(b"C")
    ser.flush()

    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    written = 0
    file_len = expected_len
    seq_expect = 0
    first = True

    with open(out_path, "wb") as out:
        while True:
            mark = _read_byte(ser, RECV_TIMEOUT)
            if mark is None:
                raise YmodemError("timeout waiting ymodem packet")
            if mark == EOT:
                ser.write(bytes([ACK, CHAR_C]))
                ser.flush()
                # consume finishing empty header
                hdr = _read_byte(ser, RECV_TIMEOUT)
                if hdr == SOH:
                    _read_exact(ser, 132, RECV_TIMEOUT)
                    ser.write(bytes([ACK]))
                    ser.flush()
                break
            if mark == CAN:
                raise YmodemError("sender cancelled")
            if mark not in (SOH, STX):
                continue

            size = 128 if mark == SOH else 1024
            hdr = _read_exact(ser, 2, RECV_TIMEOUT)
            payload = _read_exact(ser, size, RECV_TIMEOUT)
            crc_b = _read_exact(ser, 2, RECV_TIMEOUT)
            seq, seq_inv = hdr[0], hdr[1]
            if seq != (seq_inv ^ 0xFF):
                ser.write(bytes([NAK]))
                continue
            if crc16(payload) != struct.unpack(">H", crc_b)[0]:
                ser.write(bytes([NAK]))
                continue

            if first:
                first = False
                if seq != 0:
                    ser.write(bytes([NAK]))
                    continue
                name_end = payload.find(b"\x00")
                rest = payload[name_end + 1 :] if name_end >= 0 else b""
                size_end = rest.find(b"\x00")
                size_txt = rest[:size_end] if size_end >= 0 else rest
                try:
                    text = size_txt.decode("ascii", errors="ignore").strip()
                    if text:
                        file_len = int(text, 0)
                except ValueError:
                    pass
                ser.write(bytes([ACK, CHAR_C]))
                ser.flush()
                seq_expect = 1
                continue

            if seq != (seq_expect & 0xFF):
                ser.write(bytes([ACK]))  # duplicate
                continue

            chunk = payload
            if file_len is not None:
                remain = file_len - written
                chunk = chunk[: max(0, remain)]
            out.write(chunk)
            written += len(chunk)
            seq_expect = (seq_expect + 1) & 0xFF
            ser.write(bytes([ACK]))
            ser.flush()
            if file_len:
                _progress(min(written, file_len), file_len, progress)

    return written
