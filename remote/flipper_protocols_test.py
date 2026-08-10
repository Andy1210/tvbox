#!/usr/bin/env python3
"""Offline unit tests for flipper_protocols.py (run: python3 remote/flipper_protocols_test.py).

Two kinds of check, and the second one is the point:

  * structure - leader, bit count and carrier against the Flipper firmware's own
    protocol tables, plus equality with ir_protocols where the two overlap (that
    module's NEC1 drives a real TV from this repo, so agreeing with it is evidence
    rather than a restatement);
  * real captures - a frame encoded here against a `type: raw` recording of the
    SAME button made by someone else and filed under a different model in
    Flipper-IRDB. That is what caught an RC6 frame being built without its leader,
    and it is the only check on Kaseikyo's vendor/genre/parity packing.

The capture fixtures are in 10-microsecond units (the file's microseconds / 10) and
are compared with a tolerance, because a capture carries a receiver's jitter.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import flipper_protocols as fp
import ir_protocols as ip
import keymap_compile as kc


def near(a, b, tol):
    return abs(a - b) <= tol


def like(mine, real, name):
    """A frame matches a capture when every timing is within jitter of it."""
    assert len(mine) == len(real), "%s: %d timings vs the capture's %d" % (name, len(mine), len(real))
    for i, (x, y) in enumerate(zip(mine, real)):
        assert near(x, y, max(3, round(y * 0.12))), "%s: timing %d is %d, capture has %d" % (name, i, x, y)


# ---- structure -------------------------------------------------------------------
def test_nec_equals_ir_protocols():
    # The address/command bytes a .ir file carries, encoded here, must come out as
    # the frame the deployed irdb encoder builds for the same device+function.
    got = fp.encode("NEC", "04 00 00 00", "08 00 00 00")
    assert got["frequency"] == 38000 and got["repeat"] == 1
    assert got["raw"] == ip.encode("NEC1", 4, -1, 8)["raw"]
    assert got["raw"] == kc.nec_raw(4, 8)


def test_necext_is_verbatim():
    # Both command bytes are sent as captured. With a complementary pair the frame
    # is the same as extended NEC's; with an arbitrary second byte it is not, which
    # is why this does not go through ir_protocols.
    same = fp.encode("NECext", "01 FF 00 00", "12 ED 00 00")["raw"]
    assert same == ip.encode("NEC1", 1, 0xFF, 0x12)["raw"]
    odd = fp.encode("NECext", "01 FF 00 00", "12 34 00 00")["raw"]
    assert odd != same and len(odd) == 2 + 32 * 2 + 1


def test_sirc_family_equals_ir_protocols():
    for name, addr, want in (
        ("SIRC", "01 00 00 00", ip.encode("Sony12", 1, -1, 21)),
        ("SIRC15", "30 00 00 00", ip.encode("Sony15", 0x30, -1, 21)),
        ("SIRC20", "3A 07 00 00", ip.encode("Sony20", 0x3A & 0x1F, 0x073A >> 5, 21)),
    ):
        got = fp.encode(name, addr, "15 00 00 00")
        assert got["raw"] == want["raw"], name
        assert got["repeat"] == 3, name  # a Sony receiver acts on the third frame


def test_rc5_and_rc6_equal_ir_protocols():
    assert fp.encode("RC5", "10 00 00 00", "0C 00 00 00")["raw"] == ip.rc5(0x10, -1, 12)[1]
    assert fp.encode("RC6", "20 00 00 00", "0C 00 00 00")["raw"] == ip.rc6(0x20, -1, 12)[1]


def test_rc6_carries_its_leader():
    raw = fp.encode("RC6", "20 00 00 00", "0C 00 00 00")["raw"]
    assert near(raw[0], 267, 1), raw[0]  # 2666us mark, i.e. 6 half-bit units
    assert near(raw[1], 89, 1), raw[1]  # 889us space


def test_samsung32_frame():
    raw = fp.encode("Samsung32", "07 00 00 00", "02 00 00 00")["raw"]
    assert near(raw[0], 450, 1) and near(raw[1], 450, 1), raw[:2]
    assert len(raw) == 2 + 32 * 2 + 1
    # address twice, then command and its complement
    assert fp.encode("Samsung32", "07 00 00 00", "02 00 00 00")["raw"] != fp.encode(
        "Samsung32", "08 00 00 00", "02 00 00 00"
    )["raw"]


def test_pioneer_frame():
    got = fp.encode("Pioneer", "A5 00 00 00", "1C 00 00 00")
    assert got["frequency"] == 40000 and got["repeat"] == 2
    raw = got["raw"]
    assert near(raw[0], 850, 1) and near(raw[1], 422, 1), raw[:2]
    assert len(raw) == 2 + 33 * 2 + 1  # 33 bits: four bytes plus one zero bit


def test_nec42_lengths():
    for name in ("NEC42", "NEC42ext"):
        raw = fp.encode(name, "51 00 00 00", "00 00 00 00")["raw"]
        assert len(raw) == 2 + 42 * 2 + 1, name


# ---- against real captures ---------------------------------------------------------
def test_kaseikyo_matches_a_real_capture():
    # Panasonic Stop, parsed in Blu-Ray/Panasonic/Panasonic_DMPBDT167.ir, captured
    # raw in TVs/Panasonic/Panasonic_N2QAYB000752_Full.ir. Nothing else in this repo
    # can encode a Kaseikyo vendor other than Panasonic's own.
    capture = [348, 173] + [
        45, 42, 45, 130, 44, 43, 45, 43, 45, 42, 45, 42, 45, 42, 44, 43, 45, 43, 45, 42, 45, 42, 45, 42, 44, 43,
        45, 130, 45, 42, 44, 43, 45, 43, 45, 42, 45, 42, 45, 42, 44, 130, 45, 130, 45, 42, 45, 130, 45, 42, 45, 42,
        44, 43, 45, 43, 45, 42, 45, 42, 45, 42, 44, 43, 45, 43, 45, 42, 45, 42, 44, 43, 45, 43, 45, 42, 45, 42, 45,
        42, 44, 43, 45, 43, 45, 42, 45, 42, 45, 129, 45, 130, 45, 42, 44, 130, 45,
    ]
    got = fp.encode("Kaseikyo", "B0 02 20 00", "00 00 00 00")
    assert got["frequency"] == 38000
    like(got["raw"], capture, "Kaseikyo")


def test_rc5_matches_a_real_capture():
    # Marantz Vol_up: parsed in Marantz_RC042SR.ir, captured in
    # Marantz_SR_7009_(RC026SR).ir. Manchester polarity and the word inversion both
    # have to be right for this to line up.
    capture = [90, 90, 176, 177, 179, 90, 87, 91, 87, 90, 87, 91, 87, 176, 179, 90, 88, 90, 87, 91, 87]
    like(fp.encode("RC5", "10 00 00 00", "10 00 00 00")["raw"], capture, "RC5")


def test_rca_matches_a_real_capture():
    # TCL Vol_dn: parsed in TVs/TCL/TCL_40S615.ir, captured in TCL_UnknownModel1.ir.
    capture = [401, 398] + [
        51, 198, 52, 198, 51, 198, 52, 198, 51, 98, 52, 98, 51, 199, 52, 98, 52, 198, 51, 198, 52, 198, 52, 98,
        52, 98, 51, 99, 52, 98, 52, 98, 51, 199, 52, 198, 51, 99, 52, 198, 52, 98, 51, 98, 52, 98, 52, 198, 52,
    ]
    like(fp.encode("RCA", "0F 00 00 00", "74 00 00 00")["raw"], capture, "RCA")


# ---- the module's edges ------------------------------------------------------------
def test_parse_bytes_is_little_endian():
    assert fp.parse_bytes("07 00 00 00") == 7
    assert fp.parse_bytes("3A 07 00 00") == 0x073A
    assert fp.parse_bytes("FF") == 255
    for bad in ("", "zz", "01 02 03 04 05 06 07 08 09"):
        try:
            fp.parse_bytes(bad)
        except ValueError:
            continue
        raise AssertionError("parse_bytes accepted %r" % (bad,))


def test_unsupported_raises():
    assert fp.supported("samsung32") and fp.supported("NEC") and not fp.supported("Mitsubishi")
    try:
        fp.encode("Mitsubishi", "01 00 00 00", "01 00 00 00")
    except ip.UnsupportedProtocol:
        pass
    else:
        raise AssertionError("an unimplemented protocol must raise, not guess")


def test_every_protocol_compiles_into_a_keymap_action():
    # What the remote is actually given: one IR action per code. A protocol whose
    # frame came out empty or with a zero timing would fail here, not on the remote.
    for name in fp.ENCODERS:
        got = fp.encode(name, "07 00 00 00", "12 00 00 00")
        assert got["raw"] and all(v >= 1 for v in got["raw"]), name
        act = kc.compile_ir_action([got["raw"]], got["frequency"], 33, got["repeat"], 0)
        assert act[0] == kc.IR_CODE_RAW and len(act) > 40, name


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
