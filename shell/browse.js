// What there is to play on the box itself: the user's own folders and whatever is
// plugged into a USB port, plus the one safe way to walk them.
//
// The box already serves its folders OUT over WebDAV (fileserver.js) and until now
// nothing could play what you copied IN. This is that half, and it is deliberately
// thin: the shell says which roots exist and lists a directory inside one of them;
// what counts as a film, how it is presented and what happens on Enter is the app's
// business (the `files` package in the registry).
//
// The roots are DISCOVERED, never listed (contentdirs.js + removable.js), which is
// also the answer to a network share: a box that mounts a NAS anywhere under a user
// folder - an fstab line, or a home folder that IS the mount - is browsable through
// the same route, because every check below is done on the REAL path.
//
// That real path is the security boundary. A local app shares the shell's origin,
// so this route is reachable by any of them, and a stick is removable media that
// can carry anything: `saves/../..`, a symlink to `/`, a folder named like a root.
// Both sides are resolved with realpath and compared as `root + separator`, so a
// path can only ever be INSIDE a root the box offered.
//
// All of the filesystem work is async on purpose. It runs in the Electron main
// process, which also serves HTTP, drives the compositor socket and carries the
// remote's keys - and the medium is a stick that can be pulled out mid-listing,
// where a synchronous stat sits in uninterruptible I/O until the kernel gives up.
const fsp = require("fs/promises");
const path = require("path");
const contentdirs = require("./contentdirs");
const removable = require("./removable");

// A directory with more entries than this is a folder nobody scrolls on a TV, and
// the whole listing travels as one JSON body. The UI is told it was cut.
const MAX_ENTRIES = 4000;

// Natural order, so "Episode 2" comes before "Episode 10" and case is not a
// sorting axis on a TV.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

async function realpath(p) {
  try {
    return await fsp.realpath(p);
  } catch (e) {
    return null;
  }
}

function contained(target, root) {
  return target === root || target.startsWith(root + path.sep);
}

// Everything that can be opened right now: the user's folders, and each mounted
// removable partition. An unmounted stick is a source the UI offers but not a root
// to walk - it has no path until it is mounted.
function roots(deps, cb) {
  removable.list(deps, async (r) => {
    const out = [];
    for (const d of contentdirs.userDirs()) {
      const real = await realpath(d.path);
      if (real) out.push({ id: d.id, kind: "folder", name: d.name, path: d.path, real });
    }
    for (const dev of r.devices || []) {
      if (!dev.mountpoint) continue;
      const real = await realpath(dev.mountpoint);
      if (real) out.push({ id: "dev:" + dev.device, kind: "removable", name: dev.name, path: dev.mountpoint, real });
    }
    cb(out, r);
  });
}

// The source list the TV shows. A removable partition appears whether or not it is
// mounted (that is the whole point - it was just plugged in), carrying what the app
// needs to mount it on open.
function sources(deps, cb) {
  removable.list(deps, (r) => {
    const list = contentdirs
      .userDirs()
      .filter((d) => contentdirs.isDir(d.path))
      .map((d) => ({ id: d.id, kind: "folder", name: d.name, path: d.path, mounted: true }));
    for (const dev of r.devices || []) {
      list.push({
        id: "dev:" + dev.device,
        kind: "removable",
        name: dev.name,
        path: dev.mountpoint,
        mounted: !!dev.mountpoint,
        device: dev.device,
        fstype: dev.fstype,
        size: dev.size,
      });
    }
    cb({ sources: list, removable: { supported: !!r.supported, error: r.error || null } });
  });
}

// One entry of a directory, or null for one that should not be offered.
//
// A symlink is resolved and kept only if it lands inside the same root. Otherwise
// it is dropped rather than listed: it could not be opened anyway (list() resolves
// again), and a `film.mkv -> ~/.tvbox/config.json` on a prepared stick would
// otherwise report that file's size and mtime, which is an oracle for what exists
// on the box.
async function entryFor(dir, dirent, root) {
  const name = dirent.name;
  const full = path.join(dir, name);
  try {
    if (dirent.isSymbolicLink()) {
      const real = await realpath(full);
      if (!real || !contained(real, root)) return null;
    }
    // Follows the link on purpose once it is known to stay inside: what matters to
    // the caller is whether opening this entry lands on a directory or a file.
    const st = await fsp.stat(full);
    return {
      name,
      path: full,
      dir: st.isDirectory(),
      size: st.isDirectory() ? 0 : st.size,
      mtime: Math.round(st.mtimeMs),
    };
  } catch (e) {
    return null; // a broken link, or an entry that went away mid-listing
  }
}

// One directory inside one of the roots. Folders first, then files, both in
// natural order - the order a TV list is read in, decided here so every caller
// gets the same one.
function list(deps, target, cb) {
  const wanted = String(target || "");
  if (!path.isAbsolute(wanted)) return cb({ ok: false, error: "bad_path" });
  realpath(wanted).then((real) => {
    if (!real) return cb({ ok: false, error: "not_found" });
    roots(deps, async (rs) => {
      const root = rs.find((r) => contained(real, r.real));
      if (!root) return cb({ ok: false, error: "forbidden" });
      let dirents;
      try {
        if (!(await fsp.stat(real)).isDirectory()) return cb({ ok: false, error: "not_a_directory" });
        // withFileTypes: the kernel already told readdir what each entry is, so a
        // symlink is spotted without a second syscall per file.
        dirents = await fsp.readdir(real, { withFileTypes: true });
      } catch (e) {
        return cb({ ok: false, error: "unreadable" });
      }
      const wanted = dirents.filter((d) => !d.name.startsWith(".")); // a TV browser is not a file manager
      const truncated = wanted.length > MAX_ENTRIES;
      const entries = (await Promise.all(wanted.slice(0, MAX_ENTRIES).map((d) => entryFor(real, d, root.real))))
        .filter(Boolean)
        .sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1));
      // At the top of a source there is nowhere further up to go; the app shows its
      // source list instead. Anywhere else, Back walks the tree.
      const atRoot = real === root.real;
      cb({
        ok: true,
        path: real,
        name: atRoot ? root.name : path.basename(real),
        parent: atRoot ? null : path.dirname(real),
        root: { id: root.id, kind: root.kind, name: root.name, path: root.real },
        entries,
        truncated,
      });
    });
  });
}

module.exports = { MAX_ENTRIES, contained, roots, sources, list };
