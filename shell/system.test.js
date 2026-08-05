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
    "device wifi list": "no:77:WPA2 WPA3:DarkTL50\n" + "no:77:WPA2:\n" + "no:77:WPA2:\n" + "yes:69:WPA2:DarkTL24\n",
    "-f NAME connection show": "DarkTL24\nlo\nFAHAZ\ntvbox-preseed\nWired connection 1\n",
  });
  const nets = await new Promise((resolve) => system.wifiList(resolve));

  assert.deepStrictEqual(
    nets.map((n) => n.ssid),
    ["DarkTL24", "DarkTL50"],
  );
  assert.strictEqual(nets[0].active, true);
  assert.strictEqual(nets[0].signal, 69);
  assert.strictEqual(nets[0].secured, true);
  // "known" is what the UI offers "forget" on: the active network always has a
  // profile, and a saved one is matched by name.
  assert.strictEqual(nets[0].known, true);
  assert.strictEqual(nets[1].known, false);
});

test("a colon in an SSID survives the terse format", async () => {
  // nmcli -t writes it as '\:', and SSID is the last field precisely so it may
  // contain one. Getting this wrong truncates the name the user has to pick.
  withCommands({
    "device wifi list": "no:60:WPA2:home\\:guest\n",
    "-f NAME connection show": "",
  });
  const nets = await new Promise((resolve) => system.wifiList(resolve));
  assert.deepStrictEqual(
    nets.map((n) => n.ssid),
    ["home:guest"],
  );
});

test("an open network is reported as open", async () => {
  withCommands({
    "device wifi list": "no:52:--:CoffeeShop\n",
    "-f NAME connection show": "",
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
