// Deletes ONE build's own temp/registry artifacts once its RCA report has
// generated successfully (skills/rca-build/SKILL.md Step 6, after
// triggerRcaReport succeeds — never before, never on a partial/failed run).
//
// This is deliberately NOT lib/state-dir.mjs's pruneStateDir: that function is
// a periodic, age-based sweep across every build in the shared temp dir, kept
// manual because it can't tell a finished build from an abandoned one and
// deleting a resumable build's state would silently break `pending-resume`.
// This module never faces that ambiguity — it only runs for a build whose
// every CSV row is already terminal and whose report just generated, so there
// is nothing left in this build's own state to resume. `pruneStateDir` still
// exists as the safety net for builds that never reach Step 6 (crashed
// mid-run); wiring that in is a separate, unrelated concern.
//
// Deletes exactly the four artifact families a build can produce, all scoped
// by buildId so a concurrent run over a DIFFERENT build in the same stateDir
// is never touched:
//   - rca-state.<buildId>.csv                    (lib/csv-state.mjs)
//   - rca-evidence.<buildId>.json (+ .contrib/)  (lib/evidence-file.mjs)
//   - rca-toolcache.<buildId>/                   (lib/tool-cache.mjs)
//   - rca-turn1.<buildId>.json                   (lib/turn1-registry.mjs)

import { existsSync, rmSync } from "node:fs";
import { csvPathFor } from "./csv-state.mjs";
import { evidencePathFor, contribDirFor } from "./evidence-file.mjs";
import { toolCacheDirFor } from "./tool-cache.mjs";
import { turn1PathFor } from "./turn1-registry.mjs";

/**
 * Delete this build's own CSV, evidence file + contribution shards, tool
 * cache, and turn1 registry. Best-effort per path: a missing file is not an
 * error (not every build produces a turn1 registry, e.g.), and a delete that
 * throws (permissions, vanished mid-sweep) is recorded in `errors` rather than
 * aborting the rest of the cleanup.
 *
 * Returns `{ deleted: [paths], errors: [{path, message}] }`.
 */
export function cleanupBuildArtifacts(buildId, stateDir = "") {
  const targets = [
    csvPathFor(buildId, stateDir),
    evidencePathFor(buildId, stateDir),
    contribDirFor(evidencePathFor(buildId, stateDir)),
    toolCacheDirFor(buildId, stateDir),
    turn1PathFor(buildId, stateDir),
  ];

  const deleted = [];
  const errors = [];
  for (const path of targets) {
    if (!existsSync(path)) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      deleted.push(path);
    } catch (err) {
      errors.push({ path, message: err?.message ?? String(err) });
    }
  }
  return { deleted, errors };
}
