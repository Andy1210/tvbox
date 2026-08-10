#!/usr/bin/env python3
"""Flipper-IRDB `parsed` blocks -> raw timings, the way a Flipper transmits them.

The second code source behind the TV-codes picker (github.com/UberGuidoZ/Flipper-IRDB,
CC0) stores a button either as `type: raw` - µs timings, used verbatim - or as
`type: parsed`, a protocol name plus a 4-byte little-endian address and command.
This module encodes the second form.

It is deliberately NOT a mapping onto ir_protocols.py. That module speaks irdb's
(protocol, device, subdevice, function) semantics; a Flipper block carries the
address and command bytes the capture decoded, and the two conventions agree only
for part of the set - Kaseikyo carries its vendor id in the address, NECext's
command bytes are whatever was captured rather than a value and its complement.
Encoding here from Flipper's own definitions is what makes the bytes match what
the DB was recorded from; the timing/rounding primitives are shared with
ir_protocols so the 10-microsecond conversion cannot drift between the two.

Ported from flipperzero-firmware lib/infrared/encoder_decoder (protocol variant
tables + each protocol's encoder reset + infrared_common_encoder.c), which is the
authority on both the timings and the bit packing.

Pure stdlib, no side effects - unit-tested offline (flipper_protocols_test.py),
including against real `raw` captures of the same button.
"""
from __future__ import annotations

from ir_protocols import UnsupportedProtocol, _bits_lsb, _levels_to_raw, _us

# Frame layouts. `preamble_mark` 0 means the frame starts on the first data bit
# (RC5); a pulse-WIDTH protocol is the one whose two spaces are equal (SIRC), and
# it ends on the last bit's mark instead of a stop mark.
NEC_T = dict(preamble_mark=9000, preamble_space=4500, bit1_mark=560, bit1_space=1690, bit0_mark=560, bit0_space=560)
SAMSUNG_T = dict(preamble_mark=4500, preamble_space=4500, bit1_mark=550, bit1_space=1650, bit0_mark=550, bit0_space=550)
SIRC_T = dict(preamble_mark=2400, preamble_space=600, bit1_mark=1200, bit1_space=600, bit0_mark=600, bit0_space=600)
KASEIKYO_U = 432
KASEIKYO_T = dict(
    preamble_mark=8 * KASEIKYO_U,
    preamble_space=4 * KASEIKYO_U,
    bit1_mark=KASEIKYO_U,
    bit1_space=3 * KASEIKYO_U,
    bit0_mark=KASEIKYO_U,
    bit0_space=KASEIKYO_U,
)
RCA_T = dict(preamble_mark=4000, preamble_space=4000, bit1_mark=500, bit1_space=2000, bit0_mark=500, bit0_space=1000)
PIONEER_T = dict(preamble_mark=8500, preamble_space=4225, bit1_mark=500, bit1_space=1500, bit0_mark=500, bit0_space=500)
RC5_UNIT, RC6_UNIT = 888, 444

NEC_FREQ, RC5_FREQ, SIRC_FREQ, PIONEER_FREQ = 38000, 36000, 40000, 40000


def _bytes_bits(data, nbits):
    """The bit stream Flipper's encoders emit: LSB first within each byte, bytes in
    order, `nbits` of them (the buffer is a byte array read as `data[i / 8]`)."""
    bits = []
    for b in data:
        bits += _bits_lsb(b, 8)
    if len(bits) < nbits:
        raise ValueError("data too short for %d bits" % nbits)
    return bits[:nbits]


def _pdwm(bits, t):
    """Pulse distance/width frame: preamble, then a mark+space per bit."""
    out = _us(t["preamble_mark"], t["preamble_space"]) if t["preamble_mark"] else []
    for b in bits:
        out += _us(t["bit1_mark"] if b else t["bit0_mark"], t["bit1_space"] if b else t["bit0_space"])
    if t["bit1_space"] == t["bit0_space"]:
        out.pop()  # pulse width: the frame ends on the last bit's mark
    else:
        out += _us(t["bit0_mark"])  # pulse distance: one stop mark closes it
    return out


def _manchester(bits, unit, preamble=(), double_width_at=None):
    """Manchester frame. A logic 1 is mark-then-space here; RC5 gets its inversion
    from the data itself (see rc5 below), which is what makes it space-then-mark
    on the wire. RC6's toggle bit is the one bit sent at double width, and RC6 is
    also the one with a leader - measured against the DB's own captures, an RC6
    frame without it decodes as something else entirely."""
    levels = list(preamble)
    for i, b in enumerate(bits):
        w = 2 if i == double_width_at else 1
        levels += [(1, w), (0, w)] if b else [(0, w), (1, w)]
    return _levels_to_raw(levels, unit)


def _rev8(v):
    return int("{:08b}".format(v & 0xFF)[::-1], 2)


# ---- the protocols -----------------------------------------------------------------
# Each returns (frequency, raw timings). `address`/`command` are the integers the
# .ir file's 4 little-endian bytes make.
def nec(address, command):
    a, c = address & 0xFF, command & 0xFF
    return NEC_FREQ, _pdwm(_bytes_bits([a, ~a & 0xFF, c, ~c & 0xFF], 32), NEC_T)


def necext(address, command):
    # Verbatim: the capture's second command byte is not always the first one's
    # complement, and a set that expects what was recorded would not answer.
    data = [address & 0xFF, (address >> 8) & 0xFF, command & 0xFF, (command >> 8) & 0xFF]
    return NEC_FREQ, _pdwm(_bytes_bits(data, 32), NEC_T)


def nec42(address, command):
    d1 = (address & 0x1FFF) | ((~address & 0x1FFF) << 13) | ((command & 0x3F) << 26)
    d2 = ((command & 0xC0) >> 6) | ((~command & 0xFF) << 2)
    data = list(d1.to_bytes(4, "little")) + list((d2 & 0xFFFFFFFF).to_bytes(4, "little"))
    return NEC_FREQ, _pdwm(_bytes_bits(data, 42), NEC_T)


def nec42ext(address, command):
    d1 = (address & 0x3FFFFFF) | ((command & 0x3F) << 26)
    d2 = (command & 0xFFC0) >> 6
    data = list((d1 & 0xFFFFFFFF).to_bytes(4, "little")) + list((d2 & 0xFFFFFFFF).to_bytes(4, "little"))
    return NEC_FREQ, _pdwm(_bytes_bits(data, 42), NEC_T)


def samsung32(address, command):
    a, c = address & 0xFF, command & 0xFF
    return NEC_FREQ, _pdwm(_bytes_bits([a, a, c, ~c & 0xFF], 32), SAMSUNG_T)


def _rc5(address, command, second_start_bit):
    # 14 bits: start, start/command bit 6, toggle, 5 address, 6 command - and then
    # the whole word inverted, which is how Flipper's manchester ends up sending a
    # logic 1 as space-then-mark.
    word = 0x01 | (0x02 if second_start_bit else 0)
    word |= (_rev8(address) >> 3) << 3
    word |= (_rev8(command) >> 2) << 8
    data = [(~word) & 0xFF, (~(word >> 8)) & 0xFF]
    return RC5_FREQ, _manchester(_bytes_bits(data, 14), RC5_UNIT)


def rc5(address, command):
    return _rc5(address, command, True)


def rc5x(address, command):
    # RC5X spends the second start bit on the command's 7th bit, so it is sent as 0.
    return _rc5(address, command, False)


def rc6(address, command):
    word = 0x01 | (_rev8(address) << 5) | (_rev8(command) << 13)
    data = list((word & 0xFFFFFFFF).to_bytes(4, "little"))
    # 2666/889 us leader = 6 and 2 of RC6's own half-bit units.
    leader = ((1, 6), (0, 2))
    return RC5_FREQ, _manchester(_bytes_bits(data, 21), RC6_UNIT, leader, double_width_at=4)


def _sirc(address, command, addr_mask, nbits):
    word = (command & 0x7F) | ((address & addr_mask) << 7)
    data = list((word & 0xFFFFFFFF).to_bytes(4, "little"))
    return SIRC_FREQ, _pdwm(_bytes_bits(data, nbits), SIRC_T)


def sirc(address, command):
    return _sirc(address, command, 0x1F, 12)


def sirc15(address, command):
    return _sirc(address, command, 0xFF, 15)


def sirc20(address, command):
    return _sirc(address, command, 0x1FFF, 20)


def kaseikyo(address, command):
    """48 bits: vendor id + its 4-bit parity, two genre nibbles, 10 bits of data,
    a 2-bit id and a parity byte. The vendor lives in the ADDRESS, which is why
    Panasonic's encoder in ir_protocols cannot stand in for this."""
    dev_id = (address >> 24) & 3
    vendor = (address >> 8) & 0xFFFF
    genre1 = (address >> 4) & 0xF
    genre2 = address & 0xF
    d = [vendor & 0xFF, (vendor >> 8) & 0xFF]
    vendor_parity = d[0] ^ d[1]
    vendor_parity = (vendor_parity & 0xF) ^ (vendor_parity >> 4)
    d.append((vendor_parity & 0xF) | (genre1 << 4))
    d.append((genre2 & 0xF) | ((command & 0xF) << 4))
    d.append((dev_id << 6) | ((command >> 4) & 0x3F))
    d.append(d[2] ^ d[3] ^ d[4])
    return NEC_FREQ, _pdwm(_bytes_bits(d, 48), KASEIKYO_T)


def rca(address, command):
    a, c = address & 0xF, command & 0xFF
    word = a | (c << 4) | ((~a & 0xF) << 12) | ((~c & 0xFF) << 16)
    data = list((word & 0xFFFFFFFF).to_bytes(4, "little"))
    return NEC_FREQ, _pdwm(_bytes_bits(data, 24), RCA_T)


def pioneer(address, command):
    a, c = address & 0xFF, command & 0xFF
    return PIONEER_FREQ, _pdwm(_bytes_bits([a, ~a & 0xFF, c, ~c & 0xFF, 0], 33), PIONEER_T)


# ---- registry ----------------------------------------------------------------------
# Keys are the protocol names as they appear in a .ir file (case-insensitive). This
# is every name the curated part of Flipper-IRDB uses; an unknown one is refused
# rather than guessed, so the picker can grey the row out instead of blasting noise.
ENCODERS = {
    "nec": nec,
    "necext": necext,
    "nec42": nec42,
    "nec42ext": nec42ext,
    "samsung32": samsung32,
    "rc5": rc5,
    "rc5x": rc5x,
    "rc6": rc6,
    "sirc": sirc,
    "sirc15": sirc15,
    "sirc20": sirc20,
    "kaseikyo": kaseikyo,
    "rca": rca,
    "pioneer": pioneer,
}

# How many frames the receiver needs before it acts. Sony wants three, Pioneer two.
REPEATS = {"sirc": 3, "sirc15": 3, "sirc20": 3, "pioneer": 2}


def parse_bytes(text):
    """"07 00 00 00" -> 7. A .ir address/command field is little-endian hex bytes."""
    parts = str(text or "").split()
    if not parts or len(parts) > 8:
        raise ValueError("bad byte field: %r" % (text,))
    return int.from_bytes(bytes(int(p, 16) for p in parts), "little")


def encode(protocol, address, command):
    """A parsed .ir block -> {frequency, raw, repeat}. `address`/`command` may be
    the file's hex-byte strings or already-decoded ints. Raises
    UnsupportedProtocol for a name this module does not implement."""
    key = str(protocol or "").strip().lower()
    enc = ENCODERS.get(key)
    if not enc:
        raise UnsupportedProtocol(protocol)
    a = address if isinstance(address, int) else parse_bytes(address)
    c = command if isinstance(command, int) else parse_bytes(command)
    freq, raw = enc(a, c)
    return {"frequency": freq, "raw": raw, "repeat": REPEATS.get(key, 1)}


def supported(protocol):
    return str(protocol or "").strip().lower() in ENCODERS
