#!/usr/bin/env node
// PROVISION_REVISION must move when the root payload does.
//
// `requires: ["system:7"]` in a release means "this box needs what provision.sh
// revision 7 installs", and tvbox-sysupdate records the revision once provision
// has run. If the payload gains something and the number stays put, every box
// already at 7 answers "met" for a revision that no longer means what it did -
// and the release installs against a root half it never got. That is the exact
// failure `requires` exists to prevent, so it gets a check rather than a habit.
//
//   node scripts/provision_revision_check.js          verify (CI, make-release)
//   node scripts/provision_revision_check.js --write  record the current state
//
// Deliberately NOT a hash that drives the revision by itself: a comment edit is
// not a reason to re-provision a fleet. So the hash ignores comments and blank
// lines, and it only ever ASKS for a bump - the number is a human's judgement of
// whether a box actually needs the step.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TVBOX = path.join(__dirname, "..");
const DEPLOY = path.join(TVBOX, "deploy");
const LOCK = path.join(DEPLOY, "provision.revision.lock");

// The root payload: provision.sh plus every file it installs or execs. Most are
// found automatically below; these are the ones it reaches through a variable
// (`$HERE/$U` for the units, `$HERE/${PAIR%%:*}` for the diag pair, $LIBCEC_SH),
// where no literal appears in the source to find.
const INDIRECT = [
  "deploy/tvbox-diag.sh",
  "deploy/tvbox-safemode.sh",
  "deploy/tvbox-diag.service",
  "deploy/tvbox-diag.timer",
  "deploy/tvbox-safemode.service",
  "deploy/tvbox-safemode-screen.service",
  "scripts/install-libcec8.sh",
];

// Files provision.sh names but that a SYSTEM UPDATE never runs, so a change to
// them cannot be what a `system:<n>` requirement is asking for. An unattended run
// skips the compositor entirely - a bumped tvbox-wc would land before the shell
// that drives it has proved itself, and greetd execs it directly, so there is no
// way back - which cuts both ways: editing the installer would otherwise ask for
// a fleet-wide bump that changes nothing, and a box would record a revision whose
// only content it had skipped. Basenames, because that is what the $HERE scan
// below yields. (deploy/compositor.version is not in the payload at all - nothing
// reads it through `$HERE/`.)
const NOT_PAYLOAD = new Set(["install-compositor.sh"]);

function payloadFiles() {
  const src = fs.readFileSync(path.join(DEPLOY, "provision.sh"), "utf8");
  const literal = new Set();
  for (const m of src.matchAll(/\$HERE\/([A-Za-z0-9._@-]+)/g)) {
    if (!NOT_PAYLOAD.has(m[1])) literal.add("deploy/" + m[1]);
  }
  const files = new Set(["deploy/provision.sh", ...literal, ...INDIRECT]);
  return [...files].sort();
}

// Content that would change what a box ends up with. Comments and blank lines
// are dropped, so rewording a comment never asks anyone to bump a revision - but
// a `#!` line is a real property of a file provision writes out, so it stays.
function meaningful(text) {
  return text
    .split("\n")
    .filter((l) => {
      const s = l.trim();
      if (!s) return false;
      if (s.startsWith("#!")) return true;
      return !(s.startsWith("#") || s.startsWith("//"));
    })
    .join("\n");
}

function digest(files) {
  const h = crypto.createHash("sha256");
  for (const rel of files) {
    const p = path.join(TVBOX, rel);
    if (!fs.existsSync(p)) throw new Error("root payload file is missing: " + rel);
    h.update(rel + "\0");
    h.update(meaningful(fs.readFileSync(p, "utf8")));
    h.update("\0");
  }
  return h.digest("hex");
}

function revision() {
  const m = /^PROVISION_REVISION=(\d{1,6})$/m.exec(fs.readFileSync(path.join(DEPLOY, "provision.sh"), "utf8"));
  if (!m) throw new Error("no PROVISION_REVISION in deploy/provision.sh");
  return Number(m[1]);
}

function main() {
  const files = payloadFiles();
  const rev = revision();
  const hash = digest(files);
  const state = { revision: rev, files, sha256: hash };

  if (process.argv.includes("--write")) {
    fs.writeFileSync(LOCK, JSON.stringify(state, null, 2) + "\n");
    console.log("recorded revision " + rev + " over " + files.length + " files");
    return 0;
  }

  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  } catch (e) {
    console.error("cannot read " + path.relative(TVBOX, LOCK) + " - run with --write to create it");
    return 1;
  }
  if (lock.sha256 === hash && lock.revision === rev) return 0;

  // A file provision reaches that nobody recorded: the payload grew and this
  // check would not have been watching it.
  const added = files.filter((f) => !(lock.files || []).includes(f));
  const gone = (lock.files || []).filter((f) => !files.includes(f));

  console.error("");
  if (lock.revision !== rev) {
    console.error(
      "PROVISION_REVISION moved " +
        lock.revision +
        " -> " +
        rev +
        " but the lock file still records " +
        lock.revision +
        ".",
    );
  } else {
    console.error("The root payload changed but PROVISION_REVISION is still " + rev + ".");
  }
  if (added.length) console.error("  new in the payload: " + added.join(", "));
  if (gone.length) console.error("  no longer in it:    " + gone.join(", "));
  console.error("");
  console.error("Two things to decide, in this order:");
  console.error("  1. Does a box NEED this before it can run the next release? If so,");
  console.error("     bump PROVISION_REVISION in deploy/provision.sh and add");
  console.error('     "system:<n>" to tvboxRequires in shell/package.json - that pair is');
  console.error("     what makes a box run its root half before taking the release.");
  console.error("  2. If it is a fix nobody has to have yet, leave the number alone.");
  console.error("");
  console.error("Either way, record the new state:");
  console.error("     node scripts/provision_revision_check.js --write");
  return 1;
}

process.exit(main());
