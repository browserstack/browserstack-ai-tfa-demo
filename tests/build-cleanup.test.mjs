import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupBuildArtifacts } from "../lib/build-cleanup.mjs";
import { csvPathFor } from "../lib/csv-state.mjs";
import { evidencePathFor, contribDirFor } from "../lib/evidence-file.mjs";
import { toolCacheDirFor } from "../lib/tool-cache.mjs";
import { turn1PathFor } from "../lib/turn1-registry.mjs";

function fixture() {
  return mkdtempSync(join(tmpdir(), "rca-cleanup-"));
}

// Writes every artifact family for one build, so a test can assert cleanup
// removed exactly (and only) what that build produced.
function seedBuild(buildId, dir) {
  writeFileSync(csvPathFor(buildId, dir), "buildId,testRunId\n");
  writeFileSync(evidencePathFor(buildId, dir), "{}");
  const contrib = contribDirFor(evidencePathFor(buildId, dir));
  mkdirSync(contrib, { recursive: true });
  writeFileSync(join(contrib, "3900000001.json"), "{}");
  const cache = toolCacheDirFor(buildId, dir);
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "entry.json"), "{}");
  writeFileSync(turn1PathFor(buildId, dir), "{}");
}

test("cleanupBuildArtifacts deletes every artifact family for the given build", () => {
  const dir = fixture();
  seedBuild("b1", dir);

  const r = cleanupBuildArtifacts("b1", dir);

  assert.equal(existsSync(csvPathFor("b1", dir)), false);
  assert.equal(existsSync(evidencePathFor("b1", dir)), false);
  assert.equal(existsSync(contribDirFor(evidencePathFor("b1", dir))), false);
  assert.equal(existsSync(toolCacheDirFor("b1", dir)), false);
  assert.equal(existsSync(turn1PathFor("b1", dir)), false);
  assert.equal(r.deleted.length, 5);
  assert.deepEqual(r.errors, []);

  rmSync(dir, { recursive: true, force: true });
});

// The load-bearing test: a concurrent run over a DIFFERENT build in the same
// stateDir must survive this build's cleanup untouched — nothing here should
// ever glob/sweep the shared directory.
test("cleanupBuildArtifacts never touches a different build's artifacts in the same stateDir", () => {
  const dir = fixture();
  seedBuild("b1", dir);
  seedBuild("b2", dir);

  cleanupBuildArtifacts("b1", dir);

  assert.equal(existsSync(csvPathFor("b1", dir)), false);
  assert.equal(existsSync(csvPathFor("b2", dir)), true, "other build's CSV must survive");
  assert.equal(existsSync(evidencePathFor("b2", dir)), true, "other build's evidence file must survive");
  assert.equal(existsSync(contribDirFor(evidencePathFor("b2", dir))), true, "other build's shards must survive");
  assert.equal(existsSync(toolCacheDirFor("b2", dir)), true, "other build's tool cache must survive");
  assert.equal(existsSync(turn1PathFor("b2", dir)), true, "other build's turn1 registry must survive");

  rmSync(dir, { recursive: true, force: true });
});

test("cleanupBuildArtifacts is a no-op, not a throw, when nothing was ever written for this build", () => {
  const dir = fixture();
  const r = cleanupBuildArtifacts("never-ran", dir);
  assert.deepEqual(r, { deleted: [], errors: [] });
  rmSync(dir, { recursive: true, force: true });
});

test("cleanupBuildArtifacts tolerates a build with only some artifact families present", () => {
  const dir = fixture();
  // Only the CSV and turn1 registry exist — no evidence file, no tool cache
  // (e.g. an unclustered rerun that never hit Step 4b's NEEDS_INFO/PENDING path).
  writeFileSync(csvPathFor("b1", dir), "buildId,testRunId\n");
  writeFileSync(turn1PathFor("b1", dir), "{}");

  const r = cleanupBuildArtifacts("b1", dir);

  assert.equal(r.deleted.length, 2);
  assert.equal(existsSync(csvPathFor("b1", dir)), false);
  assert.equal(existsSync(turn1PathFor("b1", dir)), false);

  rmSync(dir, { recursive: true, force: true });
});
