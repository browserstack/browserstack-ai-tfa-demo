import { test } from "node:test";
import assert from "node:assert/strict";
import { routeAsk, routeAsks, orderAsks, TEST_LOGS } from "../lib/routing.mjs";

const CONFIG = {
  evidenceRouting: {
    test_logs: { owner: "tfa", skip: true },
    product_code: { capability: "github", discoveryHints: ["github-mcp", "gh"] },
    k8s: { capability: "k8s", discoveryHints: [] },
    other: { capability: "other", discoveryHints: [] },
  },
};

test("test_logs is always skipped (TFA-owned)", () => {
  const r = routeAsk({ evidenceType: TEST_LOGS, priority: "high" }, CONFIG, {
    github: { available: true },
  });
  assert.equal(r.action, "skip");
  assert.equal(r.reason, "tfa-owned");
});

test("available capability → gather, carrying via", () => {
  const r = routeAsk({ evidenceType: "product_code", priority: "high" }, CONFIG, {
    github: { available: true, via: "github-mcp" },
  });
  assert.equal(r.action, "gather");
  assert.equal(r.capability, "github");
  assert.equal(r.via, "github-mcp");
});

test("unavailable capability → gap, carrying discovery hints", () => {
  const r = routeAsk({ evidenceType: "k8s", priority: "medium" }, CONFIG, {
    k8s: { available: false },
  });
  assert.equal(r.action, "gap");
  assert.equal(r.capability, "k8s");
  assert.equal(r.reason, "no-capability");
});

test("capability absent from manifest entirely → gap", () => {
  const r = routeAsk({ evidenceType: "k8s", priority: "low" }, CONFIG, {});
  assert.equal(r.action, "gap");
});

test("unknown evidenceType falls back to the 'other' entry", () => {
  const r = routeAsk({ evidenceType: "weird", priority: "low" }, CONFIG, {
    other: { available: true, via: "best-effort" },
  });
  assert.equal(r.action, "gather");
  assert.equal(r.capability, "other");
});

test("orderAsks sorts high → medium → low, unknown last", () => {
  const ordered = orderAsks([
    { what: "c", priority: "low" },
    { what: "a", priority: "high" },
    { what: "d", priority: undefined },
    { what: "b", priority: "medium" },
  ]);
  assert.deepEqual(
    ordered.map((a) => a.what),
    ["a", "b", "c", "d"],
  );
});

test("routeAsks buckets a mixed turn in priority order", () => {
  const buckets = routeAsks(
    [
      { evidenceType: "k8s", priority: "low" },
      { evidenceType: "test_logs", priority: "high" },
      { evidenceType: "product_code", priority: "high" },
    ],
    CONFIG,
    { github: { available: true, via: "gh" } },
  );
  assert.equal(buckets.skip.length, 1);
  assert.equal(buckets.gather.length, 1);
  assert.equal(buckets.gap.length, 1);
  assert.equal(buckets.gather[0].evidenceType, "product_code");
});
