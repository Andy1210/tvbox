// The machine's own settings, against real command output.
//
// Every string below was captured from a running box. That is the point: the
// bugs in this file are parsing bugs, and nmcli's terse format has two traps that
// only real output shows - it escapes ':' inside a value, and a hidden network
// answers with an EMPTY SSID field rather than being absent.
const test = require("node:test");
const assert = require("node:assert");

const system = require("./system");

// A fake execFile that answers by command line. Anything not listed errors,
// which is how a test says "this must not be run".
// An answer is the command's stdout, or `{ stdout, stderr, fail }` when a test
// cares about a failure: the shell decides what to report from a failing command's
// stderr, so a fake that can only succeed cannot pin that.
function withCommands(answers) {
  const seen = [];
  system.init({
    execFile: (cmd, args, opts, cb) => {
      const done = typeof opts === "function" ? opts : cb;
      const line = [cmd].concat(args).join(" ");
      seen.push(line);
      const key = Object.keys(answers).find((k) => line.includes(k));
      const answer = key === undefined ? null : answers[key];
      setImmediate(() => {
        if (answer === null) return done(new Error("Command failed: " + line), "", "");
        if (typeof answer === "string") return done(null, answer, "");
        if (answer.fail) return done(new Error("Command failed: " + line), answer.stdout || "", answer.stderr || "");
        done(null, answer.stdout || "", answer.stderr || "");
      });
    },
  });
  return seen;
}

test("wifi status reads the state and the network it is on", async () => {
  withCommands({
    "device show wlan0": "GENERAL.STATE:100 (connected)\nGENERAL.CONNECTION:DarkTL24\n",
  });
  const status = await new Promise((resolve) => system.wifiStatus(resolve));
  assert.deepStrictEqual(status, { connected: true, ssid: "DarkTL24" });
});

test("a disconnected radio is not on a network", async () => {
  withCommands({
    "device show wlan0": "GENERAL.STATE:30 (disconnected)\nGENERAL.CONNECTION:--\n",
  });
  const status = await new Promise((resolve) => system.wifiStatus(resolve));
  assert.deepStrictEqual(status, { connected: false, ssid: "" });
});

test("ethernet is found by type and state, whatever it is called", async () => {
  // The device name is board-dependent (eth0 here, end0 elsewhere), so nothing
  // may key off it.
  withCommands({
    "-f DEVICE,TYPE,STATE": "wlan0:wifi:connected\nlo:loopback:connected (externally)\neth0:ethernet:connected\n",
    "device show eth0": "IP4.ADDRESS[1]:192.168.1.24/24\n",
  });
  const eth = await new Promise((resolve) => system.ethernetStatus(resolve));
  assert.deepStrictEqual(eth, { connected: true, ip: "192.168.1.24", device: "eth0" });
});

test("an unplugged ethernet port is not a connection", async () => {
  withCommands({
    "-f DEVICE,TYPE,STATE": "wlan0:wifi:connected\np2p-dev-wlan0:wifi-p2p:disconnected\neth0:ethernet:unavailable\n",
  });
  const eth = await new Promise((resolve) => system.ethernetStatus(resolve));
  assert.deepStrictEqual(eth, { connected: false, ip: "" });
});

test("the network list drops the hidden ones and puts the active first", async () => {
  // Real output: three of these have no SSID (hidden networks), and the one the
  // box is on is not at the top of what nmcli returns.
  withCommands({
    "device wifi list":
      "no:77:WPA2 WPA3:DarkTL50\n" +
      "no:77:WPA2:\n" +
      "no:70:WPA2:FAHAZ\n" +
      "no:77:WPA2:\n" +
      "yes:69:WPA2:DarkTL24\n",
    // The real command asks for NAME,TYPE - a key that does not match it leaves the
    // saved list empty, and the "known by name" branch below never runs.
    "-f NAME,TYPE connection show":
      "DarkTL24:802-11-wireless\n" +
      "FAHAZ:802-11-wireless\n" +
      "lo:loopback\n" +
      "tvbox-preseed:802-11-wireless\n" +
      "Wired connection 1:802-3-ethernet\n",
  });
  const nets = await new Promise((resolve) => system.wifiList(resolve));

  assert.deepStrictEqual(
    nets.map((n) => n.ssid),
    ["DarkTL24", "DarkTL50", "FAHAZ"],
  );
  assert.strictEqual(nets[0].active, true);
  assert.strictEqual(nets[0].signal, 69);
  assert.strictEqual(nets[0].secured, true);
  // "known" is what the UI offers "forget" on, and it has three answers to give:
  // the active network always has a profile, a saved one is matched by NAME
  // (FAHAZ, in range and not joined), and DarkTL50 has never been joined at all.
  assert.deepStrictEqual(
    nets.map((n) => n.known),
    [true, false, true],
  );
});

test("a colon in an SSID survives the terse format", async () => {
  // nmcli -t writes it as '\:', and SSID is the last field precisely so it may
  // contain one. Getting this wrong truncates the name the user has to pick.
  withCommands({
    "device wifi list": "no:60:WPA2:home\\:guest\n",
    "-f NAME,TYPE connection show": "",
  });
  const nets = await new Promise((resolve) => system.wifiList(resolve));
  assert.deepStrictEqual(
    nets.map((n) => n.ssid),
    ["home:guest"],
  );
});

// The box ships with a profile called `tvbox-preseed` carrying the house network's
// ssid, so a profile's name is not its network's - and nmcli matches by ssid.
const SAVED = {
  "-f NAME,TYPE connection show": "tvbox-preseed:802-11-wireless\n",
  "802-11-wireless.ssid connection show id tvbox-preseed": "DarkTL50",
};

test("the password just typed goes into the profile nmcli would use", () => {
  // nmcli reuses a matching profile, secret and all, so a new password typed at the
  // TV would never be tried. The profile is what knows how the network is secured,
  // so the password goes into it rather than around it.
  const seen = withCommands({
    ...SAVED,
    "802-11-wireless-security.psk connection show id tvbox-preseed": "oldsecret",
    "connection modify": "",
    "connection up": "",
  });
  return new Promise((resolve) => {
    system.wifiConnect("DarkTL50", "hunter2", false, (r) => {
      assert.deepStrictEqual(r, { ok: true });
      assert.ok(
        seen.some((c) => c === "nmcli connection modify id tvbox-preseed wifi-sec.psk hunter2"),
        seen.join(" | "),
      );
      // Before the subcommand, where nmcli parses it: at the end it answers
      // "invalid extra argument" and nothing connects at all.
      assert.match(
        seen.find((c) => c.includes("connection up")),
        /^nmcli --wait \d+ connection up id tvbox-preseed$/,
      );
      assert.strictEqual(
        seen.some((c) => c.includes("connection delete")),
        false,
        "nothing is deleted",
      );
      resolve();
    });
  });
});

test("a password that does not bring the network up is put back", () => {
  // The single most likely input on that screen is a typo, and this box may have no
  // way onto the network except the profile being edited. So the old secret is read
  // first and restored, and the profile is left where it was: a wifi-only box that
  // loses its profile cannot be fixed from anywhere.
  const seen = withCommands({
    ...SAVED,
    "802-11-wireless-security.psk connection show id tvbox-preseed": "oldsecret",
    "connection modify": "",
    "connection up": { fail: true, stderr: "Error: Connection activation failed: (7) Secrets were required." },
  });
  return new Promise((resolve) => {
    system.wifiConnect("DarkTL50", "typo", false, (r) => {
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /Secrets were required/);
      // Classified, so the TV can say it in the user's own language rather than
      // quoting NetworkManager at them.
      assert.strictEqual(r.code, "bad-password");
      const writes = seen.filter((c) => c.includes("wifi-sec.psk")).map((c) => c.split(" ").pop());
      assert.deepStrictEqual(writes, ["typo", "oldsecret"], "the last write puts the old secret back");
      assert.strictEqual(
        seen.some((c) => c.includes("connection delete")),
        false,
        "the profile survives a wrong password",
      );
      resolve();
    });
  });
});

test("the failure a user is shown is NetworkManager's, not sudo's", () => {
  // Every call is retried with sudo, and a box only has passwordless sudo if
  // someone asked for it in tvbox.conf. Reporting the sudo attempt's stderr makes
  // every failure on an ordinary box read "sudo: a password is required".
  const seen = withCommands({
    ...SAVED,
    "802-11-wireless-security.psk connection show id tvbox-preseed": "oldsecret",
    "connection modify": { fail: true, stderr: "Error: property is invalid." },
    "sudo -n nmcli connection modify": { fail: true, stderr: "sudo: a password is required" },
  });
  return new Promise((resolve) => {
    system.wifiConnect("DarkTL50", "short", false, (r) => {
      assert.strictEqual(r.error, "Error: property is invalid.");
      assert.ok(
        seen.some((c) => c.startsWith("sudo -n nmcli connection modify")),
        "sudo was still tried",
      );
      resolve();
    });
  });
});

test("the password is never part of what is reported or logged", () => {
  // node builds a failed exec's message as "Command failed: <the whole argv>", and
  // one of these command lines carries the password. That string reaches the TV and
  // ~/.tvbox/shell.log, which the diagnostics report copies to the boot partition.
  const seen = withCommands({ ...SAVED, "802-11-wireless-security.psk connection show id tvbox-preseed": "old" });
  return new Promise((resolve) => {
    system.wifiConnect("DarkTL50", "hunter2secret", false, (r) => {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error.includes("hunter2secret"), false, r.error);
      assert.ok(
        seen.some((c) => c.includes("hunter2secret")),
        "it did reach nmcli, just not the report",
      );
      resolve();
    });
  });
});

test("a network name that nmcli would read as an option is refused", () => {
  // An SSID is chosen by whoever runs the access point. nmcli parses options in the
  // position the SSID goes to, so "-a" becomes --ask: every later argument shifts
  // along and the password is quoted back in the error. There is no `--` to hide
  // behind, so this network cannot be joined by this path at all.
  const seen = withCommands({ "device wifi connect": "" });
  return new Promise((resolve) => {
    system.wifiConnect("-a", "hunter2", false, (r) => {
      assert.deepStrictEqual(r, { ok: false, error: "unsupported network name", code: "bad-ssid" });
      assert.deepStrictEqual(seen, [], "nothing was run");
      resolve();
    });
  });
});

test("an SSID with a colon in it still finds its profile", () => {
  // nmcli's terse output escapes a colon inside a value, and an SSID may contain
  // one. Unescaped, the lookup misses and the typed password goes nowhere near the
  // profile - the original bug, for exactly the SSIDs this file already protects.
  const seen = withCommands({
    "-f NAME,TYPE connection show": "guest:802-11-wireless\n",
    "802-11-wireless.ssid connection show id guest": "home\\:guest",
    "802-11-wireless-security.psk connection show id guest": "old",
    "connection modify": "",
    "connection up": "",
  });
  return new Promise((resolve) => {
    system.wifiConnect("home:guest", "hunter2", false, (r) => {
      assert.deepStrictEqual(r, { ok: true });
      assert.ok(
        seen.some((c) => c === "nmcli connection modify id guest wifi-sec.psk hunter2"),
        seen.join(" | "),
      );
      resolve();
    });
  });
});

test("a network with no profile of its own is joined from scratch", () => {
  // A saved profile exists, for a DIFFERENT network: the lookup has to miss it and
  // the ordinary connect has to run, password and all.
  const seen = withCommands({
    ...SAVED,
    "device wifi connect": "",
  });
  return new Promise((resolve) => {
    system.wifiConnect("CoffeeShop", "beans", false, (r) => {
      assert.deepStrictEqual(r, { ok: true });
      assert.match(
        seen.find((c) => c.includes("device wifi connect")),
        /^nmcli --wait \d+ device wifi connect CoffeeShop password beans$/,
      );
      assert.strictEqual(
        seen.some((c) => c.includes("connection modify")),
        false,
      );
      resolve();
    });
  });
});

test("About reports an SSID with a space in it, not one with colons", async () => {
  // nmcli escapes ':' inside a value, so the field has to be tokenized - and the
  // sentinel cannot be a space, or every SSID that contains one comes back with
  // colons where its spaces were.
  withCommands({ "-f ACTIVE,SIGNAL,SSID": "no:44:Neighbour\nyes:66:My Home\\:5G\n" });
  const info = await new Promise((resolve) => system.systemInfo(resolve));
  assert.strictEqual(info.wifi.ssid, "My Home:5G");
  assert.strictEqual(info.wifi.signal, 66);
});

test("an open network is reported as open", async () => {
  withCommands({
    "device wifi list": "no:52:--:CoffeeShop\n",
    "-f NAME,TYPE connection show": "",
  });
  const nets = await new Promise((resolve) => system.wifiList(resolve));
  assert.strictEqual(nets[0].secured, false);
});

test("a hostname is validated before it reaches hostnamectl", async () => {
  const seen = withCommands({ "set-hostname": "" });
  const bad = await new Promise((resolve) => system.setHostname("not a hostname", resolve));
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(seen.length, 0, "nothing may be run for a name that cannot be one");
});

test("a rename tells the caller, because the MQTT id follows the hostname", async () => {
  let told = 0;
  withCommands({ "set-hostname": "" });
  system.init({ onHostnameChanged: () => told++ });

  const ok = await new Promise((resolve) => system.setHostname("tvbox-gaming", resolve));
  assert.deepStrictEqual(ok, { ok: true });
  assert.strictEqual(told, 1);
});

test("About reports the connected network's signal, and nothing when on ethernet", async () => {
  withCommands({ "-f ACTIVE,SIGNAL,SSID": "yes:84:DarkTL24\nno:77:DarkTL50\nno:77:\n" });
  const info = await new Promise((resolve) => system.systemInfo(resolve));
  assert.deepStrictEqual(info.wifi, { ssid: "DarkTL24", signal: 84 });

  withCommands({ "-f ACTIVE,SIGNAL,SSID": "no:77:DarkTL50\n" });
  const wired = await new Promise((resolve) => system.systemInfo(resolve));
  assert.deepStrictEqual(wired.wifi, { ssid: "", signal: null });
});
