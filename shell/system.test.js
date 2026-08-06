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
function withCommands(answers) {
  const seen = [];
  system.init({
    execFile: (cmd, args, opts, cb) => {
      const done = typeof opts === "function" ? opts : cb;
      const line = [cmd].concat(args).join(" ");
      seen.push(line);
      const key = Object.keys(answers).find((k) => line.includes(k));
      setImmediate(() => (key ? done(null, answers[key], "") : done(new Error("no answer for " + line), "", "")));
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

test("a password the user typed replaces the one a saved profile carries", async () => {
  // nmcli reuses a matching profile, secret and all, so the new password would
  // never be tried: the network whose password changed is exactly the case where
  // someone is standing at the TV typing one. The profile is kept, because it is
  // what knows how this network is secured.
  const seen = withCommands({
    "-f NAME,TYPE connection show": "tvbox-preseed:802-11-wireless\n",
    // The profile's NAME is not the network's: this is the shape the box ships with.
    "802-11-wireless.ssid connection show tvbox-preseed": "DarkTL50",
    "connection modify": "",
    "connection up": "",
  });
  const r = await new Promise((resolve) => system.wifiConnect("DarkTL50", "hunter2", false, resolve));
  assert.deepStrictEqual(r, { ok: true });
  assert.ok(
    seen.some((c) => c.includes("connection modify id tvbox-preseed wifi-sec.psk hunter2")),
    seen.join(" | "),
  );
  // Before the subcommand, where nmcli parses it: at the end it answers "invalid
  // extra argument" and nothing connects at all.
  assert.match(
    seen.find((c) => c.includes("connection up")),
    /^nmcli --wait \d+ connection up id tvbox-preseed$/,
  );
  assert.strictEqual(
    seen.some((c) => c.includes("connection delete")),
    false,
    "the profile is kept",
  );
});

test("a saved profile that will not take the password is joined from scratch", async () => {
  // An enterprise or WPA3 profile whose name happens to match, or a name that is
  // not a profile at all: the modify fails and the ordinary connect still runs.
  const seen = withCommands({
    "-f NAME,TYPE connection show": "tvbox-preseed:802-11-wireless\n",
    "802-11-wireless.ssid connection show tvbox-preseed": "DarkTL50",
    "device wifi connect": "",
  });
  const r = await new Promise((resolve) => system.wifiConnect("DarkTL50", "hunter2", false, resolve));
  assert.deepStrictEqual(r, { ok: true });
  assert.match(
    seen.find((c) => c.includes("device wifi connect")),
    /^nmcli --wait \d+ device wifi connect DarkTL50 password hunter2$/,
  );
});

test("a profile whose security no longer matches is rebuilt, not retried", async () => {
  // The AP moved to WPA3 under a WPA2 profile: the secret goes in fine and the
  // activation is what fails. Reusing the profile again would fail the same way,
  // so it is dropped and nmcli builds one from a fresh scan of what the AP says.
  const seen = withCommands({
    "-f NAME,TYPE connection show": "tvbox-preseed:802-11-wireless\n",
    "802-11-wireless.ssid connection show tvbox-preseed": "DarkTL50",
    "connection modify": "",
    "connection delete": "",
    "--rescan yes": "",
    "device wifi connect": "",
    // no answer for "connection up" - the fake reports failure for it
  });
  const r = await new Promise((resolve) => system.wifiConnect("DarkTL50", "hunter2", false, resolve));
  assert.deepStrictEqual(r, { ok: true });
  // Every failing call is tried again with sudo before it counts as failed, which
  // is why the activation appears twice.
  const order = seen
    .filter((c) => !c.includes("NAME,TYPE") && !c.includes("802-11-wireless.ssid"))
    .map((c) =>
      c
        .replace(/^sudo -n /, "")
        .replace(/^nmcli (--wait \d+ )?/, "")
        .split(" ")
        .slice(0, 2)
        .join(" "),
    );
  assert.deepStrictEqual(order, [
    "connection modify",
    "connection up",
    "connection up",
    "connection delete",
    "device wifi",
    "device wifi",
  ]);
});

test("a network with no saved profile is joined without deleting anything", async () => {
  const seen = withCommands({
    "-f NAME,TYPE connection show": "DarkTL24:802-11-wireless\n",
    "802-11-wireless.ssid connection show DarkTL24": "DarkTL24",
    "device wifi connect": "",
  });
  const r = await new Promise((resolve) => system.wifiConnect("CoffeeShop", "", false, resolve));
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(
    seen.some((c) => c.includes("connection delete")),
    false,
  );
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
