// Crash-safe file writes. A plain writeFileSync truncates the file first and
// fills it afterwards, so a power cut between the two leaves an empty or half
// written file behind - and a JSON store whose load() answers {} for an
// unreadable file then persists that {} on the next save. Every store the shell
// cannot rebuild by itself goes through here instead.
//
// The sequence is the standard one: write a temp file in the same directory,
// fsync it, rename it over the target (atomic on one filesystem), then fsync the
// directory so the rename itself is durable.
const fs = require("fs");
const path = require("path");

function fsyncDir(dir) {
  let fd = null;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch (e) {
    /* some filesystems (FAT, a few FUSE mounts) refuse a directory fsync */
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

// mode: the permission bits the file should end up with. When omitted, an
// existing file keeps its own mode and a new one gets 0644 (masked by umask),
// which is what writeFileSync would have done.
function writeFileAtomic(file, data, opts = {}) {
  const dir = path.dirname(file);
  if (opts.mkdir !== false) fs.mkdirSync(dir, { recursive: true });
  let mode = opts.mode;
  if (mode == null) {
    try {
      mode = fs.statSync(file).mode & 0o7777;
    } catch (e) {
      mode = 0o644;
    }
  }
  const tmp = path.join(dir, "." + path.basename(file) + "." + process.pid + "." + Date.now() + ".tmp");
  let fd = null;
  try {
    // "wx": never follow or reuse something already at the temp path.
    fd = fs.openSync(tmp, "wx", mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    // The open mode is masked by umask; the target's mode is not a suggestion.
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch (e2) {
        /* already closed */
      }
    }
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fsyncDir(dir);
}

function writeJsonAtomic(file, value, opts = {}) {
  const body =
    opts.pretty === false ? JSON.stringify(value) : JSON.stringify(value, null, 2) + (opts.newline ? "\n" : "");
  writeFileAtomic(file, body, opts);
}

// Copy src over dst the same way, so a reader never sees a half-copied file
// and an interrupted copy leaves the previous dst in place.
function copyFileAtomic(src, dst, opts = {}) {
  writeFileAtomic(dst, fs.readFileSync(src), opts);
}

// A JSON file that exists but does not parse is moved aside rather than being
// read as empty: the caller would otherwise save its defaults over the only copy
// of whatever was in it. Returns { value } for a good read, { missing: true }
// for no file, { corrupt: true, movedTo } for a file that was set aside.
function readJsonGuarded(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { missing: true };
    return { error: e };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (e) {
    const movedTo = file + ".corrupt-" + Date.now();
    try {
      fs.renameSync(file, movedTo);
    } catch (e2) {
      return { corrupt: true, movedTo: null };
    }
    return { corrupt: true, movedTo };
  }
}

module.exports = { writeFileAtomic, writeJsonAtomic, copyFileAtomic, readJsonGuarded, fsyncDir };
