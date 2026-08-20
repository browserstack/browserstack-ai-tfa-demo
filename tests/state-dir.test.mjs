import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, statSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenStateDir, pruneStateDir } from "../lib/state-dir.mjs";

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

// These files ARE the resume state, so the default must not be able to eat a
// build someone is about to resume.
test("pruneStateDir keeps recent artifacts and removes only old ones", () => {
  const { root, dir } = fixture();
  // Pin every fixture file's mtime relative to the test's own clock — the
  // files are created at real "now", so a hardcoded future nowMs would make
  // the whole fixture look ancient and the test would pass for the wrong
  // reason (it did, first time round).
  const now = 1_800_000_000_000;
  // utimesSync takes SECONDS as a plain number; `new Date(seconds)` would be
  // read as milliseconds and land every stamp in 1970.
  const stamp = (p, ageSec) => { const s = now / 1000 - ageSec; utimesSync(p, s, s); };
  stamp(join(dir, "rca-state.b1.csv"), 60);
  stamp(join(dir, "rca-toolcache.b1"), 60);
  const old = join(dir, "rca-state.ancient.csv");
  writeFileSync(old, "x\n");
  stamp(old, 8 * 24 * 60 * 60);

  const r = pruneStateDir(dir, now);

  assert.deepEqual(r.removed, ["rca-state.ancient.csv"]);
  assert.equal(existsSync(old), false);
  assert.ok(existsSync(join(dir, "rca-state.b1.csv")), "a fresh build must survive");
  assert.ok(r.kept >= 1);

  rmSync(root, { recursive: true, force: true });
});

test("pruneStateDir dryRun reports without deleting", () => {
  const { root, dir } = fixture();
  // Pin every fixture file's mtime relative to the test's own clock — the
  // files are created at real "now", so a hardcoded future nowMs would make
  // the whole fixture look ancient and the test would pass for the wrong
  // reason (it did, first time round).
  const now = 1_800_000_000_000;
  // utimesSync takes SECONDS as a plain number; `new Date(seconds)` would be
  // read as milliseconds and land every stamp in 1970.
  const stamp = (p, ageSec) => { const s = now / 1000 - ageSec; utimesSync(p, s, s); };
  stamp(join(dir, "rca-state.b1.csv"), 60);
  stamp(join(dir, "rca-toolcache.b1"), 60);
  const old = join(dir, "rca-state.ancient.csv");
  writeFileSync(old, "x\n");
  stamp(old, 8 * 24 * 60 * 60);

  const r = pruneStateDir(dir, now, { dryRun: true });
  assert.deepEqual(r.removed, ["rca-state.ancient.csv"]);
  assert.equal(existsSync(old), true, "dryRun must not delete");

  rmSync(root, { recursive: true, force: true });
});
