// A user unit reaches a box by three routes, and each is its own code with its own
// list: OTA's syncInfra (shell/updater.js USER_UNITS + UNIT_WANTS), the image
// stage's chroot block for a box that is flashed, and deploy/deploy.sh for a box
// installed over SSH. Nothing derives one from another - the image runs in a
// chroot where `systemctl --user` cannot, so it writes the WantedBy symlinks by
// hand, and deploy.sh has a stanza per unit.
//
// A unit added to the updater and forgotten in one of the other two is installed
// on every box except the ones that came that way. Such a box has the unit's
// script on disk (the infra files are copied either way) and nothing starting it:
// no error, no log line, the feature is simply absent. It happened to
// tvbox-voice.service, which shipped in 2.4.0 and never reached the image stage -
// a box flashed six weeks later had a Wyoming satellite it never started, so the
// remote's microphone button did nothing at all.
//
// This is the same cross-check as updater.test.js's deploy/infra.list one, at the
// other end of the same pipe. The updater is taken as the source of truth because
// it is the list the other two have to follow, and it is already held to each
// unit's own [Install] WantedBy by updater.test.js.
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const updater = require("../shell/updater");
const STAGE = path.join(__dirname, "..", "image", "stage-tvbox", "01-tvbox", "00-run.sh");
const DEPLOY = path.join(__dirname, "deploy.sh");

const UNIT_RE = /[A-Za-z0-9@._-]+\.(?:service|timer)/g;

// The block is found by what it DOES rather than by a line number or a comment:
// the mkdir that creates the two WantedBy directories is unique in the file, and
// a rewrite that stops creating them would fail the lookup rather than pass
// silently against a block that no longer exists.
function userUnitBlock(src) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => /mkdir .*\.config\/systemd\/user\/default\.target\.wants/.test(l));
  assert.notEqual(start, -1, "no user-unit block in the image stage - did it move or change shape?");
  // `su - $USER -c '...'` - the block ends on the line that closes the quote.
  const end = lines.findIndex((l, i) => i >= start && /'\s*$/.test(l));
  assert.notEqual(end, -1, "the user-unit block's single-quoted command is never closed");
  return lines.slice(start, end + 1);
}

function copied(block) {
  return new Set(block.filter((l) => /^\s*cp\s/.test(l)).flatMap((l) => l.match(UNIT_RE) || []));
}

// `ln -sf ../<unit> ~/.config/systemd/user/<wants-dir>/<unit>` -> {unit: wants-dir}.
function linked(block) {
  const out = {};
  for (const line of block) {
    const m =
      /^\s*ln\s+-sf\s+\.\.\/([A-Za-z0-9@._-]+)\s+\S*\/\.config\/systemd\/user\/([A-Za-z0-9.-]+)\/([A-Za-z0-9@._-]+)\s*'?\s*$/.exec(
        line,
      );
    if (!m) continue;
    assert.equal(m[3], m[1], "the symlink is named differently from its target: " + line.trim());
    out[m[1]] = m[2];
  }
  return out;
}

test("the image installs exactly the user units OTA does", () => {
  const block = userUnitBlock(fs.readFileSync(STAGE, "utf8"));
  const inImage = copied(block);
  const inUpdater = new Set(updater.USER_UNITS);

  const missing = [...inUpdater].filter((u) => !inImage.has(u));
  assert.deepEqual(
    missing,
    [],
    "in USER_UNITS but not copied by the image stage, so a freshly flashed box would never have it: " + missing,
  );

  const extra = [...inImage].filter((u) => !inUpdater.has(u));
  assert.deepEqual(
    extra,
    [],
    "copied by the image stage but not in USER_UNITS, so OTA would never update it: " + extra,
  );
});

test("the image enables exactly the user units OTA enables, into the same target", () => {
  const block = userUnitBlock(fs.readFileSync(STAGE, "utf8"));
  const inImage = linked(block);

  for (const [unit, wants] of Object.entries(updater.UNIT_WANTS)) {
    assert.equal(
      inImage[unit],
      wants,
      unit +
        " is enabled into " +
        wants +
        " by OTA but " +
        (inImage[unit] ? "into " + inImage[unit] : "not at all") +
        " by the image stage - a flashed box would not start it",
    );
  }

  for (const unit of Object.keys(inImage)) {
    assert.ok(
      updater.UNIT_WANTS[unit],
      unit + " is enabled by the image stage but absent from UNIT_WANTS - OTA would leave it disabled",
    );
  }
});

// A unit the image copies but never links is how tvbox-flatpak-update.service is
// meant to work (its timer pulls it in), so the two lists above are deliberately
// different sizes. Assert the reason rather than the count: anything the image
// copies without linking must be something OTA does not link either.
test("a unit the image copies but does not enable is one OTA does not enable", () => {
  const block = userUnitBlock(fs.readFileSync(STAGE, "utf8"));
  const inImage = linked(block);
  for (const unit of copied(block)) {
    if (inImage[unit]) continue;
    assert.ok(
      !updater.UNIT_WANTS[unit],
      unit + " is copied but not enabled by the image stage, while OTA enables it into " + updater.UNIT_WANTS[unit],
    );
  }
});

// deploy/deploy.sh is the third route. It is in sync today, and nothing held it
// there: it is a hand-written stanza per unit rather than a loop over a list, so
// the same omission is one forgotten paragraph away. It enables rather than
// symlinks (`systemctl --user enable` can run here - there is no chroot), so the
// target directory is systemd's business and only the unit set is compared.
//
// Quoted strings are cut out first, and that is not tidiness: deploy.sh PRINTS a
// recovery hint containing `systemctl --user enable --now tvbox-flatpak-update.timer`,
// so reading the line whole would count that unit as enabled by the message that
// says it is not.
function deployInstalls(src) {
  const copied = new Set();
  const enabled = new Set();
  for (const raw of src.split("\n")) {
    if (/^\s*#/.test(raw)) continue;
    const line = raw.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
    for (const m of line.matchAll(/~\/\.tvbox\/([A-Za-z0-9@._-]+\.(?:service|timer))/g)) copied.add(m[1]);
    const e = /systemctl\s+--user\s+enable\s+(?:--now\s+)?([A-Za-z0-9@._-]+\.(?:service|timer))/.exec(line);
    if (e) enabled.add(e[1]);
  }
  return { copied, enabled };
}

test("deploy.sh installs and enables the same user units OTA does", () => {
  const { copied, enabled } = deployInstalls(fs.readFileSync(DEPLOY, "utf8"));
  const inUpdater = new Set(updater.USER_UNITS);

  const notCopied = updater.USER_UNITS.filter((u) => !copied.has(u));
  assert.deepEqual(
    notCopied,
    [],
    "in USER_UNITS but never copied by deploy.sh, so an SSH install would lack it: " + notCopied,
  );

  const extra = [...copied].filter((u) => !inUpdater.has(u));
  assert.deepEqual(extra, [], "copied by deploy.sh but not in USER_UNITS, so OTA would never update it: " + extra);

  const notEnabled = Object.keys(updater.UNIT_WANTS).filter((u) => !enabled.has(u));
  assert.deepEqual(
    notEnabled,
    [],
    "OTA enables these and deploy.sh does not, so an SSH-installed box would have them on disk and stopped: " +
      notEnabled,
  );
});
