import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectRepresentative, siblingPreSeed } from "../lib/signature.mjs";

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

test("representative is deterministic: non-flaky, then smallest testRunId", () => {
  const members = [
    row(5, { is_flaky: "true" }),
    row(9, { is_flaky: "false" }),
    row(7, { is_flaky: "false" }),
  ];
  assert.equal(selectRepresentative(members).testRunId, "7");
});

test("siblingPreSeed refuses to seed from an unfinished representative", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rca-seed-"));
  const csvState = await import("../lib/csv-state.mjs");
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
