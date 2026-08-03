import { test } from "node:test";
import assert from "node:assert/strict";
import { clustersFromThemes } from "../lib/theme-clustering.mjs";

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

function theme(buildFailureThemeId, name = "Some Theme") {
  return {
    themeId: `uuid-${buildFailureThemeId}`,
    buildFailureThemeId,
    themeData: { name, description: "..." },
    affectedWorkflows: [],
  };
}

test("one theme with two members → one cluster, representative + one sibling", () => {
  const rows = [row(1), row(2)];
  const themesResult = { buildThemes: [theme(10, "Data Assertion Mismatch")] };
  const testsByThemeId = { 10: [{ testRunId: "1" }, { testRunId: "2" }] };

  const { clusters } = clustersFromThemes(rows, themesResult, testsByThemeId);

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].cluster_id, "theme-10");
  assert.equal(clusters[0].signature, "Data Assertion Mismatch");
  assert.equal(clusters[0].members.length, 2);
  assert.equal(clusters[0].siblings.length, 1);
  assert.ok(clusters[0].representative);
});

test("multiple themes → one cluster each", () => {
  const rows = [row(1), row(2), row(3)];
  const themesResult = {
    buildThemes: [theme(10, "Theme A"), theme(20, "Theme B")],
  };
  const testsByThemeId = {
    10: [{ testRunId: "1" }],
    20: [{ testRunId: "2" }, { testRunId: "3" }],
  };

  const { clusters } = clustersFromThemes(rows, themesResult, testsByThemeId);

  assert.equal(clusters.length, 2);
  const a = clusters.find((c) => c.cluster_id === "theme-10");
  const b = clusters.find((c) => c.cluster_id === "theme-20");
  assert.equal(a.members.length, 1);
  assert.equal(a.siblings.length, 0);
  assert.equal(b.members.length, 2);
  assert.equal(b.siblings.length, 1);
});

test("a failed test not assigned to any theme becomes its own singleton (never dropped)", () => {
  const rows = [row(1), row(2)];
  const themesResult = { buildThemes: [theme(10, "Theme A")] };
  const testsByThemeId = { 10: [{ testRunId: "1" }] };

  const { clusters } = clustersFromThemes(rows, themesResult, testsByThemeId);

  assert.equal(clusters.length, 2);
  const solo = clusters.find((c) => c.cluster_id === "solo-2");
  assert.ok(solo, "uncovered test must still get a cluster");
  assert.equal(solo.members.length, 1);
  assert.equal(solo.siblings.length, 0);
  assert.equal(solo.representative.testRunId, "2");
});

test("a theme with no matched member rows is skipped, not an empty cluster", () => {
  const rows = [row(1)];
  const themesResult = { buildThemes: [theme(10, "Theme A"), theme(20, "Empty theme")] };
  const testsByThemeId = { 10: [{ testRunId: "1" }], 20: [] };

  const { clusters } = clustersFromThemes(rows, themesResult, testsByThemeId);

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].cluster_id, "theme-10");
});

test("member rows not present in listTestIds rows are dropped, not fabricated", () => {
  const rows = [row(1)];
  const themesResult = { buildThemes: [theme(10, "Theme A")] };
  // testsByThemeId names a testRunId ("999") that never appeared in listTestIds.
  const testsByThemeId = { 10: [{ testRunId: "1" }, { testRunId: "999" }] };

  const { clusters } = clustersFromThemes(rows, themesResult, testsByThemeId);

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].members.length, 1);
});

test("representative selection matches lib/signature.mjs's rule (non-flaky, then smallest testRunId)", () => {
  const rows = [
    row(5, { is_flaky: "true" }),
    row(9, { is_flaky: "false" }),
    row(7, { is_flaky: "false" }),
  ];
  const themesResult = { buildThemes: [theme(10)] };
  const testsByThemeId = {
    10: [{ testRunId: "5" }, { testRunId: "9" }, { testRunId: "7" }],
  };

  const { clusters } = clustersFromThemes(rows, themesResult, testsByThemeId);

  assert.equal(clusters[0].representative.testRunId, "7");
});

test("clustersFromThemes stamps cluster_id onto every row, theme and singleton alike", () => {
  const rows = [row(1), row(2)];
  const themesResult = { buildThemes: [theme(10)] };
  const testsByThemeId = { 10: [{ testRunId: "1" }] };

  clustersFromThemes(rows, themesResult, testsByThemeId);

  assert.equal(rows[0].cluster_id, "theme-10");
  assert.equal(rows[1].cluster_id, "solo-2");
});

test("numeric testRunId in theme membership (as the MCP tool's JSON would send it) still matches string testRunId rows", () => {
  const rows = [row(1), row(2)];
  const themesResult = { buildThemes: [theme(10)] };
  // Membership entries carry testRunId as a NUMBER, unlike listTestIds rows (strings).
  const testsByThemeId = { 10: [{ testRunId: 1 }, { testRunId: 2 }] };

  const { clusters } = clustersFromThemes(rows, themesResult, testsByThemeId);

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].members.length, 2);
});

test("a testRunId claimed by an earlier theme is skipped by a later theme (first-theme-wins, no duplicate membership)", () => {
  const rows = [row(1), row(2)];
  const themesResult = { buildThemes: [theme(10, "Theme A"), theme(20, "Theme B")] };
  // Both themes claim testRunId "1" — the server is expected never to do this,
  // but the function must not let the row land in two clusters.
  const testsByThemeId = {
    10: [{ testRunId: "1" }],
    20: [{ testRunId: "1" }, { testRunId: "2" }],
  };

  const { clusters } = clustersFromThemes(rows, themesResult, testsByThemeId);

  assert.equal(clusters.length, 2);
  const a = clusters.find((c) => c.cluster_id === "theme-10");
  const b = clusters.find((c) => c.cluster_id === "theme-20");
  assert.equal(a.members.length, 1);
  assert.equal(a.members[0].testRunId, "1");
  assert.equal(b.members.length, 1, "testRunId 1 must not also land in theme 20");
  assert.equal(b.members[0].testRunId, "2");
  assert.equal(rows[0].cluster_id, "theme-10");
});

test("no themes at all → every row is its own singleton", () => {
  const rows = [row(1), row(2)];
  const themesResult = { buildThemes: [] };

  const { clusters } = clustersFromThemes(rows, themesResult, {});

  assert.equal(clusters.length, 2);
  assert.ok(clusters.every((c) => c.cluster_id.startsWith("solo-")));
});
