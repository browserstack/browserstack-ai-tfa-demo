// Housekeeping for the shared state directory (`<tmpdir>/bstack-rca/`).
//
// Everything a run produces — the state CSV, the evidence file and its
// contribution shards, the tool cache — lands here and is NEVER deleted by the
// plugin. That is deliberate: this is the user's machine, resume is keyed on
// buildId → same path, and reclaiming the OS temp dir is the OS's job, not
// ours. `hardenStateDir` only tightens permissions (owner-only) — it never
// deletes — and is cheap enough to run unconditionally at gate startup.

import { existsSync, mkdirSync, readdirSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Filesystem-safe segment. Matches the sanitiser the other per-build paths use. */
const safeSegment = (v, fallback) =>
  String(v ?? "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || fallback;

/**
 * A scratch directory of one agent's own, under the shared state tree.
 *
 * Agents sometimes genuinely need a file on disk — a response too large to hold in
 * context, a message worth re-reading. Before this they wrote them into the
 * invocation directory, which is the CUSTOMER's, and they all shared it: parallel
 * coordinators picked the same short filenames independently, so they overwrote each
 * other's work as well as leaving it behind.
 *
 * Two properties, both structural rather than remembered:
 *
 *   * **Per agent.** The path is keyed on `writerId`, so no two agents can collide
 *     however they name a file inside it. That is why this takes a writerId at all
 *     rather than just a buildId.
 *   * **Not the customer's directory.** It sits beside the CSV, the evidence shards
 *     and the tool cache, where run state already lives and where the OS reclaims
 *     it. Nothing the plugin writes there is in anyone's repo.
 *
 * Owner-only (0700), like everything else here — scratch holds fetched source and
 * API responses, which is the same material the shards hold.
 *
 * Deleting is still the agent's job: this contains the mess, it does not excuse it.
 * `hardenStateDir`'s contract stands — the plugin never deletes what it did not
 * create, and only the agent that wrote a file knows which one that was.
 */
export function scratchDirFor(buildId, writerId, stateDir = "") {
  const root = stateDir && String(stateDir).trim() !== "" ? String(stateDir) : join(tmpdir(), "bstack-rca");
  const dir = join(
    root,
    `rca-scratch.${safeSegment(buildId, "unknown-build")}`,
    safeSegment(writerId, "unknown-writer"),
  );
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else { try { chmodSync(dir, 0o700); } catch { /* not ours to tighten */ } }
  return dir;
}

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
