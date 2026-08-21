"""Serial console (idf.py monitor / miniterm style)."""

from __future__ import annotations

import select
import sys
import time
from datetime import datetime
from typing import Optional, Tuple

import serial


EXIT_HINT = "Ctrl+] to exit"


def _timestamp() -> str:
    return datetime.now().strftime("%H:%M:%S.%f")[:-3]


def _pulse_reset(ser: serial.Serial) -> None:
    """Toggle RTS/DTR so USB-UART boards reboot the chip and dump boot logs."""
    try:
        ser.rts = True
        time.sleep(0.1)
        ser.rts = False
        time.sleep(0.05)
        ser.dtr = True
        time.sleep(0.05)
        ser.dtr = False
    except Exception:
        pass


def _rstrip_line_spaces(out: bytearray) -> None:
    while out and out[-1] in (0x20, 0x09):
        out.pop()


def _format_serial_bytes(
    chunk: bytes,
    line_start: bool,
    timestamps: bool,
    pending_cr: bool,
    at_col0: bool,
) -> Tuple[bytes, bool, bool, bool]:
    """Prefix timestamps; only 0d 0a starts a new timestamped log line.

    Display rules (raw tty has no ONLCR):
    - Emit CRLF for every LF so the cursor returns to column 0.
    - Do not print a timestamp until real content arrives (no ``[ts]``-only lines).
    - Collapse consecutive blank lines; drop leading spaces at column 0;
      strip trailing spaces before a newline.
    - Lone 0a is display-only (left-align), not a timestamp boundary.
    """
    out = bytearray()
    i = 0
    n = len(chunk)

    def emit_display_newline(*, log_break: bool) -> None:
        nonlocal line_start, at_col0
        if at_col0:
            if log_break:
                line_start = True
            return
        _rstrip_line_spaces(out)
        out.extend(b"\r\n")
        at_col0 = True
        if log_break:
            line_start = True

    while i < n:
        b = chunk[i]
        if pending_cr:
            pending_cr = False
            if b == 0x0A:
                emit_display_newline(log_break=True)
                i += 1
                continue
            # Lone CR: treat as log line break for alignment.
            emit_display_newline(log_break=True)
            # fall through to handle current byte
        if b == 0x0D:
            pending_cr = True
            i += 1
            continue
        if b == 0x0A:
            # Lone LF: fix cursor only; do not open a new timestamped line.
            emit_display_newline(log_break=False)
            i += 1
            continue
        if at_col0 and b in (0x20, 0x09):
            i += 1
            continue
        if line_start:
            if timestamps:
                out.extend(f"[{_timestamp()}] ".encode("ascii"))
            line_start = False
        at_col0 = False
        out.append(b)
        i += 1
    return bytes(out), line_start, pending_cr, at_col0


def run_monitor(
    port: str,
    baud: int = 115200,
    timestamps: bool = True,
    reopen_delay: float = 0.2,
    reset: bool = True,
    duration: Optional[float] = None,
) -> int:
    """Open UART console. If duration is set, exit after that many seconds."""
    print(f"--- histool monitor {port} {baud} baud --- {EXIT_HINT} ---", flush=True)
    time.sleep(reopen_delay)

    ser = serial.Serial(port, baud, timeout=0.05)
    try:
        try:
            ser.dtr = False
            ser.rts = False
        except Exception:
            pass

        if reset:
            print("--- resetting device to capture boot log ---", flush=True)
            _pulse_reset(ser)
            # Some USB-CDC stacks drop the handle across RTS/DTR; reopen quickly.
            try:
                ser.close()
            except Exception:
                pass
            time.sleep(0.15)
            ser = serial.Serial(port, baud, timeout=0.05)
            try:
                ser.dtr = False
                ser.rts = False
            except Exception:
                pass
            # If the first pulse did not reboot (stale handle), pulse once more.
            _pulse_reset(ser)

        line_start = True
        pending_cr = False
        at_col0 = True
        deadline = time.time() + duration if duration is not None else None
        use_stdin = sys.stdin.isatty() and duration is None
        old_term = None
        if use_stdin:
            try:
                import termios
                import tty

                fd = sys.stdin.fileno()
                old_term = (fd, termios.tcgetattr(fd), termios)
                tty.setraw(fd)
            except Exception:
                use_stdin = False
                old_term = None

        try:
            while True:
                if deadline is not None and time.time() >= deadline:
                    break

                # Serial RX
                try:
                    waiting = ser.in_waiting
                    data = ser.read(waiting if waiting else 1)
                except serial.SerialException as exc:
                    print(f"\r\n--- serial error: {exc}, reopening ---", flush=True)
                    try:
                        ser.close()
                    except Exception:
                        pass
                    time.sleep(0.5)
                    ser = serial.Serial(port, baud, timeout=0.05)
                    line_start = True
                    pending_cr = False
                    at_col0 = True
                    continue

                if data:
                    formatted, line_start, pending_cr, at_col0 = _format_serial_bytes(
                        data, line_start, timestamps, pending_cr, at_col0
                    )
                    if formatted:
                        sys.stdout.buffer.write(formatted)
                        sys.stdout.buffer.flush()

                # Keyboard (optional)
                if use_stdin:
                    r, _, _ = select.select([sys.stdin], [], [], 0)
                    if r:
                        ch = sys.stdin.read(1)
                        if not ch:
                            continue
                        code = ord(ch)
                        if code in (0x1D, 0x03):  # Ctrl+] / Ctrl+C
                            break
                        try:
                            ser.write(ch.encode("latin-1", errors="ignore"))
                        except serial.SerialException:
                            break
        except KeyboardInterrupt:
            pass
        finally:
            if old_term is not None:
                fd, attrs, termios = old_term
                termios.tcsetattr(fd, termios.TCSADRAIN, attrs)
    finally:
        try:
            ser.close()
        except Exception:
            pass
        print("\n--- exit monitor ---", flush=True)
    return 0
