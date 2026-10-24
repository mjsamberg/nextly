#!/usr/bin/env python3
"""Turns a WOFF 1.0 font into the TrueType/OpenType file inside it.

The native apps bundle the district's fonts (Oswald for headings, Mulish for
body text; both SIL Open Font License) from the same @fontsource packages the
Tauri app uses, which ship WOFF. Apple's font APIs want TTF/OTF.

  python3 apple/scripts/woff-to-ttf.py in.woff out.ttf
"""

import struct
import sys
import zlib


def convert(src: bytes) -> bytes:
    sig, flavor, _length, num_tables = struct.unpack(">4sIIH", src[:14])
    if sig != b"wOFF":
        raise SystemExit("not a WOFF 1.0 file")
    entries = []
    for i in range(num_tables):
        tag, offset, comp_len, orig_len, checksum = struct.unpack(">4sIIII", src[44 + 20 * i: 64 + 20 * i])
        data = src[offset: offset + comp_len]
        if comp_len < orig_len:
            data = zlib.decompress(data)
        entries.append((tag, checksum, data))

    # sfnt header: search range fields come from the table count.
    power = 1
    while power * 2 <= num_tables:
        power *= 2
    header = struct.pack(">IHHHH", flavor, num_tables, power * 16, power.bit_length() - 1, num_tables * 16 - power * 16)

    offset = 12 + 16 * num_tables
    directory, body = b"", b""
    for tag, checksum, data in sorted(entries):
        directory += struct.pack(">4sIII", tag, checksum, offset, len(data))
        padded = data + b"\0" * (-len(data) % 4)
        body += padded
        offset += len(padded)
    return header + directory + body


if __name__ == "__main__":
    with open(sys.argv[1], "rb") as f:
        out = convert(f.read())
    with open(sys.argv[2], "wb") as f:
        f.write(out)
