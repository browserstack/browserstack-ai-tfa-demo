// Housekeeping for the shared state directory (`<tmpdir>/bstack-rca/`).
//
// Everything a run produces — the state CSV, the evidence file and its
// contribution shards, the tool cache — lands here and is NEVER deleted by the
// plugin. That is deliberate: this is the user's machine, resume is keyed on
// buildId → same path, and reclaiming the OS temp dir is the OS's job, not
// ours. `hardenStateDir` only tightens permissions (owner-only) — it never
// deletes — and is cheap enough to run unconditionally at gate startup.

import { existsSync, readdirSync, statSync, chmodSync } from "node:fs";
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
