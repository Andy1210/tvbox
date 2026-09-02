#!/usr/bin/env python3
"""Offline unit tests for the resident blast service in firetv_remote_ir.py
(run: python3 remote/firetv_remote_ir_test.py). No BLE, no bleak, no remote.

The service exists because of one measured asymmetry: a blast over an ALREADY
OPEN link costs about a second, while a fresh process pays a BLE connect on top
and - after its own disconnect - cannot reach the remote at all until somebody
presses a button on it. Several blasts inside ONE connection work; a second
PROCESS over a link the first left up hangs. So what has to be right here is the
link's lifecycle, and every case below is one way of getting it wrong: holding a
link that died, opening a second one while a blast is in flight, keeping the
link when a one-shot command needs it, or turning a sleeping remote into an
error a person cannot act on.

`bleak` is not installed on a CI runner, and the module imports it lazily inside
connect() - which is replaced here, so the import never runs.
"""
import asyncio
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import firetv_remote_ir as f  # noqa: E402
import keymap_compile as kc  # noqa: E402

FAILED = []


def check(name, got, want):
    if got != want:
        FAILED.append(name)
        print("FAIL %s\n  got  %r\n  want %r" % (name, got, want))
        return
    print("ok", name)


f.log = lambda *a: None

# A code the encoders accept: NEC1, the shape scripts/ir-index publishes.
SPEC = {"duty_cycle": 33, "keys": {"Power": {"irdb": {"protocol": "NEC1", "device": 4,
                                                      "subdevice": -1, "function": 206}}}}


# ---- fakes ------------------------------------------------------------------
class FakeClient:
    def __init__(self):
        self.is_connected = True
        self.disconnects = 0

    async def disconnect(self):
        self.disconnects += 1
        self.is_connected = False


class FakeRemote:
    """Records what the service asked of the radio, and can fail on demand."""

    def __init__(self, client):
        self.c = client
        self.opened = 0
        self.calls = []
        self.result = True
        self.raise_with = None

    async def open(self):
        self.opened += 1

    async def blast(self, table, timeout=0.06, uuid=None, pad=False, retries=1):
        self.calls.append({"uuid": uuid, "pad": pad, "retries": retries})
        if self.raise_with is not None:
            raise self.raise_with
        return self.result


def install(monkey):
    """Replace connect()/Remote with fakes and hand back the live objects."""
    state = {"connects": 0, "clients": [], "remotes": [], "have": True, "fail": None}

    async def fake_connect(mac, timeout=None):
        state["connects"] += 1
        state["timeout"] = timeout
        if state["fail"] is not None:
            raise state["fail"]
        c = FakeClient()
        state["clients"].append(c)
        return c, f.DEFAULT_SCAN_ID, state["have"]

    def fake_remote(client):
        r = FakeRemote(client)
        state["remotes"].append(r)
        return r

    monkey["connect"], monkey["Remote"] = f.connect, f.Remote
    f.connect, f.Remote = fake_connect, fake_remote
    return state


def restore(monkey):
    f.connect, f.Remote = monkey["connect"], monkey["Remote"]


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ---- the blast shape the firmware's own client sends ------------------------
# Reading BleKeyMapDeviceProxyV2: a blast is staged under the NULL table id (a blast
# table is throwaway, and buildBlastTables never sets one), written in fixed 200-byte
# chunks with the tail zero-padded, committed with CONTROL 5, and - when no
# notification arrives - decided by READING the characteristic up to nine times. This
# remote never notifies, and the first read routinely answers "not done", so the
# retries are the difference between a working blast and one reported as failed.
check("a blast stages under the null table id", kc.BLAST_TABLE_UUID,
      "00000000-0000-0000-0000-000000000000")
check("the start-table frame is 22 bytes, reset-staging + sha2",
      (len(kc.frame_start_table(kc.BLAST_TABLE_UUID, 176)),
       kc.frame_start_table(kc.BLAST_TABLE_UUID, 176)[:2].hex()), (22, "0201"))
check("its id bytes are the 16 zeros, not a table of ours",
      kc.frame_start_table(kc.BLAST_TABLE_UUID, 176)[2:18], bytes(16))
check("commit is CONTROL 5", kc.frame_commit_blast(), bytes([5]))
check("enable-SDS is CONTROL 32", kc.frame_enable_sds(), bytes([32]))
check("the padded tail is a full chunk", [len(x) for x in kc.chunks(b"x" * 176, 200, pad=True)],
      [200])
check("an unpadded tail is short", [len(x) for x in kc.chunks(b"x" * 176, 200)], [176])
check("padding leaves the data alone", kc.chunks(b"ab", 4, pad=True)[0], b"ab\x00\x00")
check("a whole-multiple payload is not grown",
      [len(x) for x in kc.chunks(b"x" * 400, 200, pad=True)], [200, 200])
check("nothing to send stays nothing", kc.chunks(b"", 200, pad=True), [])


# ---- the link's lifecycle ---------------------------------------------------
monkey = {}
state = install(monkey)
try:
    svc = f.BlastService("AA:BB:CC:DD:EE:FF")
    check("cold service holds no link", svc.connected(), False)

    run(svc.blast(SPEC, "Power"))
    check("the first blast connects once", state["connects"], 1)
    check("and the connect is bounded, not bleak's 30 s default", state["timeout"], 8.0)
    check("the link is kept afterwards", svc.connected(), True)
    check("the blast is sent in the firmware's shape",
          state["remotes"][0].calls, [{"uuid": kc.BLAST_TABLE_UUID, "pad": True, "retries": 9}])

    # The whole point: the SECOND blast must not pay a connect. A per-blast process
    # did, and after its disconnect the remote was unreachable until a button press.
    run(svc.blast(SPEC, "Power"))
    check("the second blast reuses the link", state["connects"], 1)
    check("both blasts went through one Remote", len(state["remotes"]), 1)
    check("the service counted them", svc.blasts, 2)

    # A link that died under us must be forgotten, not written into.
    state["clients"][0].is_connected = False
    run(svc.blast(SPEC, "Power"))
    check("a dropped link is replaced, not reused", state["connects"], 2)
    check("and the new link is open", svc.connected(), True)

    # release() is what lets program/test/info open their own link: the remote takes
    # one connection, so a resident holder has to step aside.
    run(svc.release())
    check("release drops the link", svc.connected(), False)
    check("and it really disconnected", state["clients"][-1].disconnects, 1)
    run(svc.blast(SPEC, "Power"))
    check("a blast after release opens a new link", state["connects"], 3)
finally:
    restore(monkey)


# ---- failures, and telling them apart --------------------------------------
monkey = {}
state = install(monkey)
try:
    svc = f.BlastService("AA:BB:CC:DD:EE:FF")
    state["fail"] = asyncio.TimeoutError()

    async def blast_err(svc, spec=SPEC, key="Power"):
        try:
            await svc.blast(spec, key)
        except f.ToolError as ex:
            return ex.code
        return None

    check("a remote that cannot be connected to is 'asleep', which is the one a "
          "person can fix", run(blast_err(svc)), "asleep")
    check("nothing is left holding a link after that", svc.connected(), False)

    state["fail"] = None
    state["have"] = False
    check("no keymap service is its own code", run(blast_err(svc)), "nokeymap")
    check("and that connect was closed again", state["clients"][-1].disconnects, 1)

    state["have"] = True
    before = state["connects"]
    check("a code this build cannot encode is not a wake problem",
          run(blast_err(svc, {"duty_cycle": 33,
                              "keys": {"Power": {"irdb": {"protocol": "NoSuchProtocol",
                                                          "device": 1, "subdevice": -1,
                                                          "function": 2}}}}, "Power")),
          "badcode")
    check("...and it never touched the radio", state["connects"], before)

    run(svc.blast(SPEC, "Power"))
    state["remotes"][-1].result = False
    check("a remote that took the table but did not fire is not 'asleep'",
          run(blast_err(svc)), "notfired")
    check("a blast that did not fire leaves the link up - the remote is right there",
          svc.connected(), True)

    state["remotes"][-1].raise_with = OSError("link gone")
    # Deliberately not "asleep": the code may have gone out, so the answer must not be
    # "press a button and retry" - retrying a power toggle undoes it.
    check("a link lost mid-blast is its own failure", run(blast_err(svc)), "linklost")
    check("and is forgotten so the next blast reconnects", svc.connected(), False)
finally:
    restore(monkey)


# ---- what a request is allowed to ask for -----------------------------------
# The socket lives in the user's home, and everything on this box runs as that user -
# store-installed apps, native apps, an app's in-process plugin. So the service holds a
# request to the shape shell/firetvir.js's resolveBlast can actually produce, rather
# than handing what arrives to the keymap compiler. Every case below was accepted with
# ok:true before this check, measured through the real socket.
def spec_err(spec, key="Power"):
    try:
        f.check_blast_request(spec, key)
    except f.ToolError as ex:
        return ex.code
    return None


ENTRY = SPEC["keys"]["Power"]
check("the shell's own spec passes", spec_err(SPEC), None)
check("...and so does the Power spec with its two quirks",
      spec_err({"name": "tv Power", "source": "TV", "duty_cycle": 33,
                "keys": {"Power": {**ENTRY, "optional": True, "post_delay": 1000}}}), None)
check("a raw capture passes", spec_err({"duty_cycle": 33, "keys": {"Power": {
          "raw": [4500, 4500, 560], "frequency": 38000}}}), None)
check("repeat is not a field any plan carries",
      spec_err({"duty_cycle": 33, "keys": {"Power": {**ENTRY, "repeat": 4294967295}}}),
      "badspec")
check("nor is toggle_mask", spec_err({"duty_cycle": 33, "keys": {"Power": {
          **ENTRY, "toggle_mask": 65535}}}), "badspec")
check("nor notify_host", spec_err({"duty_cycle": 33, "keys": {"Power": {
          **ENTRY, "notify_host": True}}}), "badspec")
check("a pronto code is not one of the three the index publishes",
      spec_err({"duty_cycle": 33, "keys": {"Power": {"pronto": "0000 006D 0022 0002"}}}),
      "badspec")
check("an unknown top-level field is refused",
      spec_err({"duty_cycle": 33, "keys": {"Power": ENTRY}, "wat": 1}), "badspec")
check("a 20,000-timing raw capture is refused - the index caps a real one at 512",
      spec_err({"duty_cycle": 33, "keys": {"Power": {"raw": [500] * 20000,
                                                     "frequency": 38000}}}), "badspec")
check("a timing wider than the wire format is refused",
      spec_err({"duty_cycle": 33, "keys": {"Power": {"raw": [500, 70000],
                                                     "frequency": 38000}}}), "badspec")
check("a duty cycle outside 1..99 is refused",
      spec_err({"duty_cycle": 0, "keys": {"Power": ENTRY}}), "badspec")
check("a float where an int belongs is refused",
      spec_err({"duty_cycle": 33, "keys": {"Power": {**ENTRY, "post_delay": 1e308}}}),
      "badspec")
check("a boolean is not a number", spec_err({"duty_cycle": True,
                                             "keys": {"Power": ENTRY}}), "badspec")
check("the spec must carry the key being blasted, and only it",
      spec_err({"duty_cycle": 33, "keys": {"Mute": ENTRY}}, "Power"), "badspec")
check("two keys in one blast is not a shape the shell makes",
      spec_err({"duty_cycle": 33, "keys": {"Power": ENTRY, "Mute": ENTRY}}, "Power"),
      "badspec")
check("two code sources in one entry is refused",
      spec_err({"duty_cycle": 33, "keys": {"Power": {**ENTRY, "raw": [500, 500],
                                                     "frequency": 38000}}}), "badspec")
check("no code source at all is refused",
      spec_err({"duty_cycle": 33, "keys": {"Power": {"optional": True}}}), "badspec")
check("a key name that is not one is refused", spec_err(SPEC, "../../etc/passwd"),
      "badspec")
check("an empty key name is refused", spec_err({"duty_cycle": 33, "keys": {"": ENTRY}}, ""),
      "badspec")
check("a spec that is not an object is refused", spec_err([1, 2, 3]), "badspec")

# The service also refuses to queue an unbounded pile of seconds-long radio work.
monkey = {}
state = install(monkey)
try:
    svc = f.BlastService("AA:BB:CC:DD:EE:FF")

    async def pile(n):
        # Hold the lock, then send n more at it.
        await svc.blast(SPEC, "Power")
        held = asyncio.Event()

        async def slow(*a, **k):
            await held.wait()
            return True

        state["remotes"][-1].blast = slow
        tasks = [asyncio.ensure_future(svc.blast(SPEC, "Power")) for _ in range(n)]
        await asyncio.sleep(0)
        codes = []
        for t in tasks:
            if t.done():
                try:
                    t.result()
                except f.ToolError as ex:
                    codes.append(ex.code)
        held.set()
        await asyncio.gather(*tasks, return_exceptions=True)
        return codes

    check("a pile of queued blasts is refused rather than served hours later",
          run(pile(6)), ["busy"] * (6 - f.MAX_WAITING))
finally:
    restore(monkey)

# And a one-shot command's hold window: after a release, a blast must NOT take the
# link back - measured on the box, it spent its whole connect budget doing exactly that
# while a 60 s programming run was using the remote.
monkey = {}
state = install(monkey)
try:
    svc = f.BlastService("AA:BB:CC:DD:EE:FF")
    run(svc.blast(SPEC, "Power"))

    async def held_err():
        await svc.release(hold_ms=60000)
        try:
            await svc.blast(SPEC, "Power")
        except f.ToolError as ex:
            return ex.code
        return None

    check("a blast during a one-shot's hold window is refused, not connected",
          run(held_err()), "busy")
    before = state["connects"]
    check("...and it did not touch the radio", state["connects"], before)
    run(svc.resume())
    run(svc.blast(SPEC, "Power"))
    check("resume lets the link come back", svc.connected(), True)
finally:
    restore(monkey)


# ---- the request protocol ---------------------------------------------------
monkey = {}
state = install(monkey)
try:
    svc = f.BlastService("AA:BB:CC:DD:EE:FF")
    req = lambda obj: run(f._serve_request(svc, json.dumps(obj)))  # noqa: E731

    r = req({"cmd": "status"})
    check("status answers with the protocol version",
          (r["ok"], r["proto"], r["connected"], r["blasts"]), (True, f.SERVE_PROTO, False, 0))

    r = req({"cmd": "blast", "spec": SPEC, "key": "Power"})
    check("a blast request answers ok and how long it took", (r["ok"], "ms" in r), (True, True))
    check("status then reports the held link", req({"cmd": "status"})["connected"], True)

    r = req({"cmd": "blast", "key": "Power"})
    check("a request with no spec is a protocol error, not a blast",
          (r["ok"], r["code"]), (False, "protocol"))
    r = req({"cmd": "blast", "spec": SPEC})
    check("nor with no key", (r["ok"], r["code"]), (False, "protocol"))
    r = req({"cmd": "blast", "spec": "Power", "key": "Power"})
    check("a spec that is not an object is refused", (r["ok"], r["code"]), (False, "protocol"))
    check("the failed requests blasted nothing", svc.blasts, 1)

    r = req({"cmd": "release"})
    check("release is answered, with the link state", (r["ok"], r["connected"]), (True, False))
    check("and it dropped the link", svc.connected(), False)
    check("every reply carries the protocol version, so a version skew is visible",
          req({"cmd": "release"})["proto"], f.SERVE_PROTO)
    r = req({"cmd": "release", "hold_ms": 400000})
    check("an absurd hold window is refused", (r["ok"], r["code"]), (False, "protocol"))
    r = req({"cmd": "release", "hold_ms": True})
    check("...and so is a boolean pretending to be one", (r["ok"], r["code"]),
          (False, "protocol"))

    r = run(f._serve_request(svc, "not json at all"))
    check("a line that is not JSON does not kill the server",
          (r["ok"], r["code"]), (False, "protocol"))
    r = run(f._serve_request(svc, "[1,2,3]"))
    check("nor does a JSON value that is not an object",
          (r["ok"], r["code"]), (False, "protocol"))
    r = req({"cmd": "nonsense"})
    check("an unknown command names itself", (r["ok"], r["code"]), (False, "protocol"))
    r = req({})
    check("so does a missing one", (r["ok"], r["code"]), (False, "protocol"))
    check("stop asks the server to exit", req({"cmd": "stop"}), {"ok": True, "_stop": True})
finally:
    restore(monkey)


# ---- the socket ------------------------------------------------------------
monkey = {}
state = install(monkey)
try:
    async def serve_and_talk():
        d = tempfile.mkdtemp()
        sock = os.path.join(d, "ir.sock")
        # a stale file from a killed server must not make every connect fail
        open(sock, "w").close()
        args = type("A", (), {"mac": "AA:BB:CC:DD:EE:FF", "socket": sock,
                              "connect_timeout": 8.0, "blast_uuid": kc.BLAST_TABLE_UUID,
                              "no_pad": False, "read_retries": 9})()
        task = asyncio.ensure_future(f.cmd_serve(args))
        for _ in range(200):
            await asyncio.sleep(0.01)
            if os.path.exists(sock) and os.path.getsize(sock) == 0:
                break

        async def ask(obj):
            reader, writer = await asyncio.open_unix_connection(sock)
            writer.write((json.dumps(obj) + "\n").encode())
            await writer.drain()
            line = await asyncio.wait_for(reader.readline(), 5.0)
            writer.close()
            return json.loads(line)

        mode = os.stat(sock).st_mode & 0o777
        first = await ask({"cmd": "blast", "spec": SPEC, "key": "Power"})
        second = await ask({"cmd": "blast", "spec": SPEC, "key": "Power"})
        st = await ask({"cmd": "status"})
        await ask({"cmd": "stop"})
        await asyncio.wait_for(task, 5.0)
        return mode, first["ok"], second["ok"], st["blasts"], os.path.exists(sock)

    mode, first, second, blasts, left = run(serve_and_talk())
    check("the socket is the user's alone - the plan and the codes are theirs", mode, 0o600)
    check("a request over the socket blasts", first, True)
    check("a second request over the socket blasts too", second, True)
    check("both went through the one held link", (blasts, state["connects"]), (2, 1))
    check("stopping cleans the socket up", left, False)
finally:
    restore(monkey)

if FAILED:
    print("\n%d FAILED: %s" % (len(FAILED), ", ".join(FAILED)))
    sys.exit(1)
print("\nall firetv_remote_ir tests passed")
