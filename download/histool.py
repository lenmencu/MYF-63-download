#!/usr/bin/env python3
"""
histool — HiSilicon WS63 / BS2X flash / monitor (esptool-like).

Chip/baud auto-detected from firmware path (ws63→1M, bs2x→500k); flow matches burn (none).

Usage:
  python3 histool.py -p /dev/ttyACM0 flash output/ws63/.../ws63-liteos-app_all.fwpkg
  python3 histool.py -p /dev/ttyACM0 flash output/bs20/.../bs20_all_in_one.fwpkg
  python3 histool.py -p /dev/ttyACM0 monitor
"""

from __future__ import annotations

import os
import sys

# Avoid importing this file as the `histool` package when run as a script.
if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    if here in sys.path:
        sys.path.remove(here)
    sys.path.insert(0, here)

from hisboot.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
