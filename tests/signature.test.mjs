import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalize,
  computeSignature,
  selectRepresentative,
  clusterRows,
} from "../lib/signature.mjs";

function row(id, extra = {}) {
  return {
    testRunId: String(id),
    failure_category: "Assertion",
    error_summary: "expected 200 but got 500",
    file_path: "spec/login.rb",
    is_flaky: "false",
    ...extra,
  };
}

test("normalize folds timestamps, uuids, hex, line:col, and numbers", () => {
  assert.equal(normalize("Error at line :42:7"), "error at line :<line>");
  assert.equal(normalize("got 500 at 0xAF3"), "got <n> at <hex>");
  assert.equal(
    normalize("failed 2026-06-23T10:00:00Z"),
    "failed <ts>",
  );
});

test("identical category+error+path → same cluster", () => {
  const { clusters } = clusterRows([row(1), row(2)]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].members.length, 2);
});

test("numbers in the error are folded so siblings still cluster", () => {
  const a = row(1, { error_summary: "timeout after 3000ms on node-7" });
  const b = row(2, { error_summary: "timeout after 5000ms on node-2" });
  assert.equal(computeSignature(a), computeSignature(b));
  const { clusters } = clusterRows([a, b]);
  assert.equal(clusters.length, 1);
});

test("distinct failures → distinct clusters", () => {
  const a = row(1, { error_summary: "null pointer in Foo" });
  const b = row(2, { error_summary: "connection refused" });
  const { clusters } = clusterRows([a, b]);
  assert.equal(clusters.length, 2);
});

test("rows with no signal become their own singletons (no catch-all merge)", () => {
  const a = { testRunId: "1", failure_category: "", error_summary: "", file_path: "" };
  const b = { testRunId: "2", failure_category: "", error_summary: "", file_path: "" };
  const { clusters } = clusterRows([a, b]);
  assert.equal(clusters.length, 2);
  assert.ok(clusters.every((c) => c.cluster_id.startsWith("solo-")));
});

test("singleton cluster has a representative and no siblings", () => {
  const { clusters } = clusterRows([row(1)]);
  assert.equal(clusters[0].siblings.length, 0);
  assert.equal(clusters[0].representative.testRunId, "1");
});

test("representative is deterministic: non-flaky, then smallest testRunId", () => {
  const members = [
    row(5, { is_flaky: "true" }),
    row(9, { is_flaky: "false" }),
    row(7, { is_flaky: "false" }),
  ];
  assert.equal(selectRepresentative(members).testRunId, "7");
});

test("clusterRows stamps cluster_id onto every row", () => {
  const rows = [row(1), row(2, { error_summary: "different" })];
  clusterRows(rows);
  assert.ok(rows.every((r) => r.cluster_id));
  assert.notEqual(rows[0].cluster_id, rows[1].cluster_id);
});

// clusterRows mutates its input; a caller that destructures only `clusters`
// silently loses every cluster_id. Two independent callers did exactly that on
// the same day, collapsing a clustered run into one coordinator per test.
test("clusterAndPersist writes cluster_id back to the CSV", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rca-cap-"));
  const csvState = await import("../lib/csv-state.mjs");
  const { clusterAndPersist } = await import("../lib/signature.mjs");
  const csv = join(dir, "s.csv");
  csvState.seed(csv, "b", [
    { test_id: 1, test_name: "a", failure: { error_summary: "boom" } },
    { test_id: 2, test_name: "b", failure: { error_summary: "boom" } },
    { test_id: 3, test_name: "c", failure: { error_summary: "other" } },
  ]);

  const clusters = clusterAndPersist(csv, csvState);
  assert.equal(clusters.length, 2, "two distinct signatures");

  // The whole point: re-READ from disk, don't trust the in-memory rows.
  const reread = csvState.readRows(csv);
  assert.ok(reread.every((r) => r.cluster_id), "every row must have a persisted cluster_id");
  assert.equal(reread[0].cluster_id, reread[1].cluster_id, "same signature → same cluster");
  assert.notEqual(reread[0].cluster_id, reread[2].cluster_id);

  rmSync(dir, { recursive: true, force: true });
});

// Siblings are only cheap because they confirm someone else's hypothesis.
// Dispatched without one they re-investigate from scratch — measured at 22.7
// calls vs 8.0 for the representative they were meant to be a fraction of.
test("siblingPreSeed refuses to seed from an unfinished representative", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rca-seed-"));
  const csvState = await import("../lib/csv-state.mjs");
  const { siblingPreSeed } = await import("../lib/signature.mjs");
  const csv = join(dir, "s.csv");
  csvState.seed(csv, "b", [
    { test_id: 1, test_name: "rep", failure: { error_summary: "boom" } },
    { test_id: 2, test_name: "sib", failure: { error_summary: "boom" } },
  ]);

  const early = siblingPreSeed(csv, csvState, "c-1", 1);
  assert.equal(early.ok, false, "rep is still pending — must block");
  assert.match(early.reason, /not resolved/);

  // Resolved but with no root_cause is equally useless to a sibling.
  csvState.flip(csv, 1, { rca_done: "resolved" }, 1000);
  const empty = siblingPreSeed(csv, csvState, "c-1", 1);
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /no root_cause/);

  csvState.flip(csv, 1, { rca_done: "resolved", root_cause: "PR #42 broke seeding", failure_type: "PRODUCT_BUG" }, 2000);
  const ok = siblingPreSeed(csv, csvState, "c-1", 1);
  assert.equal(ok.ok, true);
  assert.equal(ok.pre_seed.cause, "PR #42 broke seeding");
  assert.equal(ok.pre_seed.failure_type, "PRODUCT_BUG");
  assert.match(ok.pre_seed.instruction, /Do not adopt it/, "independence must travel with the seed");

  rmSync(dir, { recursive: true, force: true });
});
