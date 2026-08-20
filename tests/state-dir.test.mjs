import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenStateDir } from "../lib/state-dir.mjs";

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

