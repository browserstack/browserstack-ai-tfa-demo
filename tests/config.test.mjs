// The SHIPPED config, tested.
//
// This file exists because of a near-miss. `config/rca.config.json` was loaded by
// no test at all, so a change to `evidenceRouting.ci` — flipping it from the
// `github` capability to its own — would have silently turned every `ci` evidence
// ask into a gap for any team whose CI system *is* their git forge, and made
// `unavailableCapabilities` declare `ci` missing to TFA on turn one. `npm test`
// would have stayed green the whole way.
//
// Fixture tests in tests/routing.test.mjs prove the routing LOGIC. Only this file
// proves the logic is wired to the config we actually ship. Both are needed: a
// fixture cannot notice that the real file disagrees with it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildManifest, routeAsk, unavailableCapabilities } from "../lib/routing.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const config = JSON.parse(readFileSync(join(ROOT, "config/rca.config.json"), "utf8"));

/** `$`-prefixed keys are prose comments, not data. */
const real = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !k.startsWith("$")));
const routes = real(config.evidenceRouting);
const gathered = Object.entries(routes).filter(([, e]) => !e.skip && e.owner !== "tfa");
const capabilities = new Set(gathered.map(([, e]) => e.capability));

test("every gathered evidence type names a capability", () => {
  // An entry with no capability routes to `other` by accident rather than by
  // decision, which reads as a phantom missing connector every run.
  for (const [type, entry] of gathered) {
    assert.ok(entry.capability, `evidenceRouting.${type} has no capability`);
  }
});

test("every fallbackCapability points at a capability that exists", () => {
  // A fallback naming a capability nothing declares can never resolve, so the
  // entry would look protected and be a permanent gap.
  for (const [type, entry] of gathered) {
    if (!entry.fallbackCapability) continue;
    assert.ok(
      capabilities.has(entry.fallbackCapability),
      `evidenceRouting.${type} falls back to '${entry.fallbackCapability}', which no entry declares`,
    );
  }
});

test("a team whose CI is their git forge still gathers ci evidence", () => {
  // THE regression this file was written for, asserted against the real config
  // rather than a fixture. `ci` became its own capability because a team's CI
  // system frequently is not their forge — but for the many teams where it is,
  // that flip must not cost them ci evidence.
  const manifest = buildManifest(config, [{ capability: "github", via: "gh" }]);
  const routed = routeAsk({ evidenceType: "ci" }, config, manifest);

  assert.equal(routed.action, "gather", "a ci ask must not degrade to a gap");
  assert.equal(manifest.ci.viaFallback, "github", "and it must be served by the forge");
  assert.ok(
    !unavailableCapabilities(manifest).includes("ci"),
    "and ci must not be declared missing to TFA while the fallback serves it",
  );
});

test("a distinct CI connector is preferred over the fallback", () => {
  const manifest = buildManifest(config, [
    { capability: "github", via: "gh" },
    { capability: "ci", via: "some-pipeline-tool" },
  ]);
  assert.equal(manifest.ci.via, "some-pipeline-tool");
  assert.equal(manifest.ci.viaFallback, undefined);
});

test("the manifest covers every declared capability and nothing TFA owns", () => {
  const manifest = buildManifest(config, []);
  assert.deepEqual(Object.keys(manifest).sort(), [...capabilities].sort());
  assert.ok(!("test_logs" in manifest), "TFA owns test logs; the client never gathers them");
});

test("no evidence-routing entry carries a hint list", () => {
  // The property, not a spot check. `discoveryHints` shipped here as a list of
  // vendor names, was copied into routeAsk's gap payload, and was read by nothing
  // but routeAsk's own test — so it taught a default while informing no decision.
  // It is re-addable in one commit and looked reasonable at the time, which is why
  // this is asserted rather than remembered.
  for (const key of ["discoveryHints", "fingerprints", "seedHints", "probe", "executables"]) {
    for (const [type, entry] of Object.entries(routes)) {
      assert.ok(!(key in entry), `evidenceRouting.${type} declares '${key}'`);
    }
  }
});

test("no capability or fallback name is a product name", () => {
  // `k8s` and `kibana` survive as evidenceType KEYS only: those are the sender's
  // wire vocabulary, which we do not control. Our own capability names must stay
  // neutral, or the schema picks a winner the way `kubectlSweep` once did.
  const ours = [...capabilities, ...gathered.map(([, e]) => e.fallbackCapability).filter(Boolean)];
  for (const vendor of ["kubectl", "k8s", "kubernetes", "docker", "ecs", "nomad", "pm2",
                        "kibana", "prometheus", "grafana", "datadog", "splunk", "newrelic"]) {
    for (const name of ours) {
      assert.notEqual(name.toLowerCase(), vendor, `capability '${name}' is a product name`);
    }
  }
});

test("the context block is present and sane", () => {
  // staleAfterDays only relabels a digest line, so a wrong value is quiet: zero or
  // negative would mark every connector stale on the day it was verified.
  assert.ok(config.context, "config.context is required — lib/rca-context.mjs reads it");
  const days = config.context.staleAfterDays;
  assert.ok(Number.isInteger(days) && days > 0, `staleAfterDays must be a positive integer, got ${days}`);
});
