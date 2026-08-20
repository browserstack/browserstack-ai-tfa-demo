// The capability table IS the design, and this is the only test that loads the REAL
// config/rca.config.json — every other config-consuming test uses an inline stub, so
// without this the shipped schema would be guarded by nothing.
//
// The table DESCRIBES capabilities; it no longer instructs. There are no probe
// commands to validate here any more, which removed most of this file: a command
// string arriving as data needed a leader allowlist, an interpolation guard and a
// per-executable probe table, and produced an injection escape and a runtime-bias
// defect anyway. What remains is the structure the run depends on.
//
// Assertions here were checked by mutation. Where one guards something a customer
// can supply, the mutation is named in the test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OVERLAY_FORBIDDEN,
  RESOLVABLE,
  capabilitiesFromRouting,
  loadCapabilityTable,
  mergeOverlay,
  reportableUnavailable,
  validateTable,
} from "../lib/capability-table.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const SHIPPED = JSON.parse(readFileSync(join(ROOT, "config/rca.config.json"), "utf8"));
const realConfig = () => SHIPPED;

/** A minimal well-formed config: one routed capability, one conforming row. */
function stub({ routing, capabilities } = {}) {
  return {
    evidenceRouting: routing ?? {
      test_logs: { owner: "tfa", skip: true },
      product_code: { capability: "github" },
    },
    capabilities: capabilities ?? {
      github: {
        mandatory: true,
        resolvable: "partial",
        intent: "Read the product's code and its merged-PR history.",
        seedHints: { executables: ["gh"] },
        scopeFields: { repos: { consumer: "culprit-PR window" } },
      },
    },
  };
}

const codes = (violations) => [...new Set(violations.map((v) => v.code))].sort();

// ---- the shipped table ------------------------------------------------------

test("the shipped table validates with zero violations", () => {
  assert.deepEqual(loadCapabilityTable(realConfig()).violations, []);
});

test("the shipped table carries no probe commands at all", () => {
  // The property, not a spot check: a command string in a row is the design this
  // rewrite removed, and re-adding one silently would bring back the gate, the
  // interpolation guard and the injection surface with it.
  const forbidden = ["probe", "scopeProbe", "mcpProbe", "probesByExecutable", "fingerprints"];
  for (const [cap, row] of Object.entries(realConfig().capabilities)) {
    for (const key of forbidden) {
      assert.ok(!(key in row), `'${cap}' declares '${key}' — rows describe, they do not instruct`);
    }
  }
});

test("every discoverable capability states its intent", () => {
  // `intent` is what an agent reasons from when the customer's stack matches no
  // hint. Without it there is nothing to generalise from, which is how a fingerprint
  // list ends up telling a New Relic user to install promtool.
  for (const [cap, row] of Object.entries(realConfig().capabilities)) {
    if (row.resolvable !== "partial") continue;
    assert.ok(String(row.intent ?? "").trim().length > 40, `'${cap}' needs a real intent sentence`);
    assert.match(row.intent, /[Vv]erified means/, `'${cap}' intent must say what verified means`);
  }
});

test("every scope field names a downstream consumer", () => {
  // The check can only prove the string is non-empty, not that a consumer exists —
  // three fields once carried plausible-sounding consumers that nothing read. Each
  // consumer here names the step that reads it, so a reviewer can check it.
  for (const [cap, row] of Object.entries(realConfig().capabilities)) {
    for (const [field, spec] of Object.entries(row.scopeFields ?? {})) {
      assert.ok(String(spec?.consumer ?? "").trim(), `${cap}.${field} has no consumer`);
    }
  }
});

test("capabilities are derived from evidenceRouting, skipping what the manifest cannot hold", () => {
  // test_logs carries {owner:"tfa", skip:true} and no capability, so a naive
  // Object.values().map() yields undefined and reports a phantom unseeded capability.
  assert.deepEqual(capabilitiesFromRouting(realConfig()).sort(),
    ["github", "infra", "logs", "metrics", "other"]);
  assert.deepEqual(capabilitiesFromRouting({}), []);
  assert.deepEqual(capabilitiesFromRouting({ evidenceRouting: { x: { capability: "a", skip: true } } }), []);
});

// ---- structural validation --------------------------------------------------

test("a routed capability with no row is unseeded; a row with no route is an orphan", () => {
  const noRow = validateTable(stub({ routing: { product_code: { capability: "github" }, k8s: { capability: "infra" } } }));
  assert.ok(codes(noRow).includes("unseeded-capability"));

  const noRoute = validateTable(stub(), { ...stub().capabilities, ci: { resolvable: "partial" } });
  assert.ok(codes(noRoute).includes("orphan-row"));
});

test("resolvable must be one of the two real values", () => {
  const v = validateTable(stub(), {
    github: { mandatory: true, resolvable: "always", intent: "x. Verified means y.", scopeFields: {} },
  });
  assert.ok(codes(v).includes("bad-resolvable"));
  assert.deepEqual([...RESOLVABLE].sort(), ["always-asked", "partial"]);
});

test("exactly one capability is mandatory", () => {
  const none = validateTable(stub(), { github: { resolvable: "partial", intent: "a. Verified means b.", scopeFields: {} } });
  assert.ok(codes(none).includes("mandatory-count"));
});

test("an always-asked row declaring hints is a violation", () => {
  // Nothing consults hints for an always-asked row, so they would describe
  // behaviour that never happens.
  const v = validateTable(
    stub({ routing: { other: { capability: "other" } } }),
    { other: { mandatory: true, resolvable: "always-asked", seedHints: { executables: ["gh"] }, scopeFields: {} } },
  );
  assert.deepEqual(codes(v), ["always-asked-with-hints"]);
});

test("a malformed seedHint list is reported", () => {
  const v = validateTable(stub(), {
    github: {
      mandatory: true, resolvable: "partial", intent: "a. Verified means b.",
      seedHints: { executables: "gh", mcp: [""], files: ["ok"] }, scopeFields: {},
    },
  });
  assert.deepEqual(codes(v), ["bad-seed-hint"]);
  assert.equal(v.filter((x) => x.code === "bad-seed-hint").length, 2, "one per malformed list");
});

test("a discoverable row with no intent is reported", () => {
  const v = validateTable(stub(), {
    github: { mandatory: true, resolvable: "partial", seedHints: { executables: ["gh"] }, scopeFields: {} },
  });
  assert.deepEqual(codes(v), ["missing-intent"]);
});

test("a scope field with no consumer is reported", () => {
  const v = validateTable(stub(), {
    github: {
      mandatory: true, resolvable: "partial", intent: "a. Verified means b.",
      scopeFields: { repos: { consumer: "  " } },
    },
  });
  assert.deepEqual(codes(v), ["missing-consumer"]);
});

// ---- the overlay boundary ---------------------------------------------------

test("an overlay may seed hints and scope fields for a stack the table does not name", () => {
  // This is what makes the product generic without a code change. It is only safe
  // because a hint no longer authorises a command — there are no commands. The
  // route it produces still has to be verified by a reported check.
  const { table, violations } = mergeOverlay(realConfig().capabilities, {
    metrics: {
      seedHints: { mcp: ["newrelic", "dynatrace"] },
      scopeFields: { metricsAccount: { consumer: "scopes the pressure lookup in Step 4" } },
    },
  });
  assert.deepEqual(violations, []);
  assert.deepEqual(table.metrics.seedHints.mcp, ["newrelic", "dynatrace"]);
  assert.deepEqual(Object.keys(table.metrics.scopeFields).sort(), ["metricsAccount", "metricsNamespace"],
    "merged, not replaced");
});

test("an overlay cannot move the mandatory capability or flip resolvability", () => {
  // github.mandatory=false + infra.mandatory=true once produced ZERO violations —
  // the count still came to one, so the mandatory capability moved silently while
  // MANDATORY_CAPABILITY still said github.
  const { table, violations } = mergeOverlay(realConfig().capabilities, {
    github: { mandatory: false, resolvable: "always-asked" },
    infra: { mandatory: true },
  });
  assert.deepEqual(codes(violations), ["overlay-forbidden-field"]);
  assert.equal(table.github.mandatory, true, "the shipped value survives");
  assert.equal(table.github.resolvable, "partial");
  assert.equal(table.infra.mandatory, undefined);
});

test("an overlay cannot hide a missing capability from the gate", () => {
  // MUTATION: drop exemptFromDiscoveryReport from OVERLAY_FORBIDDEN and this fails.
  // A committed overlay setting it on infra, logs and metrics would suppress all
  // three from the one confirmation gate — the row deciding what is said about the
  // row, which is the same shape as the mandatory hole.
  const { table, violations } = mergeOverlay(realConfig().capabilities, {
    infra: { exemptFromDiscoveryReport: true },
    logs: { exemptFromDiscoveryReport: true },
  });
  assert.deepEqual(codes(violations), ["overlay-forbidden-field"]);
  assert.deepEqual(
    reportableUnavailable(["github", "infra", "logs", "metrics", "other"], table).sort(),
    ["github", "infra", "logs", "metrics"],
    "only the catch-all stays suppressed",
  );
});

test("an overlay cannot overwrite intent", () => {
  const { table, violations } = mergeOverlay(realConfig().capabilities, { logs: { intent: "whatever I say it is" } });
  assert.deepEqual(codes(violations), ["overlay-forbidden-field"]);
  assert.match(table.logs.intent, /application's own logs/);
});

test("OVERLAY_FORBIDDEN names exactly the fields the shipped table owns", () => {
  assert.deepEqual([...OVERLAY_FORBIDDEN].sort(),
    ["exemptFromDiscoveryReport", "intent", "mandatory", "resolvable"]);
});

test("a prototype key cannot smuggle a row past validation", () => {
  // `table[cap] = {...}` with cap === "__proto__" walks the prototype chain instead
  // of creating an own property: the row was reachable as table[cap] and via
  // `cap in table`, while Object.keys never listed it — so validateTable, which
  // iterates entries, never saw it.
  const hostile = JSON.parse('{"__proto__":{"ci":{"seedHints":{"executables":["curl"]}}}}');
  const { table, violations } = mergeOverlay({ github: { resolvable: "partial" } }, hostile);
  assert.deepEqual(codes(violations), ["overlay-unsafe-key"]);
  assert.equal("ci" in table, false, "the row must not be reachable by lookup");
  assert.equal(Object.getPrototypeOf(table), null, "the table is prototype-less by construction");

  for (const key of ["constructor", "prototype"]) {
    assert.deepEqual(codes(mergeOverlay({}, JSON.parse(`{"${key}":{"x":1}}`)).violations), ["overlay-unsafe-key"]);
  }
});

test("a prototype key inside a row is rejected too", () => {
  const { violations } = mergeOverlay({ logs: { resolvable: "partial" } },
    JSON.parse('{"logs":{"__proto__":{"polluted":true},"scopeFields":{}}}'));
  assert.ok(codes(violations).includes("overlay-unsafe-key"));
  assert.equal({}.polluted, undefined, "Object.prototype is untouched");
});

test("a malformed overlay row is named, not silently dropped", () => {
  const { violations } = mergeOverlay({ logs: {} }, { logs: "not an object" });
  assert.deepEqual(codes(violations), ["overlay-malformed-row"]);
});

test("validation runs on the merged table, not the shipped one alone", () => {
  // Validating only the shipped rows would treat customer data as pre-trusted.
  const { violations } = loadCapabilityTable(realConfig(), { logs: { scopeFields: { bogus: {} } } });
  assert.ok(codes(violations).includes("missing-consumer"),
    "a customer-supplied field with no consumer must still be caught");
});

// ---- reporting --------------------------------------------------------------

test("the catch-all is suppressed from the human-facing line only", () => {
  const { table } = loadCapabilityTable(realConfig());
  assert.deepEqual(reportableUnavailable(["infra", "logs", "other"], table), ["infra", "logs"]);
  assert.deepEqual(reportableUnavailable(["infra", "other"], {}), ["infra", "other"], "no table means no suppression");
});
