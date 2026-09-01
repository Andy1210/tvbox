// Fire TV remote IR programming from the Settings UI (docs/firetv-remote-ir.md).
// Three concerns, all root-free and OTA-safe:
//
//   deps   - bleak lives in a user-space venv (~/.tvbox/pyenv), created and
//            version-pinned from the UI; needs python3-venv (provision installs
//            it, OTA-only boxes degrade with a clear message).
//   codes  - browsing goes through shell/irindex.js: the published index built from
//            irdb AND Flipper-IRDB (scripts/ir-index/), one small file per brand. The
//            box no longer downloads a database itself.
//   BLE    - blast/program/erase shell out to ~/.tvbox/firetv_remote_ir.py
//            with the venv's python (the remote's GATT keymap service does the
//            rest; see remote/keymap_compile.py).
//
// The saved plan carries the CODES, not references to them, so programming a remote
// needs no network at all - and an index that changed upstream cannot alter what a
// remote already set up would be written with.
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const edid = require("./edid");
const irindex = require("./irindex");

const TVBOX = path.join(os.homedir(), ".tvbox");
const PYENV = path.join(TVBOX, "pyenv");
const PY = path.join(PYENV, "bin", "python3");
const TOOL = path.join(TVBOX, "firetv_remote_ir.py");
const CODES_FILE = path.join(TVBOX, "firetv_tv_codes.json");
const TEST_CODES_FILE = path.join(TVBOX, "firetv_tv_codes.test.json"); // a blast, which stores nothing
// The user's "latest deps" stance, but pinned so an install is reproducible;
// dbus-fast ships aarch64 manylinux wheels, so no compiler is needed on the box.
const PIP_PACKAGES = ["bleak==3.0.2", "dbus-fast==5.0.22"];

// TV make -> the brand a person would pick, so the picker can offer it first. The box
// learns the make from the HDMI EDID or the CEC vendor id.
// EDID manufacturer id -> brand. These are PNP ids, registered long before the brands
// were what they are now, so none of them can be guessed from the name: LG's is
// Goldstar's, Philips' is its own three letters, and Panasonic files as Matsushita.
const PNP_BRAND = {
  GSM: "LG",
  LGE: "LG",
  SAM: "Samsung",
  SNY: "Sony",
  PHL: "Philips",
  MEI: "Panasonic",
  TSB: "Toshiba",
  HIS: "Hisense",
  TCL: "TCL",
  SHP: "Sharp",
  VIZ: "Vizio",
  GRU: "Grundig",
  LOE: "Loewe",
  JVC: "JVC",
};
const CEC_VENDOR_BRAND = {
  "00e091": "LG",
  "00e0a6": "Sony", // some Sony sets
  "080046": "Sony",
  "0000f0": "Samsung",
  "0005cd": "Panasonic", // some Panasonic
  "008045": "Panasonic",
  "00903e": "Philips",
  "0010fa": "Toshiba",
};
function makeToBrand(make) {
  const s = (make || "").toLowerCase();
  const table = [
    ["lg", "LG"],
    ["samsung", "Samsung"],
    ["sony", "Sony"],
    ["panasonic", "Panasonic"],
    ["philips", "Philips"],
    ["vizio", "Vizio"],
    ["hisense", "Hisense"],
    ["tcl", "TCL"],
    ["sharp", "Sharp"],
    ["toshiba", "Toshiba"],
    ["grundig", "Grundig"],
    ["loewe", "Loewe"],
    ["jvc", "JVC"],
  ];
  for (const [needle, brand] of table) if (s.includes(needle)) return brand;
  return null;
}
// The connected TV's brand, from the EDID first (most reliable), else the CEC vendor id
// the CEC bridge stored. Best-effort + fast; null -> no suggestion.
//
// The EDID is read from sysfs rather than asked of the compositor: it is there before
// the session starts, so this answers the same on a box whose session is down.
function suggestedBrand(cb) {
  const block = edid.read();
  // The set's own name first ("LG TV"), then the registered id: a name is what a human
  // would recognise, an id is what a set that names itself "TV" still has.
  const fromEdid = makeToBrand(edid.name(block)) || PNP_BRAND[edid.manufacturer(block) || ""];
  if (fromEdid) return cb(fromEdid);
  let vendor = "";
  try {
    vendor = fs.readFileSync(path.join(TVBOX, "cec_tv_vendor"), "utf8").trim().toLowerCase();
  } catch (e) {}
  cb(CEC_VENDOR_BRAND[vendor] || null);
}

// The keymap GATT service a programmable Amazon remote exposes. Its presence on a
// bonded device is a precise "this is a Fire TV / Alexa remote we can program" signal
// (no false positives) - used to show the IR feature ONLY under such a remote in the
// remap UI, never for other remotes.
const KEYMAP_SERVICE = "fe151500";

// MACs (lowercase) of currently-connected remotes that expose the keymap service.
// Cached briefly - bluetoothctl is cheap but this is polled from the UI.
let progCache = { ts: 0, macs: [] };
function programmableRemotes(cb) {
  if (Date.now() - progCache.ts < 8000) return cb(progCache.macs);
  execFile("bluetoothctl", ["devices", "Connected"], { timeout: 5000 }, (err, out) => {
    // Fall back to all known devices if "Connected" filter isn't supported.
    const list = (m) =>
      (m || "")
        .split("\n")
        .map((l) => /Device ([0-9A-F:]{17})/i.exec(l))
        .filter(Boolean)
        .map((x) => x[1]);
    const run = (macs) => {
      const found = [];
      let pending = macs.length;
      if (!pending) {
        progCache = { ts: Date.now(), macs: found };
        return cb(found);
      }
      macs.forEach((mac) =>
        execFile("bluetoothctl", ["info", mac], { timeout: 5000 }, (e2, info) => {
          if (!e2 && /Connected: yes/i.test(info) && new RegExp(KEYMAP_SERVICE, "i").test(info)) {
            found.push(mac.toLowerCase());
          }
          if (--pending === 0) {
            progCache = { ts: Date.now(), macs: found };
            cb(found);
          }
        }),
      );
    };
    if (!err && list(out).length) return run(list(out));
    execFile("bluetoothctl", ["devices"], { timeout: 5000 }, (e2, all) => run(list(all)));
  });
}

// ---- deps (venv + bleak) --------------------------------------------------------
let depsState = { running: false, step: "", error: "" };
let depsOkCached = null; // null = unknown, needs a probe

function probeDeps(cb) {
  if (depsOkCached !== null) return cb(depsOkCached);
  if (!fs.existsSync(PY)) {
    depsOkCached = false;
    return cb(false);
  }
  execFile(PY, ["-c", "import bleak"], { timeout: 10000 }, (err) => {
    depsOkCached = !err;
    cb(!err);
  });
}

function installDeps() {
  if (depsState.running) return false;
  depsState = { running: true, step: "venv", error: "" };
  const fail = (msg) => {
    console.warn("[firetvir] deps install failed:", msg);
    depsState = { running: false, step: "", error: String(msg).slice(0, 300) };
  };
  const pipInstall = () => {
    depsState.step = "pip";
    execFile(
      PY,
      ["-m", "pip", "install", "--no-input", "--disable-pip-version-check", ...PIP_PACKAGES],
      { timeout: 300000 },
      (err, _out, stderr) => {
        if (err) return fail(stderr || err.message);
        depsOkCached = null; // re-probe on next status
        depsState = { running: false, step: "", error: "" };
        console.log("[firetvir] bleak installed into", PYENV);
      },
    );
  };
  if (fs.existsSync(PY)) return (pipInstall(), true);
  execFile("python3", ["-m", "venv", PYENV], { timeout: 120000 }, (err, _out, stderr) => {
    if (err) return fail("python3 -m venv failed (python3-venv missing?): " + (stderr || err.message));
    pipInstall();
  });
  return true;
}

// ---- which codes this box can actually generate -------------------------------------
// The index is built for every box, and a box updates on its own schedule, so what it
// can send is its OWN question: the encoders are two python modules it ships
// (remote/ir_protocols.py, remote/flipper_protocols.py). Asked once per process and
// answered as protocol NAMES, so a brand screen costs no subprocess at all.
//
// A raw code needs no encoder - it is sent verbatim - so it is always sendable.
let protocolsMemo = null;

function supportedProtocols(cb) {
  if (protocolsMemo) return cb(protocolsMemo);
  const py = fs.existsSync(PY) ? PY : "python3";
  execFile(
    py,
    [
      "-c",
      "import sys,json; sys.path.insert(0,sys.argv[1]);" +
        "import ir_protocols as a;" +
        "out={'irdb':sorted(a.ENCODERS)};" +
        "\ntry:\n import flipper_protocols as b; out['flipper']=sorted(b.ENCODERS)\nexcept Exception: out['flipper']=[]\n" +
        "print(json.dumps(out))",
      TVBOX,
    ],
    { timeout: 10000 },
    (err, out) => {
      // A probe that could not run must not read as "nothing works": the row would be
      // greyed out for a code that sends fine. Unknown means offered.
      if (err) return cb(null);
      try {
        const parsed = JSON.parse(out);
        protocolsMemo = {
          irdb: new Set((parsed.irdb || []).map((s) => String(s).toLowerCase())),
          flipper: new Set((parsed.flipper || []).map((s) => String(s).toLowerCase())),
        };
        cb(protocolsMemo);
      } catch (e) {
        cb(null);
      }
    },
  );
}

// One key's code -> can this box send it? `null` for "could not tell".
function codeSendable(code, supported) {
  if (!code || !code.entry) return false;
  if (code.entry.raw) return true;
  if (!supported) return null;
  if (code.entry.flipper) return supported.flipper.has(String(code.entry.flipper.protocol || "").toLowerCase());
  if (code.entry.irdb)
    return supported.irdb.has(
      String(code.entry.irdb.protocol || "")
        .trim()
        .toLowerCase(),
    );
  return false;
}

// The picker's list for one brand, with `usable` decided by this box. A device is
// usable when every button it can PROGRAM can be sent; `null` means the probe could not
// run, and the UI offers those rather than hiding codes that may work.
//
// The programmable four only. A device row also carries input codes now, and judging
// those too marked a TV whose Power and Volume are perfectly sendable as unusable
// because one HDMI code used a protocol this build cannot encode - hiding a working
// device over a key no button can hold anyway.
function brandDevices(slug, cb) {
  irindex.fetchBrand(slug, (err, answer) => {
    if (err) return cb(err);
    supportedProtocols((supported) => {
      const devices = answer.devices.map((d) => {
        const verdicts = PROGRAMMABLE_KEYS.filter((k) => d.keys[k]).map((k) => codeSendable(d.keys[k], supported));
        return { ...d, usable: verdicts.some((v) => v === false) ? false : verdicts.includes(null) ? null : true };
      });
      cb(null, { brand: answer.brand, slug, devices, skipped: answer.skipped });
    });
  });
}

// The brand list, plus the notice the databases' licences require to travel with them.
function brands(cb) {
  irindex.fetchIndex((err, index) => {
    if (err) return cb(err);
    cb(null, { revision: index.revision, generated: index.generated, notice: index.notice, brands: index.brands });
  });
}

// ---- the saved plan: which devices this remote drives, and from which button -------
// The programmed keymap lives on the REMOTE and cannot be read back, so without this a
// second visit would show a blank screen for a remote that is fully set up. Kept per
// MAC, next to the box's other settings, and carried by a backup.
const PLAN_FILE = path.join(TVBOX, "firetv_ir_plan.json");
const MAX_PLAN_BYTES = 256e3;
const MAX_PLAN_DEVICES = 8;
const IR_KEYS = irindex.IR_KEYS;
// The subset that can be written onto the remote's own buttons. The rest of IR_KEYS
// exists to be blasted, and a blast needs no scan id - but the keymap does, so the
// firmware has one only for these four. Keeping the two apart matters in three places:
// a device is `usable` if it can fill a BUTTON, only these may be assigned to one, and
// `resolvePlan` must not build a spec whose every key the python side then skips -
// which writes a zero-row table and reports a successful programming of nothing.
const PROGRAMMABLE_KEYS = irindex.PROGRAMMABLE_KEYS;
const KINDS = new Set(["tv", "audio", "settop", "player", "climate", "other"]);
const str = (v, max) => String(v == null ? "" : v).slice(0, max);
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

// Everything here arrives from the launcher and ends up as an IR code written onto a
// remote, so it is re-checked rather than trusted - `irindex.sanitizeCode` is the same
// check the published index goes through.
//
// EVERY field is bounded, not just the number of devices. The count is what the caller
// controls least: a `keys` object repeated a hundred thousand times passes a membership
// filter, and a file this module can no longer read (readPlans) reports EVERY remote as
// unconfigured - for a setting whose whole reason to exist is that the remote cannot be
// read back.
function sanitizePlan(raw) {
  const devices = [];
  for (const d of Array.isArray(raw && raw.devices) ? raw.devices.slice(0, MAX_PLAN_DEVICES) : []) {
    if (!d || !/^[a-f0-9]{6,32}$/.test(String(d.id || ""))) continue;
    const keys = {};
    for (const k of IR_KEYS) {
      const code = irindex.sanitizeCode((d.keys || {})[k]);
      if (code) keys[k] = code;
    }
    if (!Object.keys(keys).length) continue; // a device that can drive nothing
    devices.push({
      id: String(d.id),
      brand: str(d.brand, 60),
      slug: irindex.validSlug(d.slug) ? d.slug : "",
      label: str(d.label, 60),
      kind: KINDS.has(d.kind) ? d.kind : "other",
      keys,
      // How many codesets across both databases carry this same code - shown on the
      // device screen so a merged row can say what it merged.
      count: Number.isFinite(d.count) ? Math.min(9999, Math.max(1, Math.round(d.count))) : 1,
      sources: (Array.isArray(d.sources) ? d.sources : []).filter((s) => s === "irdb" || s === "flipper"),
    });
  }
  // A button may only name a device whose code actually carries it. Without this the
  // screen can read "Power - Samsung Sound Bar", the save reports success, and the
  // button does nothing: resolvePlan skips a key it has no code for, silently. The box
  // is the authority on that, not the screen that assembled the plan.
  const canSend = (id, key) => devices.some((d) => d.id === id && d.keys[key]);
  const assign = {};
  for (const key of PROGRAMMABLE_KEYS) {
    const a = (raw && raw.assign && raw.assign[key]) || null;
    if (!a || !canSend(a.device, key)) continue;
    assign[key] = {
      device: String(a.device),
      second: canSend(a.second, key) && a.second !== a.device ? String(a.second) : null,
    };
  }
  // What was last written to THIS remote, if anything. It lives here rather than in the
  // box-wide codes file because it is a fact about one remote.
  const pr = raw && raw.programmed;
  const programmed = pr && typeof pr === "object" && pr.label ? { label: str(pr.label, 60), ts: num(pr.ts) } : null;
  // Carried, not stamped: `ts` says when the setup was saved, and a read is not a save.
  // writePlan is what sets it.
  return { devices, assign, programmed, ts: num(raw && raw.ts) };
}

// {} = no file yet. null = there IS one and it could not be read, which is a different
// thing entirely: this file holds every remote, so treating a damaged or half-written
// one as "nothing configured" would let the next save persist that emptiness over the
// other remotes' setups.
function readPlans() {
  if (!fs.existsSync(PLAN_FILE)) return {};
  try {
    const st = fs.statSync(PLAN_FILE);
    if (st.size > MAX_PLAN_BYTES) {
      // Nothing this module writes can get here (writePlan refuses first), so this is a
      // hand-edited or damaged file.
      console.warn("[firetvir] oversized", PLAN_FILE, st.size, "bytes");
      return null;
    }
    const j = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
    if (!j || typeof j !== "object") return null;
    return j;
  } catch (e) {
    console.warn("[firetvir] could not read", PLAN_FILE, String(e.message || e));
    return null;
  }
}

function readPlan(mac) {
  if (!MAC_RE.test(mac)) return null;
  const all = readPlans();
  if (!all) return null;
  const p = all[mac.toLowerCase()];
  return p ? sanitizePlan(p) : { devices: [], assign: {}, ts: 0 };
}

// The one place the file is written. `mode` on writeFileSync only applies when the file
// is CREATED and is masked by umask, so the permission is set explicitly afterwards -
// this file names the devices in someone's living room.
function savePlans(all) {
  const body = JSON.stringify(all, null, 2);
  // The budget is enforced where the file is WRITTEN, not only where it is read: a file
  // the reader rejects takes every OTHER remote's setup with it, and the next
  // legitimate save would then persist that emptiness.
  if (body.length > MAX_PLAN_BYTES) {
    console.warn("[firetvir] refusing to write a", body.length, "byte plan file");
    return false;
  }
  try {
    fs.mkdirSync(TVBOX, { recursive: true }); // a box that has never written one
    fs.writeFileSync(PLAN_FILE, body, { mode: 0o600 });
    fs.chmodSync(PLAN_FILE, 0o600);
    return true;
  } catch (e) {
    console.warn("[firetvir] could not write", PLAN_FILE, String(e.message || e));
    return false;
  }
}

function writePlan(mac, raw) {
  if (!MAC_RE.test(mac)) return null;
  const plan = { ...sanitizePlan(raw), ts: Date.now() };
  const all = readPlans();
  // Refuse rather than rewrite: a file we could not parse still holds the other
  // remotes, and writing this one's entry alone is how they would be lost.
  if (!all) return null;
  if (plan.devices.length) all[mac.toLowerCase()] = plan;
  else delete all[mac.toLowerCase()];
  return savePlans(all) ? plan : null;
}

// Change ONE remote's entry, leaving every other remote's exactly as it was. What was
// last written to a remote is per remote, and the box-wide codes file cannot say that:
// erasing one remote would clear what the screen says about another.
function updatePlan(mac, fn) {
  if (!MAC_RE.test(mac)) return null;
  const all = readPlans();
  if (!all) return null;
  const key = mac.toLowerCase();
  if (!all[key]) return null; // nothing set up for this remote: nothing to record
  const next = fn({ ...all[key] });
  all[key] = next;
  return savePlans(all) ? next : null;
}

// ---- the plan -> what the python tool programs --------------------------------------
// A plan is the same object the screen shows and the box stores: the devices this remote
// drives, plus which button drives which (and an optional SECOND device per key, so one
// press blasts both - e.g. Power to a TV and a soundbar). Since every device carries its
// own codes, this is a pure transformation: no fetch, no cache, nothing that can fail
// halfway.
function resolvePlan(raw, label, onlyKey) {
  const plan = sanitizePlan(raw);
  const byId = new Map(plan.devices.map((d) => [d.id, d]));
  const spec = { name: label || "custom", source: planSource(plan), duty_cycle: 33, keys: {} };
  for (const key of PROGRAMMABLE_KEYS) {
    if (onlyKey && key !== onlyKey) continue;
    const a = plan.assign[key];
    const dev = a && byId.get(a.device);
    const code = dev && dev.keys[key];
    if (!code) continue; // this key is simply not programmed
    const entry = { ...code.entry, ...(key === "Power" ? { optional: true, post_delay: 1000 } : {}) };
    const second = a.second && byId.get(a.second);
    const secondCode = second && second.keys[key];
    if (secondCode) entry.second = { ...secondCode.entry };
    spec.keys[key] = entry;
  }
  if (!Object.keys(spec.keys).length) return null;
  return spec;
}

// One code out of a remote's saved plan, addressed by device KIND plus key instead of by
// the remote's own button assignment.
//
// That addressing is the point. `assign` answers "what does the Power BUTTON do", which
// is one slot - so a TV's power and a soundbar's power cannot both live there - while an
// InstantFire blast is bound to no button at all and needs no scan id, so any code in
// the plan can be sent. A kind is also the stable half of a plan: a device id is a hash
// of the frames a published index grouped, and a rebuilt index can regroup them.
//
// Where several devices of a kind carry the key, the one the button assignment already
// points at wins - somebody chose it - and otherwise the first, so the answer is at
// least deterministic. That preference only ever applies to the four programmable keys:
// `assign` is a map of BUTTONS, and an input has no button, so a plan holding two
// televisions blasts an input at whichever is listed first. Nothing in the UI can
// express a choice there today; it is deterministic rather than right.
function resolveBlast(raw, kind, key) {
  const plan = sanitizePlan(raw);
  const cands = plan.devices.filter((d) => d.kind === kind && d.keys[key]);
  if (!cands.length) return null;
  const a = plan.assign[key];
  const dev = (a && cands.find((d) => d.id === a.device)) || cands[0];
  // Power carries the two quirks Fire OS's own builder gives it (IROptional + a post
  // delay); build_actions defaults them by key name, but resolvePlan states them and a
  // blast has to send what a programmed key would.
  const entry = { ...dev.keys[key].entry, ...(key === "Power" ? { optional: true, post_delay: 1000 } : {}) };
  return { name: kind + " " + key, source: dev.label || kind, duty_cycle: 33, keys: { [key]: entry } };
}

// Blast one plan target ("<kind>:<Key>", validated in config.js) through a remote. The
// spec goes to a file of its OWN, never the codes file the remote was programmed from:
// a blast stores nothing on the remote, so it must not be able to change what
// `status.configured` reports about it. The name is unique per call because two blasts
// sharing one file would send each other's code.
function blastAction(mac, target, cb) {
  if (!MAC_RE.test(String(mac || ""))) return cb(new Error("invalid MAC"));
  const m = /^([a-z]+):([A-Za-z0-9]+)$/.exec(String(target || ""));
  if (!m) return cb(new Error("invalid IR target: " + target));
  const [, kind, key] = m;
  if (!IR_KEYS.includes(key)) return cb(new Error("invalid IR key: " + key));
  const plan = readPlan(mac);
  if (!plan) return cb(new Error("the remote plan could not be read"));
  const spec = resolveBlast(plan, kind, key);
  // A named target with nothing behind it is the commonest way this fails - the plan
  // holds a TV but no soundbar - so it says which half is missing rather than "failed".
  if (!spec) return cb(new Error("no " + kind + " device in the remote setup carries " + key));
  const file = path.join(TVBOX, "firetv_ir_blast." + process.pid + "." + Date.now() + ".json");
  try {
    fs.writeFileSync(file, JSON.stringify(spec, null, 2), { mode: 0o600 });
  } catch (e) {
    return cb(e);
  }
  const done = (err, r) => {
    try {
      fs.unlinkSync(file);
    } catch (e) {
      /* best effort - the next boot's tmp sweep gets it */
    }
    cb(err, r);
  };
  // Tighter than the UI's 30 s key test on purpose. A blast to an AWAKE remote answers
  // in about a second, and a sleeping one is not going to start answering - so the rest
  // of a long budget is spent stalling the IR queue, which every other action and every
  // Home Assistant button press waits behind. 12 s leaves room for a slow connect and
  // bounds a pile-up at something a person will sit through.
  runTool(["blast", mac, "--config", file, "--key", key], 12000, done);
}

// What the codes file says about where its codes came from, so a later look at
// `status.configured` means something.
function planSource(plan) {
  const used = new Set(Object.values(plan.assign).flatMap((a) => (a ? [a.device, a.second] : [])));
  const names = plan.devices
    .filter((d) => used.has(d.id))
    .map(
      (d) => [d.brand, d.label].filter(Boolean).join(" ") + (d.sources.length ? " [" + d.sources.join("+") + "]" : ""),
    );
  return names.join(", ").slice(0, 300) || "tvbox IR index";
}

// ---- running the BLE tool -----------------------------------------------------------
function runTool(args, timeoutMs, cb) {
  if (!fs.existsSync(PY)) return cb(new Error("BLE support not installed"));
  const child = spawn(PY, [TOOL, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const cap = (d) => {
    out += d.toString();
    if (out.length > 8000) out = out.slice(-8000);
  };
  child.stdout.on("data", cap);
  child.stderr.on("data", cap);
  const to = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch (e) {}
  }, timeoutMs);
  child.on("close", (code) => {
    clearTimeout(to);
    cb(null, { ok: code === 0, code, output: out.trim().split("\n").slice(-8).join("\n") });
  });
  child.on("error", (e) => {
    clearTimeout(to);
    cb(e);
  });
}

const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

// test = write the chosen codes to a config of their own + one-shot blast (nothing is
// stored on the remote); program = persist the keymap onto the remote's keys. The blast
// is built from the SAME plan the program would write, so what you hear/see in the test
// is exactly what lands on the remote - including a key's second device.
// A test writes its OWN config file. `status.configured` is read from CODES_FILE and the
// screen reports it as what was last written to the remote - so a test, which stores
// nothing on the remote at all, must not be able to claim that.
function testKey(mac, plan, key, cb) {
  if (!MAC_RE.test(mac)) return cb(new Error("invalid MAC"));
  if (!PROGRAMMABLE_KEYS.includes(key)) return cb(new Error("invalid key"));
  const spec = resolvePlan(plan, null, key);
  if (!spec) return cb(new Error("nothing is assigned to " + key));
  try {
    fs.writeFileSync(TEST_CODES_FILE, JSON.stringify(spec, null, 2));
  } catch (e) {
    return cb(e);
  }
  runTool(["blast", mac, "--config", TEST_CODES_FILE, "--key", key], 30000, cb);
}

function program(mac, plan, label, cb) {
  if (!MAC_RE.test(mac)) return cb(new Error("invalid MAC"));
  const spec = resolvePlan(plan, label);
  if (!spec) return cb(new Error("no button is assigned to a device"));
  try {
    fs.writeFileSync(CODES_FILE, JSON.stringify(spec, null, 2));
  } catch (e) {
    return cb(e);
  }
  runTool(["program", mac, "--config", CODES_FILE], 60000, (err, r) => {
    // Recorded against the MAC that was actually written, so a second remote's screen
    // never reports this one's codes.
    if (!err && r && r.ok) updatePlan(mac, (p) => ({ ...p, programmed: { label: str(label, 60), ts: Date.now() } }));
    cb(err, r);
  });
}

function erase(mac, cb) {
  if (!MAC_RE.test(mac)) return cb(new Error("invalid MAC"));
  runTool(["erase", mac], 30000, (err, r) => {
    // The devices stay - you erase to stop the remote blasting, not to throw away the
    // setup, and re-programming should not mean building it again. What goes is the
    // record that anything IS on the remote, for this remote only.
    if (!err && r && r.ok) {
      updatePlan(mac, (p) => ({ ...p, programmed: null }));
      try {
        fs.unlinkSync(CODES_FILE);
      } catch (e) {}
    }
    cb(err, r);
  });
}

function status(cb) {
  probeDeps((depsOk) => {
    let configured = null;
    try {
      const c = JSON.parse(fs.readFileSync(CODES_FILE, "utf8"));
      configured = { name: c.name || "", source: c.source || "" };
    } catch (e) {}
    suggestedBrand((brand) => {
      cb({
        toolPresent: fs.existsSync(TOOL),
        venvPresent: fs.existsSync(PY),
        depsOk,
        installing: depsState.running,
        installStep: depsState.step,
        installError: depsState.error,
        configured,
        suggestedBrand: brand, // the connected TV's brand (EDID/CEC), or null
      });
    });
  });
}

module.exports = {
  status,
  programmableRemotes,
  installDeps,
  brands,
  brandDevices,
  readPlan,
  writePlan,
  supportedProtocols,
  testKey,
  program,
  erase,
  blastAction,
  _test: { sanitizePlan, updatePlan, resolvePlan, resolveBlast, planSource, codeSendable, makeToBrand },
};
