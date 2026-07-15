#!/usr/bin/env python3
"""Offline unit tests for ir_protocols.py (run: python3 remote/ir_protocols_test.py).
Reference frames cross-checked against the protocol specs (NEC/NECx timing,
RC5/RC6 Manchester, SIRC, Kaseikyo) and keymap_compile.nec_raw."""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
import ir_protocols as ip
import keymap_compile as kc


def close(a, b, tol=1):
    return abs(a - b) <= tol


def test_nec_matches_keymap_compile():
    # LG volume up: NEC1 dev 4 sub -1 func 2 must equal the existing encoder
    got = ip.encode("NEC1", 4, -1, 2)
    assert got["frequency"] == 38000 and got["repeat"] == 1
    assert got["raw"] == kc.nec_raw(4, 2), "NEC1 must match keymap_compile.nec_raw"


def test_nec_extended_subdevice():
    raw = ip.encode("NEC1", 4, 5, 2)["raw"]
    # bytes: dev=4, sub=5 (not ~4), func, ~func -> differs from complement form
    assert raw != kc.nec_raw(4, 2)
    assert len(raw) == 2 + 32 * 2 + 1  # leader + 32 bits + trailer


def test_necx_leader():
    raw = ip.encode("NECx2", 7, 7, 2)["raw"]
    assert close(raw[0], 450) and close(raw[1], 450), raw[:2]  # 4.5ms/4.5ms
    assert len(raw) == 2 + 32 * 2 + 1


def test_rc5_structure():
    freq, raw = ip.rc5(0, -1, 12)  # TV power on RC5: dev 0, cmd 12
    assert freq == 36000
    # 14 bit-times * 1778us, minus the dropped leading space (S1=1 starts
    # space->mark) and, for cmd 12 (last bit 0 = mark->space), the dropped
    # trailing space: 24892 - 889 - 889 = ~23114, +-rounding per run.
    total = sum(raw) * 10
    assert abs(total - (14 * 1778 - 2 * 889)) < len(raw) * 10 + 60, total
    assert all(v > 0 for v in raw)
    # S1=1,S2=1 (cmd<64): space,mark | space,mark -> first run is one half-bit mark
    assert close(raw[0], 89, tol=1), raw[0]


def test_rc5_extended_field_bit():
    # cmd >= 64 flips S2 to 0: S1's mark (space,MARK) merges with S2's leading
    # mark (MARK,space) -> the first run doubles to two half-bits.
    raw_lo = ip.rc5(0, -1, 12)[1]
    raw_hi = ip.rc5(0, -1, 76)[1]
    assert raw_hi != raw_lo
    assert close(raw_hi[0], 178, tol=2), raw_hi[0]
    assert close(raw_hi[1], 89, tol=1), raw_hi[1]


def test_rc6_leader_and_length():
    freq, raw = ip.rc6(0, -1, 12)
    assert freq == 36000
    assert close(raw[0], 267, tol=1), raw[0]  # 2.666ms leader mark
    total = sum(raw) * 10
    # leader(8t) + start(2t) + mode(6t) + trailer(4t) + 16 bits(32t) = 52t of 444us
    assert abs(total - 52 * 444) < 600 + len(raw) * 10, total


def test_sirc_repeat_and_frame():
    got = ip.encode("Sony12", 1, -1, 21)  # Sony TV power: dev 1, cmd 21
    assert got["repeat"] == 3 and got["frequency"] == 40000
    raw = got["raw"]
    assert close(raw[0], 240) and close(raw[1], 60)
    assert len(raw) == 2 + 12 * 2 - 1  # lead pair + 12 bits, no trailing space


def test_panasonic_frame():
    got = ip.encode("Panasonic", 160, 0, 61)
    raw = got["raw"]
    assert close(raw[0], 346, tol=1) and close(raw[1], 173, tol=1)
    assert len(raw) == 2 + 48 * 2 + 1


def test_unsupported_raises():
    try:
        ip.encode("XMP-1", 0, 0, 0)
    except ip.UnsupportedProtocol:
        pass
    else:
        raise AssertionError("XMP-1 must raise UnsupportedProtocol")
    assert not ip.supported("XMP-1") and ip.supported("nec1") and ip.supported("RC5")


def test_encode_fits_keymap_action():
    # the raw list must compile into a keymap IR action without error
    got = ip.encode("NEC1", 4, -1, 2)
    act = kc.compile_ir_action([got["raw"]], got["frequency"], 33, got["repeat"], 0)
    assert act[0] == kc.IR_CODE_RAW and len(act) > 40


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("ok", name)
            except AssertionError as ex:
                fails += 1
                print("FAIL", name, "-", ex)
    sys.exit(1 if fails else 0)
