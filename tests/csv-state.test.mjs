import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  csvPathFor,
  seed,
  readRows,
  writeRows,
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

// Regression: `flip` used to accept ONLY the lowercase CSV vocabulary and
// return a bare `false` for anything else — including `RESOLVED`, the exact
// value the RCA_OUTPUT contract mandates. A whole batch of coordinator results
// was lost that way: they called flip, got a silent no-op, and the rows stayed
// `pending` looking un-run.
test("flip accepts the RCA_OUTPUT vocabulary and normalizes it", () => {
  seed(csv, "build-1", TESTS);
  assert.equal(flip(csv, 101, { rca_done: "RESOLVED", root_cause: "x" }, 1000), true);
  assert.equal(readRows(csv).find((r) => r.testRunId === "101").rca_done, "resolved");

  assert.equal(flip(csv, 102, { status: "PENDING" }, 1000), true);
  assert.equal(readRows(csv).find((r) => r.testRunId === "102").rca_done, "pending-resume");
});

test("flip maps the output block's field names onto real columns", () => {
  seed(csv, "build-1", TESTS);
  flip(csv, 101, { rca_done: "resolved", thread_id: "chat:101", turn_id: "t-7" }, 1000);
  const row = readRows(csv).find((r) => r.testRunId === "101");
  assert.equal(row.threadId, "chat:101");
  assert.equal(row.turnId, "t-7");
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

test("csvPathFor: build id is in the filename, default dir is OS temp", () => {
  const p = csvPathFor("abc123XYZ");
  assert.ok(p.startsWith(join(tmpdir(), "bstack-rca")));
  assert.ok(p.endsWith("rca-state.abc123XYZ.csv"));
});

test("csvPathFor: different builds never share a path", () => {
  assert.notEqual(csvPathFor("build-A"), csvPathFor("build-B"));
});

test("csvPathFor: sanitizes hostile ids and handles empty", () => {
  assert.ok(csvPathFor("../../etc/passwd").endsWith("rca-state..._.._etc_passwd.csv"));
  assert.ok(csvPathFor("").endsWith("rca-state.unknown-build.csv"));
});

test("csvPathFor: stateDir override wins over temp", () => {
  const p = csvPathFor("b1", "/ci/artifacts");
  assert.equal(p, join("/ci/artifacts", "rca-state.b1.csv"));
});

// A foreign header must fail loudly, because writeRows only emits COLUMNS and
// would silently drop anything it didn't recognise. A real legacy 10-column
// file lost test_id and test_name this way while reporting success.
test("readRows refuses a foreign schema instead of silently dropping columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "rca-legacy-"));
  const p = join(dir, "legacy.csv");
  writeFileSync(p, "test_id,test_name,rca_done\nt1,login spec,pending\n", "utf8");

  assert.throws(() => readRows(p), /unrecognised column/i,
    "must name the problem rather than mangle the file");
  assert.throws(() => readRows(p), /test_id/, "must say WHICH columns");

  rmSync(dir, { recursive: true, force: true });
});

// Known legacy spellings are still accepted — the guard is for genuinely
// foreign schemas, not for every older name.
test("readRows maps aliased header names rather than rejecting them", () => {
  const dir = mkdtempSync(join(tmpdir(), "rca-alias-"));
  const p = join(dir, "aliased.csv");
  writeFileSync(p, "test_run_id,status,thread_id\n42,pending,th-1\n", "utf8");

  const rows = readRows(p);
  assert.equal(rows[0].testRunId, "42");
  assert.equal(rows[0].rca_done, "pending");
  assert.equal(rows[0].threadId, "th-1");

  rmSync(dir, { recursive: true, force: true });
});

// mkdirSync's `mode` applies on CREATE only, so a directory made before the
// hardening landed keeps 0755 forever — with root causes and culprit PRs in it.
test("writeRows tightens a pre-existing world-readable state dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "rca-perm-"));
  const loose = join(dir, "loose");
  mkdirSync(loose, { mode: 0o755 });
  chmodSync(loose, 0o755); // as an older version would have left it

  const csv = join(loose, "rca-state.b.csv");
  writeRows(csv, []);

  assert.equal(statSync(loose).mode & 0o777, 0o700, "existing dir must be tightened, not left open");
  assert.equal(statSync(csv).mode & 0o777, 0o600);

  rmSync(dir, { recursive: true, force: true });
});

// turnId only exists on a soft-PENDING turn, which is exactly the case that
// produces pending-resume. Without it the resume path submits blind onto a
// thread that still has a turn in flight — and the row looks healthy in the CSV.
test("flipping to pending-resume without a turnId warns loudly", () => {
  const dir = mkdtempSync(join(tmpdir(), "rca-resume-"));
  const csv = join(dir, "s.csv");
  seed(csv, "b", [{ test_id: 1, test_name: "t" }, { test_id: 2, test_name: "u" }]);

  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    flip(csv, 1, { rca_done: "pending-resume" }, 1000);
    flip(csv, 2, { rca_done: "pending-resume", turnId: "abc-123" }, 1000);
  } finally {
    console.warn = orig;
  }

  const noTurn = warnings.filter((w) => /NO turnId/.test(w));
  assert.equal(noTurn.length, 1, "exactly the seedless row must warn");
  assert.match(noTurn[0], /submit blind/);
  assert.equal(readRows(csv).find((r) => r.testRunId === "2").turnId, "abc-123");

  // Still resumable either way — warning, not rejection.
  assert.equal(readRows(csv).find((r) => r.testRunId === "1").rca_done, "pending-resume");

  rmSync(dir, { recursive: true, force: true });
});

// "A PRODUCT_BUG RCA without a culprit PR is incomplete" was a prompt-only rule.
// A stated "none — searched X" satisfies it; a blank field does not, and the two
// are indistinguishable in the CSV.
