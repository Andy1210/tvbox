#!/usr/bin/env python3
"""
Program the IR buttons of an Amazon Fire TV / Alexa Voice Remote from the tvbox,
without a Fire TV. Speaks the remote's custom BLE keymap GATT service directly.

Reverse-engineered from Fire OS 7.7.1.3 (Fire TV Stick 4K Max / AFTKA); see
../FINDINGS.md. Byte layout + Pronto conversion live in keymap_compile.py.

The remote (not any Stick) has the IR LED. We write a "keymap" that binds
physical keys (VolumeUp/VolumeDown/Mute/Power) to raw IR codes; afterwards the
remote blasts IR on its own when those keys are pressed. `blast` fires a code
on demand (great for bring-up); `program`+auto-switch makes it persistent.

Requires: python3 -m pip install bleak   (only for the BLE subcommands)
Config defaults to ~/.tvbox/firetv_tv_codes.json (copy the shipped
firetv_tv_codes.example.json there and edit). Run on the box over SSH.

Examples:
  python3 ~/.tvbox/firetv_remote_ir.py scan
  python3 ~/.tvbox/firetv_remote_ir.py info    AA:BB:CC:DD:EE:FF
  python3 ~/.tvbox/firetv_remote_ir.py blast   AA:BB:CC:DD:EE:FF --key VolumeUp
  python3 ~/.tvbox/firetv_remote_ir.py program AA:BB:CC:DD:EE:FF
  python3 ~/.tvbox/firetv_remote_ir.py program --dry-run          # no BLE, just show bytes
  python3 ~/.tvbox/firetv_remote_ir.py erase   AA:BB:CC:DD:EE:FF
"""
import argparse, asyncio, json, os, sys, uuid as _uuid

import ir_protocols
import keymap_compile as kc

# Standard GATT bits for identifying the remote (Device Information Service).
DIS_PNP_ID       = "00002a50-0000-1000-8000-00805f9b34fb"
DIS_MANUFACTURER = "00002a29-0000-1000-8000-00805f9b34fb"
DIS_MODEL        = "00002a24-0000-1000-8000-00805f9b34fb"
AMAZON_VID       = 0x0171

# Per-PID scan-id maps (key name -> the scan id the remote's firmware assigns to
# that physical key). Most Amazon remotes share the generic map (DEFAULT), but a
# few renumber Volume/Mute - the ORDER of keys on their keypad matrix differs.
# These are factual interoperability numbers observed in the Fire OS keymap
# resources (kml_key_name_scan_id_map_0x<PID>); getting them wrong binds an IR
# code to the wrong physical button (e.g. Volume-Down firing Mute), which is
# exactly what a stale/guessed map does. connect() reads the PnP PID and picks
# the right map here; unknown PIDs fall back to DEFAULT.
DEFAULT_SCAN_ID = kc.SCAN_ID  # 16-key map: Power=2 VolumeUp=6 VolumeDown=9 Mute=18
# The 42-key layout (Power=2 VolumeUp=12 VolumeDown=18 Mute=32) used by the
# larger Alexa Voice Remotes (with number pad / app buttons).
_SCAN_ID_42 = {"Power": 2, "VolumeUp": 12, "VolumeDown": 18, "Mute": 32,
               "Up": 1, "Right": 7, "Down": 13, "Left": 25, "Select": 19,
               "Back": 31, "Home": 14, "Menu": 37, "PlayPause": 6, "Rewind": 20}
SCAN_ID_BY_PID = {0x0414: _SCAN_ID_42, 0x0415: _SCAN_ID_42, 0x0418: _SCAN_ID_42}


def log(*a): print(*a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- config -------
def build_actions(spec, scan_id):
    """spec = {"duty_cycle":33, "keys": {"VolumeUp": {...}, ...}} ->
    dict key_name -> [action_bytes]. Each key entry has either "pronto"
    (+ optional "pronto_repeat") or "raw":[..]+"frequency". Optional per-key:
    repeat, post_delay, toggle_mask, optional, notify_host."""
    duty = int(spec.get("duty_cycle", 33))
    out = {}
    for key, k in spec["keys"].items():
        if key not in scan_id:
            log(f"! key {key!r} has no scan id for this remote, skipping"); continue
        optional = bool(k.get("optional", key == "Power"))
        repeat   = int(k.get("repeat", 1))
        pdelay   = int(k.get("post_delay", 1000 if key == "Power" else 0))
        tmask    = int(k.get("toggle_mask", 0))
        if "irdb" in k:                    # {"protocol":"NEC1","device":4,"subdevice":-1,"function":2}
            i = k["irdb"]
            enc = ir_protocols.encode(i["protocol"], i["device"], i.get("subdevice", -1), i["function"])
            act = kc.compile_ir_action([enc["raw"]], enc["frequency"], duty,
                                       max(repeat, enc["repeat"]), pdelay, tmask, "Basic", optional)
        elif "nec" in k:                   # {"address":0x04,"command":0x08} - LG & most TVs
            n = k["nec"]
            raw = kc.nec_raw(int(n["address"]), int(n["command"]))
            act = kc.compile_ir_action([raw], int(k.get("frequency", 38000)), duty,
                                       repeat, pdelay, tmask, "Basic", optional)
        elif "pronto" in k:
            act = kc.ir_action_from_pronto(
                k["pronto"], k.get("pronto_repeat"), duty, repeat, pdelay, tmask, optional)
        elif "raw" in k:
            seqs = [k["raw"]] + ([k["raw2"]] if "raw2" in k else [])
            act = kc.compile_ir_action(seqs, int(k["frequency"]), duty, repeat, pdelay,
                                       tmask, "Sequence" if "raw2" in k else "Basic", optional)
        else:
            log(f"! key {key!r} has no 'irdb'/'nec'/'pronto'/'raw', skipping"); continue
        actions = [act]
        if k.get("notify_host"):
            actions.append(kc.notify_host_action())
        out[key] = actions
    return out


def make_table(spec, scan_id, table_uuid):
    t = kc.KeyMapTable(table_uuid, scan_id)
    for key, actions in build_actions(spec, scan_id).items():
        t.add_key(key, actions)
    return t


def make_blast_table(spec, scan_id, key, table_uuid):
    """Fire OS 'InstantFire' stores the action under an empty key (scan id 0xFF);
    the remote just fires it, unbound to a physical key. Match that."""
    sub = {"duty_cycle": spec.get("duty_cycle", 33), "keys": {key: spec["keys"][key]}}
    actions = build_actions(sub, {key: scan_id.get(key, 0xFF)})[key]
    t = kc.KeyMapTable(table_uuid, scan_id)
    t.add_key("", actions)   # "" -> scan id 0xFF, matching InstantFire
    return t


# ---------------------------------------------------------------- BLE ----------
async def _read_pnp(client):
    try:
        v = await client.read_gatt_char(DIS_PNP_ID)
        vid = int.from_bytes(v[1:3], "little"); pid = int.from_bytes(v[3:5], "little")
        ver = int.from_bytes(v[5:7], "little")
        return vid, pid, ver
    except Exception as e:
        log(f"! could not read PnP ID: {e}"); return None, None, None


class Remote:
    """Thin async wrapper over the keymap GATT service (BleKeyMapDeviceProxyV2)."""
    def __init__(self, client):
        self.c = client
        self._blast_evt = asyncio.Event(); self._blast_status = None

    async def open(self):
        from bleak import BleakClient  # noqa
        # enable notifications like the Fire OS proxy does
        try:
            await self.c.start_notify(kc.CHAR_BLAST, self._on_blast)
        except Exception as e:
            log(f"! start_notify(BLAST) failed (continuing, will poll): {e}")

    def _on_blast(self, _char, data):
        self._blast_status = bytes(data); self._blast_evt.set()

    async def _write(self, char, data, response=True):
        await self.c.write_gatt_char(char, data, response=response)

    async def _write_chunked(self, char, data):
        for ch in kc.chunks(data, 200):
            await self._write(char, ch, response=True)

    async def start_table(self, table_uuid, length):
        await self._write(kc.CHAR_CONTROL, kc.frame_start_table(table_uuid, length))

    async def write_table(self, table):
        binary = table.compile_with_checksum()
        await self.start_table(table.uuid, len(binary))
        await self._write_chunked(kc.CHAR_MAPPING, binary)
        status = await self.c.read_gatt_char(kc.CHAR_MAPPING)
        ok = len(status) >= 1 and status[0] == 0x02
        log(f"  mapping status = {bytes(status).hex()}  -> {'OK' if ok else 'FAIL'}")
        return ok

    async def switch_table(self, table_uuid, toggle=0):
        await self._write(kc.CHAR_CONTROL, kc.frame_switch_table(table_uuid, toggle))

    async def blast(self, table, timeout=3.0):
        binary = table.compile_as_blast()
        self._blast_evt.clear(); self._blast_status = None
        await self.start_table(table.uuid, len(binary))
        await self._write_chunked(kc.CHAR_BLAST, binary)
        await self._write(kc.CHAR_CONTROL, kc.frame_commit_blast())
        try:
            await asyncio.wait_for(self._blast_evt.wait(), timeout)
            ok = self._blast_status and self._blast_status[0] == 0x02
        except asyncio.TimeoutError:
            status = await self.c.read_gatt_char(kc.CHAR_BLAST)  # fallback poll
            ok = len(status) >= 1 and status[0] == 0x02
            log(f"  (no notify) polled blast status = {bytes(status).hex()}")
        return bool(ok)

    async def erase_all(self):
        await self._write(kc.CHAR_CONTROL, kc.frame_delete_all())


async def _device_from_bluez(mac):
    """Build a BLEDevice straight from BlueZ's D-Bus object for a bonded remote.
    bleak's connect() only skips its discovery scan when it already has a device
    PATH - and a remote that's connected as a BT keyboard doesn't advertise, so
    the scan can never find it. We hand bleak the path from BlueZ's tree
    directly (the device is right there, GATT already resolved). Linux/BlueZ
    only; returns None if it can't."""
    try:
        from bleak.backends.bluezdbus.manager import get_global_bluez_manager
        from bleak.backends.device import BLEDevice

        want = mac.upper().replace(":", "_")
        m = await get_global_bluez_manager()
        for path, ifaces in m._properties.items():
            dev = ifaces.get("org.bluez.Device1")
            if not dev:
                continue
            if path.rstrip("/").endswith("dev_" + want):
                return BLEDevice(dev.get("Address", mac), dev.get("Name") or dev.get("Alias") or mac,
                                 {"path": path, "props": dev})
    except Exception as e:
        log(f"  bluez lookup failed: {e}")
    return None


async def _resolve_device(mac):
    """Find the remote for bleak. Prefer the bonded BlueZ object (works while the
    remote is connected as a keyboard, i.e. not advertising); fall back to a
    normal scan (idle/advertising remote); last resort the bare MAC."""
    dev = await _device_from_bluez(mac)
    if dev:
        return dev
    try:
        from bleak import BleakScanner
        dev = await BleakScanner.find_device_by_address(mac, timeout=8.0)
        if dev:
            return dev
    except Exception as e:
        log(f"  scan failed: {e}")
    return mac


async def connect(mac):
    from bleak import BleakClient
    c = BleakClient(await _resolve_device(mac))
    await c.connect()
    log(f"connected to {mac}")
    vid, pid, ver = await _read_pnp(c)
    if vid is not None:
        log(f"  VID=0x{vid:04X} PID=0x{pid:04X} ver=0x{ver:04X}"
            f"{'  (Amazon)' if vid == AMAZON_VID else '  (NOT Amazon VID!)'}")
    svcs = c.services
    have = any(str(s.uuid).lower() == kc.KEYMAP_SERVICE for s in svcs)
    log(f"  keymap service {kc.KEYMAP_SERVICE} {'present' if have else 'MISSING'}")
    if not have:
        log("  services found:")
        for s in svcs:
            log("   ", s.uuid)
    scan_id = SCAN_ID_BY_PID.get(pid, DEFAULT_SCAN_ID)
    return c, scan_id, have


# ---------------------------------------------------------------- commands -----
async def cmd_scan(_):
    from bleak import BleakScanner
    log("scanning 8s...")
    devs = await BleakScanner.discover(timeout=8.0, return_adv=True)
    for addr, (d, adv) in devs.items():
        name = (adv.local_name or d.name or "?")
        hint = "  <-- likely Amazon remote" if "fire" in name.lower() or "remote" in name.lower() else ""
        print(f"{addr}  rssi={adv.rssi:>4}  {name}{hint}")


async def cmd_info(args):
    c, scan_id, have = await connect(args.mac)
    try:
        for s in c.services:
            if str(s.uuid).lower() == kc.KEYMAP_SERVICE:
                for ch in s.characteristics:
                    print(f"  char {ch.uuid}  props={','.join(ch.properties)}")
    finally:
        await c.disconnect()


DEFAULT_CONFIG = os.path.expanduser("~/.tvbox/firetv_tv_codes.json")


def _load_spec(args):
    path = args.config or DEFAULT_CONFIG
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        log(f"! config not found: {path}"
            f"  (copy firetv_tv_codes.example.json -> {DEFAULT_CONFIG} and edit)")
        sys.exit(2)


async def cmd_blast(args):
    spec = _load_spec(args) if args.config else None
    if args.pronto:
        spec = {"duty_cycle": args.duty, "keys": {"_": {"pronto": args.pronto}}}
        key = "_"
    else:
        key = args.key or next(iter(spec["keys"]))
    scan_id = DEFAULT_SCAN_ID
    if args.dry_run:
        t = make_blast_table(spec, scan_id, key, args.uuid)
        _dump_table("blast", t, blast=True); return
    c, scan_id, have = await connect(args.mac)
    try:
        if not have: log("! keymap service missing; aborting"); sys.exit(3)
        t = make_blast_table(spec, scan_id, key, args.uuid)
        r = Remote(c); await r.open()
        ok = await r.blast(t)
        log(f"blast {key}: {'OK' if ok else 'FAILED'}")
        if not ok: sys.exit(1)
    finally:
        await c.disconnect()


async def cmd_program(args):
    spec = _load_spec(args)
    scan_id = DEFAULT_SCAN_ID
    if args.dry_run:
        t = make_table(spec, scan_id, args.uuid); _dump_table("program", t); return
    c, scan_id, have = await connect(args.mac)
    try:
        if not have: log("! keymap service missing; aborting"); sys.exit(3)
        t = make_table(spec, scan_id, args.uuid)
        r = Remote(c); await r.open()
        if await r.write_table(t):
            await r.switch_table(t.uuid)
            log(f"programmed + activated table {t.uuid} ({len(t.rows)} keys)")
        else:
            log("write_table failed"); sys.exit(1)
    finally:
        await c.disconnect()


async def cmd_erase(args):
    c, scan_id, have = await connect(args.mac)
    try:
        r = Remote(c); await r.open(); await r.erase_all(); log("erased all tables")
    finally:
        await c.disconnect()


async def cmd_sniff(args):
    """Subscribe to every notifiable characteristic and print what each button
    emits, so we learn THIS remote's real key -> scan-id mapping (the guessed
    DEFAULT_SCAN_ID is per-model and can be wrong). Press one button, note the
    line(s); the byte that changes per key is its scan id. Emits JSON lines
    (prefixed EVENT:) so the shell can parse a guided capture."""
    c, scan_id, have = await connect(args.mac)
    seen = {}
    try:
        def make_cb(uuid):
            def cb(_char, data):
                b = bytes(data)
                print(f"EVENT: {json.dumps({'char': uuid, 'hex': b.hex(), 'bytes': list(b)})}", flush=True)
            return cb

        subscribed = []
        for s in c.services:
            for ch in s.characteristics:
                props = ch.properties
                if "notify" in props or "indicate" in props:
                    try:
                        await c.start_notify(ch.uuid, make_cb(str(ch.uuid)))
                        subscribed.append(str(ch.uuid))
                    except Exception as e:
                        log(f"  notify {ch.uuid} failed: {e}")
        log(f"sniffing {len(subscribed)} characteristics; press remote buttons (Ctrl-C to stop)")
        for u in subscribed:
            log("  <-", u)
        await asyncio.sleep(args.seconds)
    finally:
        await c.disconnect()


async def cmd_discover(args):
    """Program a NOTIFY_HOST keymap over a range of scan ids, activate it, then
    sniff: each physical key press fires NOTIFY_HOST -> the remote indicates its
    scan id, so we learn THIS remote's real key->scan-id map. Restore the IR
    keymap afterwards with `program`. Emits EVENT: JSON lines for the shell."""
    c, scan_id, have = await connect(args.mac)
    try:
        if not have:
            log("! keymap service missing; aborting"); sys.exit(3)
        # The remote rejects a large table (a 48-row NOTIFY_HOST table returns
        # status 0x03); write in small batches and keep the first that sticks.
        # BATCH rows at a time still cover a useful id span, and most remotes'
        # Volume/Mute/Power ids sit low.
        r = Remote(c)
        await r.open()
        wrote = False
        for start in range(args.min, args.max + 1, args.batch):
            end = min(start + args.batch - 1, args.max)
            t = kc.KeyMapTable(args.uuid, dict(kc.SCAN_ID))
            for sid in range(start, end + 1):
                t.add_row(sid, [kc.notify_host_action()])
            if await r.write_table(t):
                await r.switch_table(t.uuid)
                log(f"discovery keymap active (scan ids {start}..{end}); press buttons")
                wrote = True
                break
            log(f"  batch {start}..{end} rejected, trying smaller")
        if not wrote:
            log("write_table (discovery) failed for every batch"); sys.exit(1)
        # NOTIFY_HOST fires on the keymap chars; subscribe to everything notifiable.
        for s in c.services:
            for ch in s.characteristics:
                if "notify" in ch.properties or "indicate" in ch.properties:
                    try:
                        await c.start_notify(
                            ch.uuid,
                            (lambda u: lambda _h, d: print(
                                f"EVENT: {json.dumps({'char': u, 'hex': bytes(d).hex(), 'bytes': list(bytes(d))})}",
                                flush=True))(str(ch.uuid)),
                        )
                    except Exception:
                        pass
        await asyncio.sleep(args.seconds)
    finally:
        await c.disconnect()


def _dump_table(what, t, blast=False):
    binary = t.compile_as_blast() if blast else t.compile_with_checksum()
    print(f"[{what}] table uuid = {t.uuid}")
    for key, actions in t.rows:
        print(f"  key {key:<10} scan_id={t.scan_id.get(key, 0xFF)} actions={len(actions)}")
    print("  start-table frame:", kc.frame_start_table(t.uuid, len(binary)).hex())
    print(f"  payload ({len(binary)}B):", binary.hex())
    print("  chunks(200):", [len(x) for x in kc.chunks(binary, 200)])
    if not blast:
        print("  switch frame:", kc.frame_switch_table(t.uuid).hex())


def main():
    p = argparse.ArgumentParser(description="Program Fire TV remote IR over BLE (no Fire TV).")
    p.add_argument("--uuid", default="a5510000-0000-4000-a000-000000000001",
                   help="table UUID to store the keymap under")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("scan").set_defaults(fn=cmd_scan)

    pi = sub.add_parser("info"); pi.add_argument("mac"); pi.set_defaults(fn=cmd_info)

    pb = sub.add_parser("blast")
    pb.add_argument("mac", nargs="?"); pb.add_argument("--config")
    pb.add_argument("--key"); pb.add_argument("--pronto")
    pb.add_argument("--duty", type=int, default=33)
    pb.add_argument("--dry-run", action="store_true"); pb.set_defaults(fn=cmd_blast)

    pp = sub.add_parser("program")
    pp.add_argument("mac", nargs="?"); pp.add_argument("--config")
    pp.add_argument("--dry-run", action="store_true"); pp.set_defaults(fn=cmd_program)

    pe = sub.add_parser("erase"); pe.add_argument("mac"); pe.set_defaults(fn=cmd_erase)

    ps = sub.add_parser("sniff"); ps.add_argument("mac")
    ps.add_argument("--seconds", type=int, default=60); ps.set_defaults(fn=cmd_sniff)

    pd = sub.add_parser("discover"); pd.add_argument("mac")
    pd.add_argument("--min", type=int, default=0); pd.add_argument("--max", type=int, default=31)
    pd.add_argument("--batch", type=int, default=16); pd.add_argument("--seconds", type=int, default=75)
    pd.set_defaults(fn=cmd_discover)

    args = p.parse_args()
    asyncio.run(args.fn(args))


if __name__ == "__main__":
    main()
