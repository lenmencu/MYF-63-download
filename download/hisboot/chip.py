"""Chip family detection and flash defaults (baud / flow)."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Optional

# Baud rates known usable with HiBurn / burn-tool adapters
AVAIL_BAUD = (
    115200,
    230400,
    460800,
    500000,
    576000,
    921600,
    1000000,
    1152000,
    1500000,
    2000000,
)

CHIP_WS63 = "ws63"
CHIP_BS20 = "bs20"
CHIP_BS21 = "bs21"
CHIP_BS21E = "bs21e"
CHIP_BS2X = "bs2x"  # family alias covering bs20/bs21/bs21e

WS63_CHIPS = frozenset({CHIP_WS63})
BS2X_CHIPS = frozenset({CHIP_BS20, CHIP_BS21, CHIP_BS21E, CHIP_BS2X})


@dataclass(frozen=True)
class ChipProfile:
    name: str
    family: str  # "ws63" | "bs2x"
    default_baud: int
    default_flow: str  # "rtscts" | "none"

    @property
    def is_bs2x(self) -> bool:
        return self.family == "bs2x"


# Flow defaults match burn (xf_burn_tools): handshake flow_ctrl=0, host rtscts off,
# RTS held low via setRTS(False). Optional --flow rtscts is an override only.
PROFILES = {
    CHIP_WS63: ChipProfile(CHIP_WS63, "ws63", 1000000, "none"),
    # BS2X: lower default baud — CH340-class adapters often fail Ymodem at 1M
    CHIP_BS20: ChipProfile(CHIP_BS20, "bs2x", 500000, "none"),
    CHIP_BS21: ChipProfile(CHIP_BS21, "bs2x", 500000, "none"),
    CHIP_BS21E: ChipProfile(CHIP_BS21E, "bs2x", 500000, "none"),
    CHIP_BS2X: ChipProfile(CHIP_BS2X, "bs2x", 500000, "none"),
}


def normalize_chip(name: str) -> str:
    n = name.strip().lower().replace("_", "-")
    aliases = {
        "ws63e": CHIP_WS63,
        "ws63": CHIP_WS63,
        "bs20": CHIP_BS20,
        "bs21": CHIP_BS21,
        "bs21e": CHIP_BS21E,
        "bs2x": CHIP_BS2X,
        "bs2": CHIP_BS2X,
    }
    if n not in aliases:
        raise ValueError(
            f"unknown chip '{name}', expected one of: "
            + ", ".join(sorted(set(aliases)))
        )
    return aliases[n]


def detect_chip_from_path(path: Optional[str]) -> Optional[str]:
    """Infer chip from firmware path, e.g. output/ws63/... or output/bs21e/..."""
    if not path:
        return None
    text = os.path.normpath(path).replace("\\", "/").lower()
    # Prefer path segments: .../bs21e/fwpkg/... or .../ws63/fwpkg/...
    parts = text.split("/")
    for key in (CHIP_BS21E, CHIP_BS21, CHIP_BS20, CHIP_WS63):
        if key in parts:
            return key
    # Filename / dirname heuristics
    for key in (CHIP_BS21E, "bs21e", CHIP_BS21, CHIP_BS20, CHIP_WS63, "ws63"):
        if re.search(rf"(^|[^a-z0-9]){re.escape(key)}([^a-z0-9]|$)", text):
            return normalize_chip(key if key != "ws63" else CHIP_WS63)
    return None


def resolve_chip(
    chip_arg: str,
    *paths: Optional[str],
) -> ChipProfile:
    """
    Resolve chip profile.
    - chip_arg 'auto': detect from firmware paths, else ws63
    - otherwise use explicit chip name (path is ignored unless auto)
    """
    arg = (chip_arg or "auto").strip().lower()
    if arg in ("auto", ""):
        for p in paths:
            detected = detect_chip_from_path(p)
            if detected:
                return PROFILES[detected]
        return PROFILES[CHIP_WS63]
    name = normalize_chip(arg)
    return PROFILES[name]


def resolve_baud(cli_baud: Optional[int], profile: ChipProfile) -> int:
    if cli_baud is not None:
        return int(cli_baud)
    return profile.default_baud


def resolve_flow(cli_flow: Optional[str], profile: ChipProfile) -> str:
    if cli_flow is not None:
        return cli_flow
    return profile.default_flow
