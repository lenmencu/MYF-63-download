"""esptool-like CLI for HiSilicon WS63 / BS2X."""

from __future__ import annotations

import argparse
import logging
import os
import sys
from typing import List, Optional, Sequence, Tuple

from . import __version__
from .chip import (
    AVAIL_BAUD,
    detect_chip_from_path,
    resolve_baud,
    resolve_chip,
    resolve_flow,
)
from .fwpkg import Fwpkg
from .hiburn import HistoolError, Ws63Device, list_serial_ports
from .monitor import run_monitor
from .ymodem import YmodemError

PROG = "histool"

BEFORE_CHOICES = ("default-reset", "no-reset")
AFTER_CHOICES = ("hard-reset", "no-reset", "monitor")


def _add_before_after(parser: argparse.ArgumentParser, *, defaults: bool) -> None:
    """Allow --before/--after before or after the subcommand (esptool-style)."""
    kw_before = {"choices": BEFORE_CHOICES, "help": "reset sequence before connecting"}
    kw_after = {
        "choices": AFTER_CHOICES,
        "help": "what to do after flashing",
    }
    if defaults:
        kw_before["default"] = "default-reset"
        kw_after["default"] = "hard-reset"
    else:
        # Only override parent values when the flag appears after the subcommand.
        kw_before["default"] = argparse.SUPPRESS
        kw_after["default"] = argparse.SUPPRESS
    parser.add_argument("--before", **kw_before)
    parser.add_argument("--after", "-a", **kw_after)



def _configure_logging(verbose: bool, silent: bool) -> None:
    if silent:
        level = logging.ERROR
    elif verbose:
        level = logging.DEBUG
    else:
        level = logging.INFO
    logging.basicConfig(level=level, format="%(message)s")


def _need_port(args: argparse.Namespace) -> str:
    if args.port:
        return args.port
    ports = list_serial_ports()
    raise SystemExit(
        "serial port required: use -p /dev/ttyACM0\n"
        f"detected: {', '.join(ports) if ports else '(none)'}"
    )


def _parse_int(text: str) -> int:
    return int(text, 0)


def _parse_addr_file_pairs(items: Sequence[str]) -> Tuple[Optional[str], List[Tuple[int, str]]]:
    """Accept either a single .fwpkg, or repeating <addr> <file> pairs."""
    if len(items) == 1:
        return items[0], []
    if len(items) % 2 != 0:
        raise SystemExit("flash expects a .fwpkg or repeating <address> <file> pairs")
    pairs = []
    for i in range(0, len(items), 2):
        addr = _parse_int(items[i])
        path = items[i + 1]
        if not os.path.isfile(path):
            raise SystemExit(f"file not found: {path}")
        pairs.append((addr, path))
    return None, pairs


def _firmware_hints(args: argparse.Namespace) -> List[Optional[str]]:
    hints: List[Optional[str]] = []
    if getattr(args, "images", None):
        fwpkg, pairs = _parse_addr_file_pairs(args.images)
        if fwpkg:
            hints.append(fwpkg)
        hints.extend(p for _, p in pairs)
    if getattr(args, "loader", None):
        hints.append(args.loader)
    if getattr(args, "firmware", None):
        hints.append(args.firmware)
    return hints


def _apply_chip_defaults(args: argparse.Namespace) -> None:
    """Fill chip / baud / flow from path when user left them as auto/default."""
    hints = _firmware_hints(args)
    profile = resolve_chip(getattr(args, "chip", "auto"), *hints)
    args.chip_profile = profile
    args.chip = profile.name
    args.baud = resolve_baud(getattr(args, "baud", None), profile)
    args.flow = resolve_flow(getattr(args, "flow", None), profile)
    if args.baud not in AVAIL_BAUD:
        logging.getLogger("histool").warning(
            "baud %d not in burn-tool AVAIL_BAUD %s (continuing)",
            args.baud,
            list(AVAIL_BAUD),
        )


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog=PROG,
        description=(
            "Serial utility for flashing and monitoring HiSilicon WS63 / BS2X "
            "(HiBurn + Ymodem), similar to Espressif esptool."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
examples:
  %(prog)s -p /dev/ttyACM0 flash output/ws63/fwpkg/ws63-liteos-app/ws63-liteos-app_all.fwpkg
  %(prog)s -p /dev/ttyACM0 flash output/bs20/fwpkg/standard-bs20-n1200/bs20_all_in_one.fwpkg
  %(prog)s -p /dev/ttyACM0 flash output/bs21e/fwpkg/standard-bs21e-1100/bs20_all_in_one.fwpkg
  %(prog)s -p /dev/ttyACM0 -b 1000000 flash fw.fwpkg --after monitor
  %(prog)s image-info fw.fwpkg
  %(prog)s -p /dev/ttyACM0 monitor
""".replace("%(prog)s", PROG),
    )
    p.add_argument("-p", "--port", help="serial port device, e.g. /dev/ttyACM0")
    p.add_argument(
        "-b",
        "--baud",
        type=int,
        default=None,
        help=(
            "download baud after handshake "
            f"(default: ws63={1000000}, bs2x={500000}; "
            f"tested: {', '.join(str(b) for b in AVAIL_BAUD)})"
        ),
    )
    p.add_argument(
        "-c",
        "--chip",
        default="auto",
        help="target chip: auto|ws63|bs20|bs21|bs21e|bs2x (auto = detect from fwpkg path)",
    )
    _add_before_after(p, defaults=True)
    p.add_argument("-t", "--trace", action="store_true", help="hex-dump HiBurn frames")
    p.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    p.add_argument("-s", "--silent", action="store_true", help="only print errors")
    p.add_argument(
        "--connect-timeout",
        type=float,
        default=15.0,
        help="seconds to wait for ROM handshake",
    )
    p.add_argument(
        "--flow",
        choices=["rtscts", "none"],
        default=None,
        help="UART HW flow (default: none, same as burn; use rtscts only if CTS wired)",
    )
    p.add_argument("--version", action="store_true", help="print histool version and exit")

    sub = p.add_subparsers(dest="command")

    flash = sub.add_parser(
        "flash",
        aliases=["write-flash"],
        help="write fwpkg or raw binaries to flash (loads loaderboot first)",
    )
    _add_before_after(flash, defaults=False)
    flash.add_argument(
        "--loader",
        help="fwpkg or loaderboot.bin required when flashing raw address/file pairs",
    )
    flash.add_argument(
        "images",
        nargs="+",
        help=".fwpkg path, or <address> <file> pairs",
    )

    info = sub.add_parser("image-info", help="print fwpkg partition table")
    info.add_argument("firmware", help=".fwpkg file")

    mon = sub.add_parser("monitor", help="open serial console for device logs")
    mon.add_argument(
        "--monitor-baud",
        type=int,
        default=115200,
        help="console baud (default 115200, typical app UART)",
    )
    mon.add_argument("--no-timestamps", action="store_true", help="disable timestamps")
    mon.add_argument(
        "--no-reset",
        action="store_true",
        help="do not pulse RTS/DTR on start (default: reset to print boot log)",
    )
    mon.add_argument(
        "--duration",
        type=float,
        default=None,
        help="auto-exit after N seconds (useful for scripts/tests)",
    )

    erase = sub.add_parser("erase-flash", help="chip-erase via loaderboot")
    _add_before_after(erase, defaults=False)
    erase.add_argument("--loader", required=True, help="fwpkg or loaderboot.bin")

    rdf = sub.add_parser("read-flash", help="read flash via loaderboot Ymodem upload")
    _add_before_after(rdf, defaults=False)
    rdf.add_argument("--loader", required=True, help="fwpkg or loaderboot.bin")
    rdf.add_argument("address", help="flash offset (hex or decimal)")
    rdf.add_argument("size", help="bytes to read")
    rdf.add_argument("output", help="output file")

    rst = sub.add_parser("reset", help="reset chip after connecting loaderboot")
    _add_before_after(rst, defaults=False)
    rst.add_argument("--loader", required=True, help="fwpkg or loaderboot.bin")

    sub.add_parser("version", help="print histool version")
    ports = sub.add_parser("flash-id", help="list serial ports (chip ID is not in ROM protocol)")
    _ = ports

    return p


def _maybe_monitor(args: argparse.Namespace) -> int:
    port = _need_port(args)
    baud = getattr(args, "monitor_baud", 115200)
    if args.command != "monitor":
        baud = 115200
    do_reset = not getattr(args, "no_reset", False)
    return run_monitor(
        port,
        baud=baud,
        timestamps=not getattr(args, "no_timestamps", False),
        reset=do_reset,
        duration=getattr(args, "duration", None),
    )


def _run_device(args: argparse.Namespace) -> Ws63Device:
    return Ws63Device(
        port=_need_port(args),
        baud=args.baud,
        connect_timeout=args.connect_timeout,
        trace=args.trace,
        flow=args.flow,
    )


def main(argv: Optional[Sequence[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.version or args.command == "version":
        print(f"histool {__version__} (HiSilicon WS63/BS2X)")
        return 0

    _configure_logging(args.verbose, args.silent)
    log = logging.getLogger("histool")

    try:
        if args.command is None:
            parser.print_help()
            return 1

        # Resolve chip/baud/flow before device ops (and for image-info logging)
        if args.command not in ("flash-id",):
            try:
                _apply_chip_defaults(args)
            except ValueError as exc:
                raise HistoolError(str(exc)) from exc
            log.info(
                "histool v%s — chip %s (family=%s) baud=%d flow=%s",
                __version__,
                args.chip,
                args.chip_profile.family,
                args.baud,
                args.flow,
            )
        else:
            log.info("histool v%s", __version__)

        if args.command == "image-info":
            detected = detect_chip_from_path(args.firmware)
            try:
                pkg = Fwpkg(args.firmware)
            except ValueError as exc:
                raise HistoolError(str(exc)) from exc
            print(pkg.format_table())
            print(f"file: {pkg.path}")
            print(f"images: {pkg.count}  total: {pkg.total_size} bytes")
            if detected:
                print(f"detected chip: {detected}")
            return 0

        if args.command == "monitor":
            return _maybe_monitor(args)

        if args.command == "flash-id":
            ports = list_serial_ports()
            print("serial ports:")
            for p in ports or ["(none)"]:
                print(f"  {p}")
            return 0

        if args.command in ("flash", "write-flash"):
            fwpkg, pairs = _parse_addr_file_pairs(args.images)
            dev = _run_device(args)
            after = "no-reset" if args.after == "monitor" else args.after
            try:
                if fwpkg:
                    if not os.path.isfile(fwpkg):
                        raise HistoolError(f"file not found: {fwpkg}")
                    dev.flash_fwpkg(fwpkg, before=args.before, after=after)
                else:
                    loader = args.loader or fwpkg
                    if not loader:
                        raise HistoolError(
                            "raw flash needs --loader pointing to an .fwpkg (or loaderboot.bin)"
                        )
                    dev.flash_bins(pairs, loader, before=args.before, after=after)
            finally:
                dev.close()
            if args.after == "monitor":
                return _maybe_monitor(args)
            return 0

        if args.command == "erase-flash":
            dev = _run_device(args)
            try:
                dev.connect_loader(args.loader, before=args.before)
                dev.erase_flash()
                if args.after != "no-reset":
                    dev.reset()
            finally:
                dev.close()
            return 0

        if args.command == "read-flash":
            dev = _run_device(args)
            try:
                dev.connect_loader(args.loader, before=args.before)
                dev.read_flash(_parse_int(args.address), _parse_int(args.size), args.output)
                if args.after != "no-reset":
                    dev.reset()
            finally:
                dev.close()
            return 0

        if args.command == "reset":
            dev = _run_device(args)
            try:
                dev.connect_loader(args.loader, before=args.before)
                dev.reset()
            finally:
                dev.close()
            return 0

        parser.print_help()
        return 1
    except (HistoolError, YmodemError, OSError) as exc:
        logging.getLogger("histool").error("%s", exc)
        return 2


if __name__ == "__main__":
    sys.exit(main())
