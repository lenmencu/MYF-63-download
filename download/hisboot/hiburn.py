"""HiBurn UART command protocol used by WS63 ROM/loader boot."""

from __future__ import annotations

import logging
import math
import struct
import time
from typing import List, Optional, Sequence, Tuple, Union

import serial
from serial.tools import list_ports

from .crc16 import crc16
from .fwpkg import TYPE_FLASH, TYPE_LOADERBOOT, Fwpkg, FwpkgImage, as_image_from_bin
from .ymodem import receive_to_file, send_image

log = logging.getLogger("histool")

PACKET_MAGIC = 0xDEADBEEF
ACK_TYPE = 0xE1
ACK_SUCCESS = 0x5A

CMD_HANDSHAKE = 0xF0
CMD_DL_IMAGE = 0xD2
CMD_UL_DATA = 0xB4
CMD_RESET = 0x87
CMD_VERSION = 0x69
CMD_SET_BAUDRATE = 0x5A

BOOT_BAUD = 115200
ERASE_ALIGN = 0x2000
FLASH_CHIP_ERASE = 0xFFFFFFFF
FLASH_MEM_SIZE = 0x00400000
# uart_param: databit, stopbit, parity, flow_ctrl
# flow_ctrl: 0=None, 1=RTS&CTS, 2=RTS only, 3=CTS only
FLOW_NONE = 0
FLOW_RTSCTS = 1
ACK_PREFIX = bytes([0xEF, 0xBE, 0xAD, 0xDE, 0x0C, 0x00, ACK_TYPE, 0x1E])


def handshake_uart_cfg(flow_ctrl: int = FLOW_NONE) -> bytes:
    """8N1 + flow_ctrl byte for HiBurn handshake / set-baud payload."""
    return bytes([0x08, 0x01, 0x00, flow_ctrl & 0xFF])


class HistoolError(RuntimeError):
    pass


def list_serial_ports() -> List[str]:
    return [p.device for p in list_ports.comports()]


def align_erase(length: int) -> int:
    if length <= 0:
        return ERASE_ALIGN
    return int(math.ceil(length / float(ERASE_ALIGN))) * ERASE_ALIGN


def build_frame(cmd: int, payload: bytes) -> bytes:
    # packet_size = sizeof(head 8) + payload + crc 2
    packet_size = 8 + len(payload) + 2
    head = struct.pack("<IHBB", PACKET_MAGIC, packet_size, cmd, cmd ^ 0xFF)
    body = head + payload
    if len(body) != packet_size - 2:
        raise HistoolError("internal frame size error")
    csum = crc16(body)
    return body + struct.pack("<H", csum)


def parse_frame(buf: bytes) -> Tuple[int, bytes]:
    if len(buf) < 10:
        raise HistoolError("short HiBurn frame")
    magic, packet_size, cmd, pad = struct.unpack_from("<IHBB", buf, 0)
    if magic != PACKET_MAGIC:
        raise HistoolError(f"bad magic 0x{magic:08x}")
    if packet_size > len(buf) or packet_size < 10:
        raise HistoolError(f"bad packet_size {packet_size}")
    payload = buf[8 : packet_size - 2]
    csum = struct.unpack_from("<H", buf, packet_size - 2)[0]
    calc = crc16(buf[: packet_size - 2])
    if csum != calc:
        raise HistoolError(f"frame CRC mismatch 0x{csum:04x} != 0x{calc:04x}")
    return cmd, payload


class Ws63Device:
    def __init__(
        self,
        port: str,
        baud: int = 921600,
        connect_timeout: float = 15.0,
        trace: bool = False,
        flow: str = "none",
    ) -> None:
        self.port = port
        self.baud = baud
        self.connect_timeout = connect_timeout
        self.trace = trace
        # Match burn (xf_burn_tools): default none → handshake uart_param flow_ctrl=0
        # and host Serial(rtscts=False) + setRTS(False).
        self.flow = flow  # "none" | "rtscts"
        self.flow_ctrl = FLOW_RTSCTS if flow == "rtscts" else FLOW_NONE
        self.ser: Optional[serial.Serial] = None
        self.loader_ready = False

    def open(self, baud: Optional[int] = None, rtscts: bool = False) -> None:
        self.close()
        rate = BOOT_BAUD if baud is None else baud
        # Same as burn: open without HW flow; RTS is free for reset / held low.
        self.ser = serial.Serial(
            self.port,
            rate,
            timeout=0.2,
            write_timeout=5,
            rtscts=rtscts,
            xonxoff=False,
            dsrdtr=False,
        )
        self._hold_rts_low()
        flow_txt = "rtscts" if rtscts else "none"
        log.info("Serial: %s @ %d (flow=%s)", self.port, rate, flow_txt)

    def _hold_rts_low(self) -> None:
        """burn: ser.setRTS(False) — keep RTS deasserted except during reset pulse."""
        ser = self.ser
        if ser is None:
            return
        try:
            ser.dtr = False
            ser.rts = False
            ser.setRTS(False)
        except Exception:
            pass

    def set_flow(self, enable: bool) -> None:
        """Enable/disable host RTS/CTS after baud switch (optional override)."""
        ser = self._require()
        try:
            ser.rtscts = bool(enable)
        except Exception as exc:
            raise HistoolError(f"failed to set rtscts={enable}: {exc}") from exc
        if enable:
            log.info("Hardware flow control enabled (RTS/CTS)")
        else:
            self._hold_rts_low()

    def close(self) -> None:
        if self.ser is not None:
            try:
                self.ser.rtscts = False
            except Exception:
                pass
            try:
                self.ser.close()
            except Exception:
                pass
            self.ser = None
        self.loader_ready = False

    def _require(self) -> serial.Serial:
        if self.ser is None or not self.ser.is_open:
            raise HistoolError("serial port is not open")
        return self.ser

    def _dump(self, direction: str, data: bytes) -> None:
        if not self.trace:
            return
        hexstr = " ".join(f"{b:02x}" for b in data[:64])
        extra = "" if len(data) <= 64 else f" ... ({len(data)} bytes)"
        log.debug("%s %s%s", direction, hexstr, extra)

    def pulse_reset(self) -> None:
        """Reset via flow-control: RTS 拉低再拉高 (host must own RTS)."""
        ser = self._require()
        try:
            if ser.rtscts:
                ser.rtscts = False
                time.sleep(0.02)
        except Exception:
            pass
        try:
            ser.dtr = True
            ser.rts = True  # 拉低
            time.sleep(0.1)
            ser.rts = False  # 拉高
            ser.dtr = False
            time.sleep(0.05)
        except Exception:
            pass

    def send_cmd(self, cmd: int, payload: bytes) -> None:
        frame = build_frame(cmd, payload)
        self._dump(">", frame)
        ser = self._require()
        ser.write(frame)
        ser.flush()

    def read_frame(self, timeout: float = 5.0) -> Tuple[int, bytes]:
        ser = self._require()
        magic = bytes([0xEF, 0xBE, 0xAD, 0xDE])
        buf = bytearray()
        deadline = time.time() + timeout
        old = ser.timeout
        ser.timeout = 0.1
        try:
            while time.time() < deadline:
                b = ser.read(1)
                if not b:
                    continue
                buf.extend(b)
                if len(buf) < 4:
                    # resync on magic
                    if not magic.startswith(bytes(buf)):
                        buf.clear()
                    continue
                if bytes(buf[:4]) != magic:
                    # keep last 3 bytes for overlap
                    buf[:] = buf[-3:]
                    continue
                if len(buf) < 6:
                    continue
                framelen = struct.unpack_from("<H", buf, 4)[0]
                if framelen < 10 or framelen > 1036:
                    buf.clear()
                    continue
                while len(buf) < framelen and time.time() < deadline:
                    more = ser.read(framelen - len(buf))
                    if more:
                        buf.extend(more)
                if len(buf) < framelen:
                    raise HistoolError("timeout reading HiBurn frame")
                frame = bytes(buf[:framelen])
                self._dump("<", frame)
                return parse_frame(frame)
        finally:
            ser.timeout = old
        raise HistoolError("timeout waiting HiBurn frame")

    def wait_ack(self, timeout: float = 8.0) -> bytes:
        cmd, payload = self.read_frame(timeout=timeout)
        if cmd != ACK_TYPE:
            raise HistoolError(f"expected ACK, got cmd 0x{cmd:02x}")
        if payload and payload[0] not in (ACK_SUCCESS, 0x00):
            # handshake ACK uses 0x5A; some frames only match prefix
            if payload[0] == 0xA5:
                raise HistoolError("device NACK (0xA5)")
        return payload

    def handshake(self, before: str = "default-reset") -> None:
        """Enter ROM download: host @115200, device resets into hiburn.

        Reset policy (default-reset): RTS 拉低→拉高, then handshake for 2s;
        if no ACK, reset again. On ACK, switch baud and return to flash.
        """
        self.open(BOOT_BAUD, rtscts=False)
        ser = self._require()
        payload = self.baud.to_bytes(4, "little") + handshake_uart_cfg(self.flow_ctrl)
        log.info(
            "Waiting for ROM download (timeout %.0fs, flow=%s)...",
            self.connect_timeout,
            self.flow,
        )
        deadline = time.time() + self.connect_timeout

        def _try_handshake_window(window_s: float) -> bool:
            """Spam handshake for window_s; return True on ACK."""
            acc = bytearray()
            end = time.time() + window_s
            while time.time() < end and time.time() < deadline:
                self.send_cmd(CMD_HANDSHAKE, payload)
                time.sleep(0.05)
                chunk = ser.read(ser.in_waiting or 1)
                if not chunk:
                    continue
                acc.extend(chunk)
                self._dump("<", bytes(chunk))
                if ACK_PREFIX in acc:
                    return True
                if len(acc) > 4096:
                    acc = acc[-64:]
            return False

        def _on_handshake_ok() -> None:
            ser.baudrate = self.baud
            if self.flow_ctrl == FLOW_RTSCTS:
                self.set_flow(True)
            else:
                self._hold_rts_low()
            time.sleep(0.3)
            ser.reset_input_buffer()
            log.info(
                "Handshake OK, switched to %d baud (flow=%s) — start flash",
                self.baud,
                self.flow,
            )

        if before == "default-reset":
            while time.time() < deadline:
                self.pulse_reset()
                ser.reset_input_buffer()
                if _try_handshake_window(2.0):
                    _on_handshake_ok()
                    return
        else:
            log.info("no-reset: waiting for manual reset into download mode...")
            if _try_handshake_window(max(0.0, deadline - time.time())):
                _on_handshake_ok()
                return

        raise HistoolError(
            "handshake timeout: reset the chip while this command is running"
        )

    def load_loaderboot(self, image: FwpkgImage) -> None:
        log.info("Downloading loaderboot %s (%d bytes) via Ymodem...", image.name, image.length)
        send_image(self._require(), image)
        try:
            self.wait_ack(timeout=10.0)
        except HistoolError as exc:
            log.warning("no ACK after loaderboot (%s), continuing", exc)
        self.loader_ready = True
        log.info("Loaderboot is running")

    def connect_loader(
        self,
        loader: Union[str, FwpkgImage],
        before: str = "default-reset",
    ) -> None:
        if isinstance(loader, FwpkgImage):
            image = loader
        else:
            if loader.lower().endswith(".fwpkg"):
                pkg = Fwpkg(loader)
                image = pkg.loaderboot()
                if image is None:
                    raise HistoolError("fwpkg has no type-0 loaderboot image")
            else:
                image = as_image_from_bin(loader, burn_addr=0, typ=TYPE_LOADERBOOT)
        self.handshake(before=before)
        self.load_loaderboot(image)

    def download_image(self, image: FwpkgImage, erase_size: Optional[int] = None) -> None:
        if erase_size is None:
            erase_size = align_erase(image.length)
        payload = (
            image.burn_addr.to_bytes(4, "little")
            + image.length.to_bytes(4, "little")
            + int(erase_size).to_bytes(4, "little")
            + bytes([0x00, 0xFF])
        )
        log.info(
            "flash %s -> 0x%08x (%d bytes, erase 0x%x)",
            image.name,
            image.burn_addr,
            image.length,
            erase_size,
        )
        ser = self._require()
        ser.reset_input_buffer()
        self.send_cmd(CMD_DL_IMAGE, payload)
        # Large regions need longer erase before loader ACKs and starts Ymodem.
        erase_timeout = 120.0 if erase_size >= 0x100000 else 30.0
        self.wait_ack(timeout=erase_timeout)
        ser.reset_input_buffer()
        send_image(ser, image)
        try:
            self.wait_ack(timeout=8.0)
        except HistoolError:
            pass
        time.sleep(0.1)

    def erase_flash(self) -> None:
        payload = (
            (0).to_bytes(4, "little")
            + (0).to_bytes(4, "little")
            + FLASH_CHIP_ERASE.to_bytes(4, "little")
            + bytes([0x00, 0xFF])
        )
        log.info("erase-flash (chip erase 0xFFFFFFFF)")
        self.send_cmd(CMD_DL_IMAGE, payload)
        self.wait_ack(timeout=120.0)

    def read_flash(self, address: int, size: int, out_path: str) -> int:
        if size <= 0 or size > FLASH_MEM_SIZE:
            raise HistoolError("invalid read size")
        if address & 0x3:
            raise HistoolError("read address must be 4-byte aligned")
        payload = size.to_bytes(4, "little") + address.to_bytes(4, "little")
        log.info("read-flash 0x%08x +%d -> %s", address, size, out_path)
        self.send_cmd(CMD_UL_DATA, payload)
        self.wait_ack(timeout=10.0)
        n = receive_to_file(self._require(), out_path, expected_len=size)
        log.info("read %d bytes", n)
        return n

    def reset(self) -> None:
        """Leave loaderboot: protocol reset, then RTS/DTR hardware reset."""
        log.info("reset (protocol + flow-control)")
        try:
            self.send_cmd(CMD_RESET, b"\x00\x00")
            try:
                self.wait_ack(timeout=3.0)
            except HistoolError:
                pass
        except HistoolError as exc:
            log.warning("protocol reset failed (%s), doing flow-control reset", exc)
        # Always take ownership of RTS/DTR and reboot into application.
        try:
            self.pulse_reset()
        except HistoolError:
            pass
        self.loader_ready = False

    def flash_fwpkg(self, path: str, before: str = "default-reset", after: str = "hard-reset") -> None:
        try:
            pkg = Fwpkg(path)
        except ValueError as exc:
            raise HistoolError(str(exc)) from exc
        loader = pkg.loaderboot()
        if loader is None:
            raise HistoolError("fwpkg has no loaderboot (type 0)")
        print(pkg.format_table())
        self.connect_loader(loader, before=before)
        for img in pkg.flash_images():
            self.download_image(img)
        if after == "hard-reset":
            self.reset()
            log.info("Done")
        elif after == "no-reset":
            log.info("Done (loader still running, no reset)")
        else:
            self.reset()
            log.info("Done")

    def flash_bins(
        self,
        pairs: Sequence[Tuple[int, str]],
        loader: str,
        before: str = "default-reset",
        after: str = "hard-reset",
    ) -> None:
        self.connect_loader(loader, before=before)
        for addr, path in pairs:
            img = as_image_from_bin(path, burn_addr=addr, typ=TYPE_FLASH)
            self.download_image(img)
        if after != "no-reset":
            self.reset()
        log.info("Done")
