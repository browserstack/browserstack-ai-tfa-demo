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

test("a write that loses cluster_ids is refused, not continued past", () => {
  // The read-back guard was VACUOUS: `const unpersisted = 0; if (false)` kept the
  // whole suite green. The module names this check as the one that would have
  // caught the discarded-cluster_id bug "the first time, instead of the second",
  // so it needs a lossy writer to prove it fires.
  const csv = setup([t("1"), t("2")]);
  const lossy = {
    readRows: csvState.readRows,
    writeRows: (p, rows) => csvState.writeRows(p, rows.map((r) => ({ ...r, cluster_id: "" }))),
  };
  assert.throws(() => persistClusters(csv, lossy, { 1: "c-A", 2: "c-A" }), /partially clustered/);
});

test("clustering a CSV that isn't there is refused, not reported as no clusters", () => {
  // readRows returns [] for a missing file, so a wrong buildId or stateDir wrote a
  // header-only CSV, skipped the read-back guard and returned [] as SUCCESS.
  const dir2 = mkdtempSync(join(tmpdir(), "rca-missing-"));
  const wrong = join(dir2, "typo.csv");
  assert.throws(() => persistClusters(wrong, csvState, { 1: "c-A" }), /no rows at/);
  rmSync(dir2, { recursive: true, force: true });
});

test("the representative is excluded from siblings, by identity not by position", () => {
  // `members.slice(1)` passed every test, because nothing exercised a rep that was
  // not members[0]. Flakiness cannot be used to force that here: `is_flaky` is not
  // in csv-state's COLUMNS, so a seeded row never carries it — see
  // selectRepresentative's note. Driving the function directly instead.
  const members = [
    { testRunId: "5", is_flaky: "true" },
    { testRunId: "9", is_flaky: "false" },
    { testRunId: "7", is_flaky: "false" },
  ];
  assert.equal(selectRepresentative(members).testRunId, "7", "non-flaky first, then lowest id");

  // Seeded out of order on purpose, so the representative is NOT members[0] —
  // which is the only shape that can tell identity from position.
  const csv = setup([t("3"), t("1"), t("2")]);
  const [cluster] = persistClusters(csv, csvState, { 1: "c-A", 2: "c-A", 3: "c-A" });
  assert.equal(cluster.representative.testRunId, "1", "lowest id, and it sits at members[1]");
  assert.deepEqual(cluster.siblings.map((x) => x.testRunId).sort(), ["2", "3"]);
  assert.ok(!cluster.siblings.some((x) => x.testRunId === cluster.representative.testRunId));
});

test("a non-numeric testRunId still sorts deterministically", () => {
  // Number() of a non-numeric id is NaN, a NaN comparator makes sort order
  // implementation-defined, and the whole point of this function is that a resume
  // picks the same exemplar. Executed both directions.
  const members = ["id-3", "id-11", "id-2"].map((testRunId) => ({ testRunId, is_flaky: "false" }));
  const forward = selectRepresentative(members).testRunId;
  const reversed = selectRepresentative([...members].reverse()).testRunId;
  assert.equal(forward, reversed, "order of input must not decide the representative");
});
