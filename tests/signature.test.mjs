import { test } from "node:test";
import assert from "node:assert/strict";
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
