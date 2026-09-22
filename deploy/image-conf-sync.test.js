// The SD image and an SSH install write the same root config from two different
// places: image/stage-tvbox/01-tvbox/conf/ holds committed files the stage copies
// in, and deploy/provision.sh writes its own copy from a heredoc. docs/sd-image.md
// states the invariant ("KEEP IN SYNC with the heredocs in deploy/provision.sh")
// and the files repeat it in their own first lines, which is the shape of a rule
// nothing enforces.
//
// It went wrong once and stayed wrong. conf/99-tvbox.rules was written for 1.0.0
// and then left alone, so it never gained the hidraw rule provision.sh grew a week
// later for the Fire TV remote's app buttons and, later still, for the voice
// satellite's microphone. A box flashed from the image had a remote whose extra
// buttons did nothing and a satellite that could not open the microphone, while a
// box installed over SSH was fine - and no test anywhere said so.
//
// Comments are not compared, because a committed file carries a KEEP IN SYNC line
// the heredoc has no reason to. Everything that does something is.
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const CONF = path.join(__dirname, "..", "image", "stage-tvbox", "01-tvbox", "conf");
const PROVISION = path.join(__dirname, "provision.sh");

// The file in conf/, and the path provision.sh writes its copy to. Everything in
// conf/ that provision.sh also writes is here except 50-tvbox-networkmanager.rules,
// and that one is excluded for FORMATTING rather than for content: the committed
// copy is prettier-formatted and the heredoc is hand-wrapped, so the same rule is
// spelled over a different number of lines. Holding it needs a reader that
// normalises JavaScript, which is a different piece of work; the other four polkit
// files happen to be wrapped the same way on both sides and need nothing.
const PAIRS = [
  ["99-tvbox.rules", "/etc/udev/rules.d/99-tvbox.rules"],
  ["10-tvbox-logind.conf", "/etc/systemd/logind.conf.d/10-tvbox.conf"],
  ["20auto-upgrades", "/etc/apt/apt.conf.d/20auto-upgrades"],
  ["52tvbox-unattended-upgrades", "/etc/apt/apt.conf.d/52tvbox-unattended-upgrades"],
  ["50-tvbox-udisks.rules", "/etc/polkit-1/rules.d/50-tvbox-udisks.rules"],
  ["51-tvbox-locale.rules", "/etc/polkit-1/rules.d/51-tvbox-locale.rules"],
  ["53-tvbox-radio.rules", "/etc/polkit-1/rules.d/53-tvbox-radio.rules"],
  ["54-tvbox-power.rules", "/etc/polkit-1/rules.d/54-tvbox-power.rules"],
];

// `#` for udev and apt, `//` for polkit's JavaScript. Line-initial only: neither
// format has trailing comments, and a `#` inside a value would be content.
function directives(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));
}

// `cat > <dest> <<'EOF' ... EOF`. The quoted terminator matters twice: an unquoted
// one would be expanded by the shell, so the two copies could not be compared as
// text - and `RULES` terminates six separate heredocs in this file, so the search
// is by destination and every match is collected rather than the first returned.
function heredocFor(src, dest) {
  const lines = src.split("\n");
  const open = new RegExp("^cat > " + dest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " <<'([A-Za-z_]+)'$");
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = open.exec(lines[i].trim());
    if (!m) continue;
    const end = lines.findIndex((l, j) => j > i && l.trim() === m[1]);
    assert.notEqual(end, -1, "the heredoc writing " + dest + " is never terminated");
    found.push(lines.slice(i + 1, end).join("\n"));
  }
  // Two would mean the later one silently wins on disk while this compared the
  // first, which is how a fixed copy and a stale copy could both pass.
  assert.ok(found.length <= 1, "provision.sh writes " + dest + " from " + found.length + " heredocs");
  return found[0] ?? null;
}

for (const [file, dest] of PAIRS) {
  test("the image's " + file + " says the same as provision.sh", () => {
    const committed = directives(fs.readFileSync(path.join(CONF, file), "utf8"));
    const heredoc = heredocFor(fs.readFileSync(PROVISION, "utf8"), dest);
    assert.ok(heredoc !== null, "provision.sh no longer writes " + dest + " from a quoted heredoc - has it moved?");
    // Neither side may be comments alone, or two files that have both been emptied
    // would agree with each other and with nothing on a box.
    assert.ok(committed.length > 0, "conf/" + file + " has no directives left");
    assert.deepEqual(
      committed,
      directives(heredoc),
      "conf/" +
        file +
        " and provision.sh's " +
        dest +
        " disagree. A flashed box and an SSH-installed box would then differ, " +
        "with nothing failing on either.",
    );
  });
}
