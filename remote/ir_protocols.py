#!/usr/bin/env python3
"""IR protocol encoders: (protocol, device, subdevice, function) -> raw timings.

This is what turns an irdb row (the community IR database used by the TV-codes
picker, https://github.com/probonopd/irdb - see docs/firetv-remote-ir.md for
attribution) into the raw mark/space list the Fire TV remote's keymap consumes
(keymap_compile.py; units of 10 microseconds, mark first).

Covered protocols carry the vast majority of TVs: the NEC family (LG et al),
NECx (Samsung), RC5/RC6 (Philips), Sony SIRC 12/15/20, and Panasonic/Kaseikyo.
encode() raises UnsupportedProtocol for anything else so callers can tell the
user honestly instead of blasting garbage.

Pure stdlib, no side effects - unit-tested offline (ir_protocols_test.py).
"""
from __future__ import annotations

U = 10  # all outputs are in 10-microsecond units (the Fire OS IRCode unit)


class UnsupportedProtocol(ValueError):
    pass


def _us(*vals):
    """microseconds -> 10us units, min 1 (matches Fire OS correctZeroCodes)."""
    return [max(1, round(v / U)) for v in vals]


def _bits_lsb(value, n):
    return [(value >> i) & 1 for i in range(n)]


def _bits_msb(value, n):
    return [(value >> (n - 1 - i)) & 1 for i in range(n)]


# ---- pulse-distance family (NEC, NECx, Panasonic) -------------------------------
def _pulse_distance(bytes_lsb, lead_mark, lead_space, mark, zero, one, trailer=True):
    out = _us(lead_mark, lead_space)
    for b in bytes_lsb:
        for bit in _bits_lsb(b, 8):
            out += _us(mark, one if bit else zero)
    if trailer:
        out += _us(mark)
    return out


def nec(device, subdevice, function):
    """NEC1/NEC2 (the on-wire frame is identical for a single send). subdevice<0
    means the classic complement form (addr, ~addr); otherwise extended NEC."""
    d = device & 0xFF
    s = (~device & 0xFF) if subdevice is None or subdevice < 0 else subdevice & 0xFF
    f = function & 0xFF
    return 38000, _pulse_distance([d, s, f, ~f & 0xFF], 9000, 4500, 560, 560, 1690)


def necx(device, subdevice, function):
    """NECx1/NECx2 (Samsung TVs: device 7, subdevice 7): 4.5ms/4.5ms leader."""
    d = device & 0xFF
    s = d if subdevice is None or subdevice < 0 else subdevice & 0xFF
    f = function & 0xFF
    return 38000, _pulse_distance([d, s, f, ~f & 0xFF], 4500, 4500, 560, 560, 1690)


def panasonic(device, subdevice, function):
    """Panasonic/Kaseikyo 48-bit: vendor 0x2002 + dev + sub + func + xor."""
    d, s, f = device & 0xFF, (subdevice or 0) & 0xFF, function & 0xFF
    frame = [0x02, 0x20, d, s, f, d ^ s ^ f]
    return 37000, _pulse_distance(frame, 3456, 1728, 432, 432, 1296)


# ---- Manchester family (RC5, RC6) ------------------------------------------------
def _levels_to_raw(levels, unit_us):
    """Collapse a list of (level, units) into mark-first raw timings. Leading
    space (if any) is dropped - transmission starts with the first mark."""
    runs = []
    for level, n in levels:
        if runs and runs[-1][0] == level:
            runs[-1][1] += n
        else:
            runs.append([level, n])
    while runs and runs[0][0] == 0:
        runs.pop(0)
    if runs and runs[-1][0] == 0:
        runs.pop()  # a trailing space is just silence
    return _us(*(r[1] * unit_us for r in runs))


def rc5(device, subdevice, function):
    """RC5(x): 36kHz Manchester, 889us half-bits, 14 bit times: S1, S2/field
    (inverted command bit 6 - the RC5x extension), toggle, 5b device, 6b command.
    Manchester here: logical 1 = space->mark, 0 = mark->space."""
    f = function & 0x7F
    field_bit = 0 if f >= 64 else 1
    bits = [1, field_bit, 0] + _bits_msb(device & 0x1F, 5) + _bits_msb(f & 0x3F, 6)
    levels = []
    for b in bits:
        levels += [(0, 1), (1, 1)] if b else [(1, 1), (0, 1)]
    return 36000, _levels_to_raw(levels, 889)


def rc6(device, subdevice, function):
    """RC6 mode 0: 36kHz; 2.666ms/889us leader; start bit; 3 mode bits; a
    double-width trailer (toggle) bit; 8b control + 8b information, MSB first.
    RC6 Manchester is INVERTED vs RC5: logical 1 = mark->space."""
    T = 444
    levels = [(1, 6), (0, 2)]  # leader: 6t mark, 2t space

    def add_bit(b, width=1):
        nonlocal levels
        levels += [(1, width), (0, width)] if b else [(0, width), (1, width)]

    add_bit(1)  # start
    for b in _bits_msb(0, 3):  # mode 0
        add_bit(b)
    add_bit(0, width=2)  # trailer/toggle, double width
    for b in _bits_msb(device & 0xFF, 8) + _bits_msb(function & 0xFF, 8):
        add_bit(b)
    return 36000, _levels_to_raw(levels, T)


# ---- Sony SIRC --------------------------------------------------------------------
def _sirc(function, device, dev_bits, ext=None):
    out = _us(2400, 600)
    bits = _bits_lsb(function & 0x7F, 7) + _bits_lsb(device, dev_bits)
    if ext is not None:
        bits += _bits_lsb(ext & 0xFF, 8)
    for b in bits:
        out += _us(1200 if b else 600, 600)
    out.pop()  # no trailing space
    return 40000, out


def sony12(device, subdevice, function):
    return _sirc(function, device & 0x1F, 5)


def sony15(device, subdevice, function):
    return _sirc(function, device & 0xFF, 8)


def sony20(device, subdevice, function):
    return _sirc(function, device & 0x1F, 5, ext=subdevice or 0)


# ---- registry + irdb row entry point ---------------------------------------------
# Protocol spellings as they appear in irdb CSVs (case-insensitive).
ENCODERS = {
    "nec1": nec,
    "nec2": nec,
    "nec": nec,
    "necx1": necx,
    "necx2": necx,
    "necx": necx,
    "rc5": rc5,
    "rc-5": rc5,
    "rc6": rc6,
    "rc-6": rc6,
    "sony12": sony12,
    "sony15": sony15,
    "sony20": sony20,
    "panasonic": panasonic,
    "panasonic2": panasonic,
    "kaseikyo": panasonic,
}

# Sony receivers want the frame at least 3x; everything else is fine with 1.
REPEATS = {"sony12": 3, "sony15": 3, "sony20": 3}


def encode(protocol, device, subdevice, function):
    """irdb row -> {frequency, raw, repeat}. Raises UnsupportedProtocol."""
    key = str(protocol or "").strip().lower()
    enc = ENCODERS.get(key)
    if not enc:
        raise UnsupportedProtocol(protocol)
    freq, raw = enc(int(device), int(subdevice), int(function))
    return {"frequency": freq, "raw": raw, "repeat": REPEATS.get(key, 1)}


def supported(protocol):
    return str(protocol or "").strip().lower() in ENCODERS
