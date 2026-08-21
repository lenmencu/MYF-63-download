"""Parse HiSilicon all-in-one .fwpkg packages."""

from __future__ import annotations

import os
import struct
from dataclasses import dataclass
from typing import List, Optional

from .crc16 import crc16

FWPKG_MAGIC = 0xEFBEADDF
MAX_IMAGES = 16
HEADER_FMT = "<IHHI"
IMAGE_FMT = "<32sIIIII"
IMAGE_INFO_SIZE = struct.calcsize(IMAGE_FMT)

# fwpkg type field: 0 = RAM loaderboot, 1 = flash image
TYPE_LOADERBOOT = 0
TYPE_FLASH = 1


@dataclass
class FwpkgImage:
    name: str
    offset: int
    length: int
    burn_addr: int
    burn_size: int
    type: int
    path: str

    def read_bytes(self) -> bytes:
        with open(self.path, "rb") as f:
            f.seek(self.offset)
            data = f.read(self.length)
        if len(data) != self.length:
            raise ValueError(f"truncated image {self.name}")
        return data


class Fwpkg:
    def __init__(self, path: str) -> None:
        self.path = os.path.abspath(path)
        self.magic = 0
        self.crc = 0
        self.count = 0
        self.total_size = 0
        self.images: List[FwpkgImage] = []
        self._parse()

    def _parse(self) -> None:
        with open(self.path, "rb") as f:
            header = f.read(struct.calcsize(HEADER_FMT))
            if len(header) < struct.calcsize(HEADER_FMT):
                raise ValueError("fwpkg header too short")
            self.magic, self.crc, self.count, self.total_size = struct.unpack(
                HEADER_FMT, header
            )
            if self.magic != FWPKG_MAGIC:
                raise ValueError(
                    f"invalid fwpkg magic 0x{self.magic:08x} (expected 0x{FWPKG_MAGIC:08x})"
                )
            if self.count > MAX_IMAGES:
                raise ValueError(f"too many images: {self.count}")

            infos = f.read(self.count * IMAGE_INFO_SIZE)
            if len(infos) != self.count * IMAGE_INFO_SIZE:
                raise ValueError("fwpkg image table truncated")

            # CRC covers FWPKG_HEAD.imageNum through the image table
            # (offset 6 to end of header+table), same as packet_create.py.
            f.seek(0)
            table = f.read(12 + self.count * IMAGE_INFO_SIZE)
            got = crc16(table[6:])
            if got != self.crc:
                raise ValueError(
                    f"fwpkg CRC mismatch: file=0x{self.crc:04x} calc=0x{got:04x}"
                )

        for i in range(self.count):
            chunk = infos[i * IMAGE_INFO_SIZE : (i + 1) * IMAGE_INFO_SIZE]
            raw_name, offset, length, burn_addr, burn_size, typ = struct.unpack(
                IMAGE_FMT, chunk
            )
            name = raw_name.split(b"\x00", 1)[0].decode("ascii", errors="replace")
            self.images.append(
                FwpkgImage(
                    name=name,
                    offset=offset,
                    length=length,
                    burn_addr=burn_addr,
                    burn_size=burn_size,
                    type=typ,
                    path=self.path,
                )
            )

    def loaderboot(self) -> Optional[FwpkgImage]:
        for img in self.images:
            if img.type == TYPE_LOADERBOOT:
                return img
        return None

    def flash_images(self) -> List[FwpkgImage]:
        return [img for img in self.images if img.type == TYPE_FLASH]

    def summary_rows(self) -> List[List[str]]:
        rows = []
        for img in self.images:
            flag = "RAM" if img.type == TYPE_LOADERBOOT else "FLASH"
            rows.append(
                [
                    flag,
                    img.name,
                    f"0x{img.offset:08x}",
                    f"0x{img.length:08x} ({img.length})",
                    f"0x{img.burn_addr:08x}",
                    f"0x{img.burn_size:08x}",
                    str(img.type),
                ]
            )
        return rows

    def format_table(self) -> str:
        headers = [
            "KIND",
            "NAME",
            "FILE OFF",
            "SIZE",
            "BURN ADDR",
            "BURN SIZE",
            "T",
        ]
        rows = [headers] + self.summary_rows()
        widths = [max(len(r[i]) for r in rows) for i in range(len(headers))]
        lines = []
        for idx, row in enumerate(rows):
            line = "  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row))
            lines.append(line)
            if idx == 0:
                lines.append("  ".join("-" * w for w in widths))
        return "\n".join(lines)


def as_image_from_bin(path: str, burn_addr: int = 0, typ: int = TYPE_FLASH) -> FwpkgImage:
    size = os.path.getsize(path)
    return FwpkgImage(
        name=os.path.basename(path),
        offset=0,
        length=size,
        burn_addr=burn_addr,
        burn_size=size,
        type=typ,
        path=os.path.abspath(path),
    )
