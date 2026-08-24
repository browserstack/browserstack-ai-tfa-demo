import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { hardenStateDir, scratchDirFor } from "../lib/state-dir.mjs";

const mode = (p) => statSync(p).mode & 0o777;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rca-sd-"));
  const dir = join(root, "bstack-rca");
  mkdirSync(dir, { mode: 0o755 });
  writeFileSync(join(dir, "rca-state.b1.csv"), "a\n", { mode: 0o644 });
  const cache = join(dir, "rca-toolcache.b1");
  mkdirSync(cache, { mode: 0o755 });
  writeFileSync(join(cache, "entry.json"), "{}", { mode: 0o644 });
  chmodSync(dir, 0o755);
  chmodSync(cache, 0o755);
  return { root, dir, cache };
}

// Per-write hardening only fixes the file being written, so a build analysed
// before the hardening landed keeps 0644 forever — a completed build is never
// rewritten. This is the sweep that repairs them.
test("hardenStateDir tightens leftovers recursively", () => {
  const { root, dir, cache } = fixture();
  assert.equal(mode(dir), 0o755, "fixture must start open, else the test proves nothing");

  const r = hardenStateDir(dir);

  assert.equal(mode(dir), 0o700);
  assert.equal(mode(join(dir, "rca-state.b1.csv")), 0o600);
  assert.equal(mode(cache), 0o700, "nested cache dir too");
  assert.equal(mode(join(cache, "entry.json")), 0o600, "files inside nested dirs too");
  assert.equal(r.files, 2);
  assert.equal(r.dirs, 2);

  rmSync(root, { recursive: true, force: true });
});

test("hardenStateDir is idempotent and safe on a missing dir", () => {
  const { root, dir } = fixture();
  hardenStateDir(dir);
  const second = hardenStateDir(dir);
  assert.equal(mode(dir), 0o700);
  assert.equal(second.files, 2, "still walks, just has nothing to change");

  assert.deepEqual(hardenStateDir(join(root, "nope")), { dirs: 0, files: 0, skipped: [] });
  rmSync(root, { recursive: true, force: true });
});


// ---- scratchDirFor: an agent's own directory, not the customer's ------------
//
// Agents were writing fetched source and API responses into the invocation
// directory, which is the CUSTOMER's, and sharing it: parallel coordinators chose
// the same short filenames independently, so they overwrote each other's work as
// well as leaving 572 KB of it behind in a repo root.
//
// Containment is structural here, not remembered. Deleting is still the agent's job
// — this makes the mess survivable, it does not excuse it.

test("two agents on one build never share a scratch directory", () => {
  // MUTATION: drop writerId from the path -> both agents collide and this fails.
  // That collision is not just litter: it is one agent overwriting another's file.
  const root = mkdtempSync(join(tmpdir(), "scratch-"));
  try {
    const a = scratchDirFor("b1", "writer-a", root);
    const b = scratchDirFor("b1", "writer-b", root);
    assert.notEqual(a, b);
    writeFileSync(join(a, "same-name"), "A");
    writeFileSync(join(b, "same-name"), "B");
    assert.equal(readFileSync(join(a, "same-name"), "utf8"), "A", "B must not have clobbered A");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the directory is created owner-only, like the rest of the state tree", () => {
  // It holds fetched source and raw API responses — the same material as the
  // evidence shards, which are 0700 for the reason hardenStateDir documents.
  const root = mkdtempSync(join(tmpdir(), "scratch-"));
  try {
    assert.equal(mode(scratchDirFor("b1", "w1", root)), 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("it lands under the state tree, never in the invocation directory", () => {
  // The whole point: run state already lives beside the CSV and the tool cache,
  // where the OS reclaims it and nothing is in anyone's repo.
  const root = mkdtempSync(join(tmpdir(), "scratch-"));
  try {
    assert.ok(scratchDirFor("b1", "w1", root).startsWith(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a build id or writer id cannot escape the state tree", () => {
  // Both arrive from a run: a buildId from an argument, a writerId from a testRunId.
  // MUTATION: drop the sanitiser -> the traversal resolves outside root and fails.
  const root = mkdtempSync(join(tmpdir(), "scratch-"));
  try {
    const dir = scratchDirFor("../../escape", "../../../etc", root);
    // The property is containment, not the absence of the characters "..": a
    // sanitised segment like `__.._escape` still CONTAINS them and is perfectly
    // safe. What must not exist is a segment that IS `..`, and the resolved path
    // must stay under root.
    assert.equal(resolve(dir).startsWith(resolve(root)), true, dir);
    assert.ok(!dir.split(sep).includes(".."), `no segment may be '..': ${dir}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
