import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  seed,
  readRows,
  claim,
  heartbeat,
  flip,
  reaper,
  pendingRows,
  PENDING,
} from "../lib/csv-state.mjs";

let dir;
let csv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rca-csv-"));
  csv = join(dir, "state.csv");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const TESTS = [
  {
    test_id: 101,
    test_name: "login",
    failure: { category: "Assertion", error_summary: "expected 200", file_path: "a.rb" },
  },
  { test_id: 102, test_name: "checkout", failure: { category: "Timeout" } },
];

test("seed writes one pending row per test with signature columns", () => {
  const rows = seed(csv, "build-1", TESTS);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.rca_done === PENDING));
  const login = rows.find((r) => r.testRunId === "101");
  assert.equal(login.failure_category, "Assertion");
  assert.equal(login.error_summary, "expected 200");
  assert.equal(login.buildId, "build-1");
});

test("seed is idempotent — no duplicate rows on re-seed", () => {
  seed(csv, "build-1", TESTS);
  const rows = seed(csv, "build-1", TESTS);
  assert.equal(rows.length, 2);
});

test("seed preserves a terminal row on re-seed", () => {
  seed(csv, "build-1", TESTS);
  flip(csv, 101, { rca_done: "resolved", root_cause: "bad PR" }, 1000);
  seed(csv, "build-1", TESTS);
  const login = readRows(csv).find((r) => r.testRunId === "101");
  assert.equal(login.rca_done, "resolved");
  assert.equal(login.root_cause, "bad PR");
});

test("claim sets the worker; a second worker is refused", () => {
  seed(csv, "build-1", TESTS);
  assert.equal(claim(csv, 101, "w1", 1000), true);
  assert.equal(claim(csv, 101, "w2", 1000), false);
  const row = readRows(csv).find((r) => r.testRunId === "101");
  assert.equal(row.in_flight_worker, "w1");
});

test("heartbeat updates ts only for the owning worker", () => {
  seed(csv, "build-1", TESTS);
  claim(csv, 101, "w1", 1000);
  assert.equal(heartbeat(csv, 101, "w1", 2000), true);
  assert.equal(heartbeat(csv, 101, "w2", 3000), false);
  assert.equal(readRows(csv).find((r) => r.testRunId === "101").heartbeat_ts, "2000");
});

test("flip records terminal fields, joins related_prs, clears the claim", () => {
  seed(csv, "build-1", TESTS);
  claim(csv, 101, "w1", 1000);
  flip(
    csv,
    101,
    { rca_done: "resolved", root_cause: "PR #7421", related_prs: ["#7421", "#7430"], confidence: "high" },
    5000,
  );
  const row = readRows(csv).find((r) => r.testRunId === "101");
  assert.equal(row.rca_done, "resolved");
  assert.equal(row.related_prs, "#7421; #7430");
  assert.equal(row.confidence, "high");
  assert.equal(row.in_flight_worker, "");
  assert.equal(row.timestamp, "5000");
});

test("reaper reclaims only stale in-flight rows", () => {
  seed(csv, "build-1", TESTS);
  claim(csv, 101, "w1", 1000); // stale
  claim(csv, 102, "w2", 9000); // fresh
  const ttl = 600; // seconds
  const now = 1000 + ttl * 1000 + 1; // just past TTL for w1, fresh for w2
  const reclaimed = reaper(csv, ttl, now);
  assert.deepEqual(reclaimed, ["101"]);
  const rows = readRows(csv);
  assert.equal(rows.find((r) => r.testRunId === "101").in_flight_worker, "");
  assert.equal(rows.find((r) => r.testRunId === "101").rca_done, PENDING);
  assert.equal(rows.find((r) => r.testRunId === "102").in_flight_worker, "w2");
});

test("reaper leaves terminal rows alone even if in_flight lingered", () => {
  seed(csv, "build-1", TESTS);
  claim(csv, 101, "w1", 1000);
  flip(csv, 101, { rca_done: "resolved" }, 2000); // flip clears in_flight
  const reclaimed = reaper(csv, 600, 10_000_000);
  assert.deepEqual(reclaimed, []);
});

test("pendingRows returns only pending work", () => {
  seed(csv, "build-1", TESTS);
  flip(csv, 101, { rca_done: "resolved" }, 1000);
  const pend = pendingRows(csv);
  assert.equal(pend.length, 1);
  assert.equal(pend[0].testRunId, "102");
});

test("flip rejects a missing/non-terminal rca_done without mutating the row", () => {
  seed(csv, "build-1", TESTS);
  claim(csv, 101, "w1", 1000);
  // missing rca_done
  assert.equal(flip(csv, 101, { root_cause: "x" }, 2000), false);
  // invalid rca_done
  assert.equal(flip(csv, 101, { rca_done: "weird" }, 2000), false);
  const row = readRows(csv).find((r) => r.testRunId === "101");
  assert.equal(row.rca_done, PENDING); // not reverted to claimable-pending silently
  assert.equal(row.in_flight_worker, "w1"); // claim intact — bug surfaces, no clobber
  assert.equal(row.root_cause, ""); // nothing written
});

test("pending-resume is resumable: not terminal, listed, and re-claimable", () => {
  seed(csv, "build-1", TESTS);
  claim(csv, 101, "w1", 1000);
  flip(csv, 101, { rca_done: "pending-resume", threadId: "thr-1", turnId: "t-1" }, 2000);
  const row = readRows(csv).find((r) => r.testRunId === "101");
  assert.equal(row.in_flight_worker, ""); // this attempt released the claim
  assert.equal(row.threadId, "thr-1"); // resume handles retained
  assert.equal(row.turnId, "t-1");
  // appears in the fan-out work-list and can be claimed by the resume pass
  assert.ok(pendingRows(csv).some((r) => r.testRunId === "101"));
  assert.equal(claim(csv, 101, "w2", 3000), true);
});

test("reaper ignores pending-resume rows (not in flight)", () => {
  seed(csv, "build-1", TESTS);
  claim(csv, 101, "w1", 1000);
  flip(csv, 101, { rca_done: "pending-resume" }, 2000);
  assert.deepEqual(reaper(csv, 600, 10_000_000), []);
});

test("CSV codec round-trips fields with commas, quotes, newlines", () => {
  seed(csv, "build-1", [{ test_id: 200, test_name: "weird" }]);
  flip(
    csv,
    200,
    { rca_done: "resolved", root_cause: 'Failed: "x", got <y>\nsecond line' },
    1000,
  );
  const row = readRows(csv).find((r) => r.testRunId === "200");
  assert.equal(row.root_cause, 'Failed: "x", got <y>\nsecond line');
});
