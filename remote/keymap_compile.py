#!/usr/bin/env python3
"""
Byte-accurate reimplementation of Amazon's BluetoothKeyMapLib keymap compiler,
reverse-engineered from Fire OS 7.7.1.3 (AFTKA / kara).

Produces the exact bytes that BleKeyMapDeviceProxyV2 writes to the Alexa remote's
custom GATT keymap service, so the Pi (tvbox) can program the remote's onboard IR
blaster without a Fire TV.

Endianness (from ByteTool): i16/i32 are LITTLE-endian; the table UUID is
BIG-endian (java ByteBuffer.putLong(msb).putLong(lsb)).

References in the firmware:
  KeyMapTable.compileTable / compileWithChecksum / compileAsBlast
  KeyMapAction.compileAction ; KeyMapActionIr.compileRawCode
  BleKeyMapDeviceProxyV2.requestStartNewTable / switchTable / writeTable / blastCommand
  KeyMapActionType (IR=3, NOTIFY_HOST=4, IR_OPT=6, ...)
"""
from __future__ import annotations
import hashlib, struct, uuid as _uuid, json

# ---- GATT UUIDs (on the remote) ------------------------------------------------
KEYMAP_SERVICE = "fe151500-5e8d-11e6-8b77-86f30ca893d3"
CHAR_MAPPING   = "fe151501-5e8d-11e6-8b77-86f30ca893d3"
CHAR_CONTROL   = "fe151502-5e8d-11e6-8b77-86f30ca893d3"
CHAR_BLAST     = "fe151503-5e8d-11e6-8b77-86f30ca893d3"

# ---- action types / control opcodes / verification ----------------------------
IR_CODE_RAW, CEC_NOTIFY_HOST, IR_CODE_RAW_OPT, LED = 3, 4, 6, 7
REPEAT_FLAG_TOGGLE, REPEAT_FLAG_SEQUENCE = 0x10, 0x20
CTRL_CONTEXT_SWITCH, CTRL_RESET_STAGING, CTRL_COMMIT_BLAST, CTRL_DELETE, CTRL_ENABLE_SDS = 1, 2, 5, 16, 32
VERIF_NONE, VERIF_SHA2 = 0, 1

# scan-id map shared by essentially all Amazon BLE remotes (VID 0x0171).
# Full per-PID maps live in BluetoothKeyMapLib resources; override if yours differs.
SCAN_ID = {"Power": 2, "VolumeUp": 6, "VolumeDown": 9, "Mute": 18,
           "Up": 1, "Right": 4, "Voice": 5, "Down": 7, "Home": 8,
           "Select": 10, "Left": 13, "Back": 16, "Menu": 19}

def _u8(v):  return struct.pack("<B", v & 0xFF)
def _u16(v): return struct.pack("<H", v & 0xFFFF)          # little-endian
def _uuid_be(s):                                            # big-endian 16 bytes
    u = _uuid.UUID(s); return u.bytes                       # UUID.bytes is big-endian

# ---- IR action -----------------------------------------------------------------
def compile_ir_action(ircodes, frequency, duty_cycle, repeat, post_delay,
                      toggle_mask=0, repeat_type="Basic", optional=False):
    """ircodes: list of up to 2 sequences, each a list[int] of raw timing values."""
    seqs = [list(s) for s in ircodes][:2]
    hdr  = b"".join([
        b"f[%d]" % frequency, b"c[%d]" % duty_cycle, b"l",
        b"[%d]" % (len(seqs[0]) if len(seqs) > 0 else 0),
        b"[%d]" % (len(seqs[1]) if len(seqs) > 1 else 0),
        b"r[%d]" % repeat, b"d[%d]" % post_delay, b"t[%d]" % toggle_mask,
    ]) + b"\x00"
    body = b"".join(_u16(v) for s in seqs for v in s)
    payload = hdr + body
    flags = {"Toggle": REPEAT_FLAG_TOGGLE, "Sequence": REPEAT_FLAG_SEQUENCE}.get(repeat_type, 0)
    typ = IR_CODE_RAW_OPT if optional else IR_CODE_RAW
    return _u8(typ) + _u8(flags) + _u16(len(payload)) + payload

def notify_host_action():
    return _u8(CEC_NOTIFY_HOST) + _u8(0) + _u16(0)

# ---- table ---------------------------------------------------------------------
class KeyMapTable:
    def __init__(self, table_uuid="00000000-0000-0000-0000-000000000000", scan_id=None):
        self.uuid = table_uuid
        self.scan_id = scan_id or SCAN_ID
        self.rows = []  # list[(key_name, [action_bytes,...])]

    def add_key(self, key_name, actions):
        self.rows.append((key_name, list(actions))); return self

    def add_row(self, scan_id, actions):
        """Add a row by explicit scan id (bypasses the name->scan_id lookup) - for
        scan-id discovery tables where we bind raw ids, not named keys."""
        name = "#%d" % scan_id
        self.scan_id[name] = scan_id
        self.rows.append((name, list(actions))); return self

    def compile(self):
        out = _u8(len(self.rows))
        for key, actions in self.rows:
            sid = self.scan_id.get(key, 0xFF) & 0xFF
            blob = b"".join(actions)
            out += _u8(sid) + _u8(len(actions)) + _u16(len(blob)) + blob
        return out

    def compile_with_checksum(self):        # persistent table payload for MAPPING char
        c = self.compile(); return c + hashlib.sha256(c).digest()

    def compile_as_blast(self):             # payload for BLAST char (drop num-rows byte)
        return self.compile()[1:]

# ---- control-char command frames ----------------------------------------------
def frame_start_table(table_uuid, length, verif=VERIF_SHA2):
    return _u8(CTRL_RESET_STAGING) + _u8(verif) + _uuid_be(table_uuid) + _u16(0) + _u16(length)

def frame_switch_table(table_uuid, toggle_state=0):
    return _u8(CTRL_CONTEXT_SWITCH) + _uuid_be(table_uuid) + _u8(toggle_state)

def frame_commit_blast(): return _u8(CTRL_COMMIT_BLAST)
def frame_delete_all():   return _u8(CTRL_DELETE)

def chunks(data, n=200):
    return [data[i:i+n] for i in range(0, len(data), n)]

# ---- Pronto/CCF -> IRCode (exact port of Fire OS IrCodeConverter.convertToRaw) --
# code1/code2 in the Fire OS IR DB are Pronto hex codes. The remote consumes raw
# values = floor(prontoBurst * 100000 / freq)  (== duration in 10-microsecond units),
# and freq(Hz) = 1000000 / (prontoFreqWord * 0.241246).  This is THE format to feed.
FREQUENCY_COEFFICIENT = 0.241246

def pronto_frequency(freq_word):
    return int(1000000.0 / (freq_word * FREQUENCY_COEFFICIENT))

def pronto_to_raw(pronto):
    """Parse a Pronto/CCF hex string -> (freq_hz, [raw values in 10us units]).
    Mirrors IrCodeConverter.convertToRaw: drop preamble, read freq word, drop the
    two burst-length words, convert each remaining burst value."""
    toks = pronto.strip().split()
    if len(toks) < 5:
        raise ValueError("pronto too short")
    freq = pronto_frequency(int(toks[1], 16))          # toks[0]=preamble(0000)
    bursts = toks[4:]                                   # toks[2],toks[3]=seq lengths
    raw = [max(1, (int(t, 16) * 100000) // freq) for t in bursts]   # correctZeroCodes
    return freq, raw

def ir_action_from_pronto(pronto, pronto_repeat=None, duty_cycle=33, repeat=1,
                          post_delay=0, toggle_mask=0, optional=False):
    """One IR keymap action straight from a Pronto code (+ optional repeat frame)."""
    freq, raw = pronto_to_raw(pronto)
    seqs = [raw]
    rtype = "Basic"
    if pronto_repeat:
        _, raw2 = pronto_to_raw(pronto_repeat)
        seqs.append(raw2); rtype = "Sequence"
    return compile_ir_action(seqs, freq, duty_cycle, repeat, post_delay,
                             toggle_mask, rtype, optional)

def ircode_strings_from_pronto(pronto):
    """The 's'-joined IRCode string + freq, for building the Fire-OS JSON form."""
    freq, raw = pronto_to_raw(pronto)
    return freq, "s".join(str(v) for v in raw)

# ---- NEC encoder (LG and most TVs) -> raw IRCode (10us units) ------------------
# NEC: 9ms/4.5ms leader; 8b addr (LSB first), ~addr, 8b cmd (LSB first), ~cmd;
# bit mark 560us; "0" space 560us, "1" space 1690us; 560us trailer. Carrier 38kHz.
# LG TVs are NEC, address 0x04:  Power=0x08  VolUp=0x02  VolDown=0x03  Mute=0x09.
def nec_raw(address, command, mark=56, zero=56, one=169, lead_mark=900, lead_space=450):
    """Return NEC frame as raw values in 10us units (matches Fire OS IRCode unit)."""
    bytes_lsb = [address & 0xFF, (~address) & 0xFF, command & 0xFF, (~command) & 0xFF]
    out = [lead_mark, lead_space]
    for b in bytes_lsb:
        for i in range(8):                      # LSB first
            out.append(mark)
            out.append(one if (b >> i) & 1 else zero)
    out.append(mark)                            # trailer
    return out

def nec_action(address, command, freq=38000, duty_cycle=33, repeat=1, post_delay=0,
               optional=False):
    return compile_ir_action([nec_raw(address, command)], freq, duty_cycle,
                             repeat, post_delay, 0, "Basic", optional)

# Ready-made LG code set (address 0x04). Values are the logical NEC command bytes.
LG_NEC = {"address": 0x04,
          "keys": {"Power": 0x08, "VolumeUp": 0x02, "VolumeDown": 0x03, "Mute": 0x09}}

# ---- build a table from the Fire-OS JSON form ----------------------------------
def table_from_json(obj, scan_id=None):
    """obj = the inner {'ID':.., 'VolumeUp':[{..}], ...} dict (one TableUpdate entry)."""
    t = KeyMapTable(obj.get("ID", "00000000-0000-0000-0000-000000000000"), scan_id)
    for key, cmds in obj.items():
        if key == "ID":
            continue
        actions = []
        for c in cmds:
            ct = c.get("CommandType", "IR")
            if ct in ("IR", "IROptional"):
                seqs = [[int(x) for x in s.split("s") if x != ""] for s in c["IRCode"]]
                actions.append(compile_ir_action(
                    seqs, c["Frequency"], c["DutyCycle"], c["Repeat"], c["PostDelay"],
                    c.get("ToggleBitMask", 0), c.get("RepeatType", "Basic"),
                    optional=(ct == "IROptional")))
            elif ct == "NOTIFY_HOST":
                actions.append(notify_host_action())
        t.add_key(key, actions)
    return t

# ---- self-test -----------------------------------------------------------------
if __name__ == "__main__":
    # A tiny VolumeUp IR action: freq 38000, duty 33, repeat 1, no delay,
    # one sequence of 4 timing values [342,171,21,64].
    act = compile_ir_action([[342, 171, 21, 64]], 38000, 33, 1, 0)
    # header: "f[38000]c[33]l[4][0]r[1]d[0]t[0]\0" + 4*int16LE
    exp_hdr = b"f[38000]c[33]l[4][0]r[1]d[0]t[0]\x00"
    exp_body = struct.pack("<4H", 342, 171, 21, 64)
    exp_payload = exp_hdr + exp_body
    exp_action = bytes([IR_CODE_RAW, 0]) + struct.pack("<H", len(exp_payload)) + exp_payload
    assert act == exp_action, (act.hex(), exp_action.hex())

    t = KeyMapTable("12345678-9abc-def0-1234-56789abcdef0")
    t.add_key("VolumeUp", [act, notify_host_action()])
    tbl = t.compile()
    # num_rows=1; scan_id(VolumeUp)=6; num_actions=2; actions_len; blob...
    assert tbl[0] == 1 and tbl[1] == 6 and tbl[2] == 2
    actions_len = struct.unpack("<H", tbl[3:5])[0]
    assert actions_len == len(act) + len(notify_host_action())
    assert t.compile_with_checksum()[-32:] == hashlib.sha256(tbl).digest()
    assert t.compile_as_blast() == tbl[1:]

    frame = frame_start_table(t.uuid, len(t.compile_with_checksum()))
    assert frame[0] == CTRL_RESET_STAGING and frame[1] == VERIF_SHA2 and len(frame) == 22
    assert _uuid_be(t.uuid) == _uuid.UUID(t.uuid).bytes
    sw = frame_switch_table(t.uuid); assert sw[0] == CTRL_CONTEXT_SWITCH and len(sw) == 18

    # Pronto conversion: a real NEC-ish code at ~38 kHz. Header 9ms/4.5ms.
    # freq word 006D -> ~38 kHz ; 0x0156=342 bursts -> 342*100000/38028 = 899 (=8.99 ms).
    freq, raw = pronto_to_raw("0000 006D 0002 0000 0156 00AB 0015 0015 0015 0040")
    assert 37000 < freq < 39000, freq
    assert raw[0] in range(890, 910) and raw[1] in range(440, 460), raw   # 9ms, 4.5ms
    assert raw[2] in range(50, 60), raw                                    # 560us
    pact = ir_action_from_pronto("0000 006D 0002 0000 0156 00AB 0015 0015")
    assert pact[0] == IR_CODE_RAW

    print("self-test OK")
    print("pronto->freq    :", freq, "Hz ; raw[0:4]=", raw[:4], "(10us units)")
    print("VolumeUp action :", act.hex())
    print("compiled table  :", tbl.hex())
    print("start-table cmd :", frame.hex())
    print("switch cmd      :", sw.hex())
    print("chunks(200)     :", [len(c) for c in chunks(t.compile_with_checksum())])
