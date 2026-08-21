import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  turn1PathFor,
  initTurn1Registry,
  recordTurn1,
  readTurn1,
  readAllTurn1,
} from "../lib/turn1-registry.mjs";

const mode = (p) => statSync(p).mode & 0o777;

function fixture() {
  return mkdtempSync(join(tmpdir(), "rca-t1-"));
}

test("turn1PathFor keys the file by buildId under the given stateDir", () => {
  const dir = fixture();
  const p = turn1PathFor("build-123", dir);
  assert.equal(p, join(dir, "rca-turn1.build-123.json"));
  rmSync(dir, { recursive: true, force: true });
});

test("readTurn1 on a non-existent registry returns null, not a throw", () => {
  const dir = fixture();
  const p = turn1PathFor("b1", dir);
  assert.equal(readTurn1(p, "3900000001"), null);
  rmSync(dir, { recursive: true, force: true });
});

test("initTurn1Registry creates the file and is idempotent (never clobbers prior entries)", () => {
  const dir = fixture();
  const p = turn1PathFor("b1", dir);
  initTurn1Registry(p, "b1", 1000);
  assert.ok(existsSync(p));

  recordTurn1(p, "3900000001", { status: "NEEDS_INFO", threadId: "chat:1", asks: ["a"] }, 2000);
  // Re-init after entries exist must leave them untouched.
  initTurn1Registry(p, "b1", 3000);
  assert.deepEqual(readTurn1(p, "3900000001").asks, ["a"]);

  rmSync(dir, { recursive: true, force: true });
});

test("recordTurn1 + readTurn1 round-trip a PENDING entry", () => {
  const dir = fixture();
  const p = turn1PathFor("b1", dir);
  recordTurn1(p, "3900000002", { status: "PENDING", threadId: "chat:2", turnId: "t-2" }, 5000);

  const entry = readTurn1(p, "3900000002");
  assert.equal(entry.status, "PENDING");
  assert.equal(entry.threadId, "chat:2");
  assert.equal(entry.turnId, "t-2");
  assert.equal(entry.submittedAtMs, 5000);

  rmSync(dir, { recursive: true, force: true });
});

test("recordTurn1 + readTurn1 round-trip a NEEDS_INFO entry", () => {
  const dir = fixture();
  const p = turn1PathFor("b1", dir);
  recordTurn1(
    p,
    "3900000003",
    { status: "NEEDS_INFO", threadId: "chat:3", asks: [{ evidenceType: "product_code" }] },
    6000,
  );

  const entry = readTurn1(p, "3900000003");
  assert.equal(entry.status, "NEEDS_INFO");
  assert.equal(entry.threadId, "chat:3");
  assert.deepEqual(entry.asks, [{ evidenceType: "product_code" }]);
  assert.equal(entry.turnId, undefined, "NEEDS_INFO never carries a turnId");

  rmSync(dir, { recursive: true, force: true });
});

test("readAllTurn1 returns every recorded entry keyed by testRunId", () => {
  const dir = fixture();
  const p = turn1PathFor("b1", dir);
  recordTurn1(p, "1", { status: "PENDING", threadId: "chat:1", turnId: "t-1" }, 1000);
  recordTurn1(p, "2", { status: "NEEDS_INFO", threadId: "chat:2", asks: [] }, 2000);

  const all = readAllTurn1(p);
  assert.deepEqual(Object.keys(all).sort(), ["1", "2"]);
  assert.equal(all["1"].status, "PENDING");
  assert.equal(all["2"].status, "NEEDS_INFO");

  rmSync(dir, { recursive: true, force: true });
});

test("recordTurn1 for a second testRunId does not clobber the first", () => {
  const dir = fixture();
  const p = turn1PathFor("b1", dir);
  recordTurn1(p, "1", { status: "PENDING", threadId: "chat:1", turnId: "t-1" }, 1000);
  recordTurn1(p, "2", { status: "PENDING", threadId: "chat:2", turnId: "t-2" }, 2000);

  assert.equal(readTurn1(p, "1").threadId, "chat:1");
  assert.equal(readTurn1(p, "2").threadId, "chat:2");

  rmSync(dir, { recursive: true, force: true });
});

test("the registry file and its directory are owner-only (0600 / 0700)", () => {
  const dir = fixture();
  const p = turn1PathFor("b1", dir);
  recordTurn1(p, "1", { status: "PENDING", threadId: "chat:1", turnId: "t-1" }, 1000);

  assert.equal(mode(p), 0o600);

  rmSync(dir, { recursive: true, force: true });
});

