import { test } from "node:test";
import assert from "node:assert/strict";
import {
  routeAsk, routeAsks, orderAsks, buildManifest, unavailableCapabilities, TEST_LOGS,
} from "../lib/routing.mjs";

const CONFIG = {
  evidenceRouting: {
    test_logs: { owner: "tfa", skip: true },
    product_code: { capability: "github" },
    ci: { capability: "ci", fallbackCapability: "github" },
    infra: { capability: "infra" },
    k8s: { capability: "infra" },
    other: { capability: "other" },
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

test("unavailable capability → gap", () => {
  const r = routeAsk({ evidenceType: "k8s", priority: "medium" }, CONFIG, {
    infra: { available: false },
  });
  assert.equal(r.action, "gap");
  assert.equal(r.capability, "infra");
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

// ---- fallbackCapability -----------------------------------------------------
//
// `ci` is its own capability because a team's CI system is often not their git
// forge. Flipping it off `github` without a fallback silently turned every ci ask
// into a gap for the many teams where CI *is* the forge — and made
// unavailableCapabilities declare `ci` missing to TFA while nothing was wrong.
// Resolved in buildManifest, not routeAsk, so both readers agree.

test("a capability with no connector of its own is served by its fallback", () => {
  // MUTATION: delete the second pass in buildManifest -> this fails.
  const m = buildManifest(CONFIG, [{ capability: "github", via: "gh" }]);
  assert.deepEqual(m.ci, { available: true, via: "gh", viaFallback: "github" });
  assert.equal(routeAsk({ evidenceType: "ci" }, CONFIG, m).action, "gather");
});

test("and it is NOT declared unavailable while the fallback serves it", () => {
  // The half of the regression a routeAsk-level fallback would have missed.
  const m = buildManifest(CONFIG, [{ capability: "github", via: "gh" }]);
  assert.ok(!unavailableCapabilities(m).includes("ci"));
});

test("a real connector of its own beats the fallback", () => {
  const m = buildManifest(CONFIG, [
    { capability: "github", via: "gh" },
    { capability: "ci", via: "pipeline-mcp" },
  ]);
  assert.deepEqual(m.ci, { available: true, via: "pipeline-mcp" });
});

test("with neither present it is an honest gap", () => {
  const m = buildManifest(CONFIG, []);
  assert.equal(m.ci.available, false);
  assert.equal(routeAsk({ evidenceType: "ci" }, CONFIG, m).action, "gap");
  assert.ok(unavailableCapabilities(m).includes("ci"));
});

test("a fallback never leaks into an unrelated capability", () => {
  const m = buildManifest(CONFIG, [{ capability: "github", via: "gh" }]);
  for (const cap of ["infra", "other"]) {
    assert.equal(m[cap].available, false, `${cap} must not inherit github's connector`);
  }
});

test("a fallback resolves from discovered connectors only, so it cannot chain", () => {
  // b falls back to a, c falls back to b. Only `a` is discovered, so `b` is served
  // and `c` is NOT — a fallback target is looked up in `discovered`, never in the
  // manifest being built, which is what makes a single hop structural.
  //
  // MUTATION: look the target up in `manifest` instead of `byCap` -> c becomes
  // available and this fails.
  const config = { evidenceRouting: {
    ra: { capability: "a" }, rb: { capability: "b", fallbackCapability: "a" },
    rc: { capability: "c", fallbackCapability: "b" },
  } };
  const m = buildManifest(config, [{ capability: "a", via: "tool-a" }]);
  assert.equal(m.b.available, true, "one hop resolves");
  assert.equal(m.c.available, false, "two hops must not");
});

test("gap payloads no longer carry a vendor hint list", () => {
  // discoveryHints was produced here and read by nothing but this file, so it
  // taught a default while informing no decision.
  const r = routeAsk({ evidenceType: "k8s" }, CONFIG, { infra: { available: false } });
  assert.ok(!("discoveryHints" in r));
});
