// Housekeeping for the shared state directory (`<tmpdir>/bstack-rca/`).
//
// Everything a run produces — the state CSV, the evidence file and its
// contribution shards, the tool cache — lands here and is NEVER deleted by the
// run itself. That is deliberate: resume is keyed on buildId → same path, so
// cleaning up on completion would break `pending-resume`. The cost is that the
// directory accumulates, and that artifacts written by older versions keep
// whatever permissions they were created with.
//
// Both problems need a sweep rather than a per-write fix, because a write only
// ever touches the one file it is writing. `hardenStateDir` is cheap enough to
// run unconditionally at gate startup; `pruneStateDir` is deliberately NOT
// automatic (see below).

import { existsSync, readdirSync, statSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Make the whole state tree owner-only, repairing anything left open by an
 * older version.
 *
 * Per-write hardening can't do this: `writeRows` tightens the file it writes
 * and nothing else, so a build analysed before the hardening landed keeps its
 * 0644 forever unless something rewrites it — and a completed build never gets
 * rewritten. Measured on a real machine: the directory itself was drwxr-xr-x
 * and 6 files were still 0644, holding root causes, culprit PRs and log
 * excerpts in a shared OS temp dir.
 *
 * Never throws: a file owned by another user is skipped, because failing the
 * whole RCA run over one un-chmod-able leftover would be a worse outcome than
 * the leak we're closing.
 *
 * Returns `{ dirs, files, skipped }` counts.
 */
export function hardenStateDir(dir) {
  const out = { dirs: 0, files: 0, skipped: [] };
  if (!dir || !existsSync(dir)) return out;

  const walk = (p) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      out.skipped.push(p);
      return;
    }
    const isDir = st.isDirectory();
    const want = isDir ? 0o700 : 0o600;
    if ((st.mode & 0o777) !== want) {
      try {
        chmodSync(p, want);
      } catch {
        out.skipped.push(p);
        return; // can't chmod it; don't pretend we descended into it either
      }
    }
    if (isDir) {
      out.dirs++;
      let entries = [];
      try {
        entries = readdirSync(p);
      } catch {
        out.skipped.push(p);
        return;
      }
      for (const e of entries) walk(join(p, e));
    } else {
      out.files++;
    }
  };

  walk(dir);
  return out;
}

/**
 * Delete build artifacts older than `maxAgeMs` (default 7 days).
 *
 * NOT called automatically, and the default is deliberately far longer than
 * any run: these files ARE the resume state, so anything that deletes them can
 * silently turn a resumable build into a lost one. Seven days is well past the
 * minutes a batch takes while still bounding growth, and the caller has to ask
 * for it explicitly.
 *
 * `dryRun: true` reports what would go without touching anything — use it
 * before wiring this into anything automatic.
 *
 * Returns `{ removed, bytes, kept, dryRun }`.
 */
export function pruneStateDir(dir, nowMs, { maxAgeMs = 7 * 24 * 60 * 60 * 1000, dryRun = false } = {}) {
  const res = { removed: [], bytes: 0, kept: 0, dryRun };
  if (!dir || !existsSync(dir)) return res;

  const sizeOf = (p) => {
    let total = 0;
    const st = statSync(p);
    if (!st.isDirectory()) return st.size;
    for (const e of readdirSync(p)) {
      try {
        total += sizeOf(join(p, e));
      } catch { /* vanished mid-walk */ }
    }
    return total;
  };

  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    // mtime, not atime: reading an evidence file during a resume should not
    // make a long-abandoned build look freshly relevant.
    if (nowMs - st.mtimeMs <= maxAgeMs) {
      res.kept++;
      continue;
    }
    let bytes = 0;
    try {
      bytes = sizeOf(p);
    } catch { /* best effort */ }
    if (!dryRun) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        res.kept++;
        continue;
      }
    }
    res.removed.push(name);
    res.bytes += bytes;
  }
  return res;
}
