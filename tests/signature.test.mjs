// The grouping is the agent's now, so this suite tests the two things that are
// NOT judgement — and both are here because they failed in production, not because
// they were nice to guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistClusters, selectRepresentative, siblingPreSeed } from "../lib/signature.mjs";
import * as csvState from "../lib/csv-state.mjs";

let dir;
const setup = (tests) => {
  dir = mkdtempSync(join(tmpdir(), "rca-clusters-"));
  const csv = csvState.csvPathFor("b1", dir);
  csvState.seed(csv, "b1", tests);
  return csv;
};
const t = (testRunId, over = {}) => ({ testRunId, testName: `t${testRunId}`, ...over });

test.afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

test("a representative is deterministic, so a resume does not re-investigate", () => {
  // The CSV persists cluster_id but NOT which member was the exemplar, so a
  // resumed run that chose differently would pay for the expensive investigation
  // twice. Non-flaky first, then smallest testRunId.
  const members = [
    { testRunId: "5", is_flaky: "false" },
    { testRunId: "2", is_flaky: "true" },
    { testRunId: "9", is_flaky: "false" },
  ];
  assert.equal(selectRepresentative(members).testRunId, "5");
  assert.equal(selectRepresentative([...members].reverse()).testRunId, "5", "order-independent");
  assert.equal(selectRepresentative([{ testRunId: "7", is_flaky: "true" }]).testRunId, "7",
    "an all-flaky cluster still gets one");
});

test("the agent's clustering is persisted and read back", () => {
  const csv = setup([t("1"), t("2"), t("3")]);
  const clusters = persistClusters(csv, csvState, { 1: "timeout-on-login", 2: "timeout-on-login", 3: "stale-selector" });

  assert.deepEqual(clusters.map((c) => c.cluster_id).sort(), ["stale-selector", "timeout-on-login"]);
  const rows = csvState.readRows(csv);
  assert.deepEqual(rows.map((r) => r.cluster_id), ["timeout-on-login", "timeout-on-login", "stale-selector"],
    "every cluster_id reaches the CSV");

  const big = clusters.find((c) => c.cluster_id === "timeout-on-login");
  assert.equal(big.representative.testRunId, "1");
  assert.deepEqual(big.siblings.map((s) => s.testRunId), ["2"]);
});

test("a row left unassigned is refused, not quietly made its own cluster", () => {
  // MUTATION: drop the `missing` check and this passes while the run silently
  // fans out one coordinator per unassigned test — the exact degradation the
  // discarded-cluster_id bug caused, twice, in one day.
  const csv = setup([t("1"), t("2"), t("3")]);
  assert.throws(
    () => persistClusters(csv, csvState, { 1: "a", 3: "b" }),
    /1 of 3 rows have no cluster assigned/,
  );
  assert.deepEqual(csvState.readRows(csv).map((r) => r.cluster_id), ["", "", ""],
    "and nothing was written — a refused call leaves the CSV untouched");
});

test("a singleton is a decision the agent can make", () => {
  const csv = setup([t("1"), t("2")]);
  const clusters = persistClusters(csv, csvState, { 1: "solo-1", 2: "solo-2" });
  assert.equal(clusters.length, 2);
  assert.ok(clusters.every((c) => c.siblings.length === 0));
});

// ---- the sibling guard ------------------------------------------------------

test("a sibling is refused until its representative is terminal", () => {
  // Siblings are cheap only because they confirm someone else's hypothesis.
  // Dispatched without one they averaged 22.7 tool calls against the
  // representative's 8.0, and one burned 60 calls over 17 minutes — silently,
  // because nothing ordered them or refused them.
  const csv = setup([t("1"), t("2")]);
  persistClusters(csv, csvState, { 1: "c-A", 2: "c-A" });

  const early = siblingPreSeed(csv, csvState, "c-A", "1");
  assert.equal(early.ok, false);
  assert.match(early.reason, /not resolved/);

  csvState.flip(csv, "1", { rca_done: "resolved", root_cause: "login timeout under load" }, 1000);
  const ready = siblingPreSeed(csv, csvState, "c-A", "1");
  assert.equal(ready.ok, true);
  assert.equal(ready.pre_seed.cause, "login timeout under load");
  assert.match(ready.pre_seed.instruction, /YOUR OWN test's evidence/,
    "the seed must tell the sibling to confirm, not to adopt");
});

test("a representative that resolved with no cause seeds nothing", () => {
  const csv = setup([t("1"), t("2")]);
  persistClusters(csv, csvState, { 1: "c-A", 2: "c-A" });
  csvState.flip(csv, "1", { rca_done: "resolved" }, 1000);
  const r = siblingPreSeed(csv, csvState, "c-A", "1");
  assert.equal(r.ok, false);
  assert.match(r.reason, /no root_cause/);
});

test("an unknown representative is named, not silently seeded", () => {
  const csv = setup([t("1")]);
  const r = siblingPreSeed(csv, csvState, "c-A", "999");
  assert.equal(r.ok, false);
  assert.match(r.reason, /not in the CSV/);
});
