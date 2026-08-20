// The capability table's correctness IS the design, so this is the first test in
// the repo that loads the REAL config/rca.config.json. Every other config-consuming
// test (routing, evidence, conformance, loop-*) defines its own inline stub, which
// means the shipped config has had zero schema coverage until now — a new block
// could break nothing and also be guarded by nothing.

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
import { isRunnable } from "../lib/tool-cache.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
// Parsed once. Every use here is read-only, and the tests that need to mutate a
// copy build their own via stub().
const SHIPPED = JSON.parse(readFileSync(join(ROOT, "config/rca.config.json"), "utf8"));
const realConfig = () => SHIPPED;

/** A minimal well-formed config: one routed capability, one conforming row. */
function stub({ routing, capabilities } = {}) {
  return {
    evidenceRouting: routing ?? {
      test_logs: { owner: "tfa", skip: true },
      product_code: { capability: "github", discoveryHints: ["gh"] },
    },
    capabilities: capabilities ?? {
      github: {
        mandatory: true,
        resolvable: "partial",
        fingerprints: { executables: ["gh"] },
        probe: "gh api repos/{repo}",
        scopeFields: { repos: { consumer: "culprit-PR window" } },
      },
    },
  };
}

const codes = (violations) => violations.map((v) => v.code).sort();

// ---- the real config -------------------------------------------------------

test("the shipped config's capability table validates with zero violations", () => {
  const { violations } = loadCapabilityTable(realConfig());
  assert.deepEqual(
    violations,
    [],
    `shipped table is invalid: ${violations.map((v) => v.message).join(" | ")}`,
  );
});

test("shipped table rows are exactly the capabilities evidenceRouting derives", () => {
  const config = realConfig();
  assert.deepEqual(
    Object.keys(config.capabilities).sort(),
    capabilitiesFromRouting(config).sort(),
    "a row with no routed capability is an orphan; a routed capability with no row is unseeded",
  );
});

test("every shipped row declares a permitted resolvable, and exactly one is mandatory", () => {
  const config = realConfig();
  const rows = Object.entries(config.capabilities);
  assert.ok(rows.length > 0, "fixture must have rows, else the test proves nothing");
  for (const [cap, row] of rows) {
    assert.ok(RESOLVABLE.has(row.resolvable), `${cap} has resolvable '${row.resolvable}'`);
  }
  const mandatory = rows.filter(([, r]) => r.mandatory === true).map(([c]) => c);
  assert.deepEqual(mandatory, ["github"], "GitHub is the only mandatory capability");
});

test("every shipped scope field names a downstream consumer", () => {
  for (const [cap, row] of Object.entries(realConfig().capabilities)) {
    for (const [name, spec] of Object.entries(row.scopeFields ?? {})) {
      assert.ok(
        typeof spec.consumer === "string" && spec.consumer.trim().length > 0,
        `${cap}.${name} has no consumer — a question whose answer nothing reads must not be asked`,
      );
    }
  }
});

// test_logs carries {owner, skip} and no capability key at all. A naive
// Object.values().map(e => e.capability) yields undefined and reports a phantom
// unseeded capability — which is exactly what the first draft of this check did.
test("test_logs contributes no capability, so it raises no unseeded violation", () => {
  const config = realConfig();
  assert.equal(config.evidenceRouting.test_logs.capability, undefined, "fixture assumption");
  assert.ok(!capabilitiesFromRouting(config).includes(undefined));
  const { violations } = loadCapabilityTable(config);
  assert.equal(violations.filter((v) => v.code === "unseeded-capability").length, 0);
});

// ---- probe shape -----------------------------------------------------------

test("docker ps validates on a docker-fingerprinted row — the case isRunnable refuses", () => {
  // The whole reason probes do not go through isRunnable: its ALLOWED_LEADER is
  // gh|kubectl|curl|git, so every non-Kubernetes infra probe would be unseedable.
  assert.equal(isRunnable("docker ps").ok, false, "fixture: isRunnable must refuse this");

  const violations = validateTable(
    stub({ routing: { infra: { capability: "infra" } } }),
    {
      infra: {
        mandatory: true,
        resolvable: "partial",
        fingerprints: { executables: ["docker"] },
        probe: "docker ps",
        scopeFields: {},
      },
    },
  );
  assert.deepEqual(codes(violations), []);
});

test("a row whose only route is MCP validates with mcpProbe and no CLI probe", () => {
  const violations = validateTable(
    stub({ routing: { kibana: { capability: "logs" } } }),
    {
      logs: {
        mandatory: true,
        resolvable: "partial",
        fingerprints: { mcp: ["loki"] },
        mcpProbe: { tool: "{logsMcpTool}", args: { index: "{logIndex}" } },
        scopeFields: { logIndex: { consumer: "log sweep target" } },
      },
    },
  );
  assert.deepEqual(codes(violations), []);
});

test("an always-asked row may omit fingerprints, probe, mcpProbe and scopeProbe", () => {
  const violations = validateTable(
    stub({ routing: { other: { capability: "other" } } }),
    { other: { mandatory: true, resolvable: "always-asked", scopeFields: {} } },
  );
  assert.deepEqual(codes(violations), []);
});

test("a partial row with no probe of either kind is reported", () => {
  const violations = validateTable(
    stub({ routing: { other: { capability: "other" } } }),
    {
      other: {
        mandatory: true,
        resolvable: "partial",
        fingerprints: { executables: ["gh"] },
        scopeFields: {},
      },
    },
  );
  assert.deepEqual(codes(violations), ["missing-probe"]);
});

test("a piped probe is rejected even though isRunnable accepts it", () => {
  // isRunnable allows pipelines into ALLOWED_FILTER, which includes python3.
  // That is a cacheability judgement, not a safety boundary.
  assert.equal(isRunnable("curl https://host/x | python3").ok, true, "fixture: isRunnable accepts this");

  const violations = validateTable(stub(), {
    github: {
      mandatory: true,
      resolvable: "partial",
      fingerprints: { executables: ["curl"] },
      probe: "curl https://host/x | python3",
      scopeFields: {},
    },
  });
  assert.deepEqual(codes(violations), ["bad-probe"]);
  assert.match(violations[0].message, /single command/);
});

test("a probe leader absent from its row's fingerprints is rejected", () => {
  const violations = validateTable(stub(), {
    github: {
      mandatory: true,
      resolvable: "partial",
      fingerprints: { executables: ["kubectl"] },
      probe: "gh api repos/{repo}",
      scopeFields: {},
    },
  });
  assert.deepEqual(codes(violations), ["bad-probe"]);
  assert.match(violations[0].message, /narrows the catalog/);
});

test("a fingerprint naming a shell or interpreter fails regardless of the rest of the row", () => {
  for (const shell of ["bash", "sh", "python3", "node", "perl", "ruby"]) {
    const violations = validateTable(stub(), {
      github: {
        mandatory: true,
        resolvable: "partial",
        fingerprints: { executables: [shell] },
        probe: `${shell} -c 'echo hi'`,
        scopeFields: {},
      },
    });
    assert.ok(
      violations.some((v) => v.code === "bad-fingerprint"),
      `${shell} must be refused as a declared fingerprint executable`,
    );
  }
});

test("an angle-bracket placeholder is rejected, with the redirect reason surfaced", () => {
  const violations = validateTable(stub(), {
    github: {
      mandatory: true,
      resolvable: "partial",
      fingerprints: { executables: ["gh"] },
      probe: "gh api repos/<repo>",
      scopeFields: {},
    },
  });
  assert.deepEqual(codes(violations), ["bad-probe"]);
  assert.match(violations[0].message, /redirect/);
});

test("an unquoted shell metacharacter is rejected even when it tokenizes as part of a word", () => {
  // Regression: `--base main; id` tokenizes as ["--base", "main;", "id"], so the
  // standalone-operator check never sees a `;` and accepted it. Not exploitable
  // (execFile, no shell) but the probe is silently wrong, and claiming operators
  // are rejected while accepting an attached one is a false guarantee.
  for (const bad of ["gh api repos/x; id", "gh api repos/x && id", "gh api repos/$(id)", "gh api repos/`id`"]) {
    const violations = validateTable(stub(), {
      github: {
        mandatory: true,
        resolvable: "partial",
        fingerprints: { executables: ["gh"] },
        probe: bad,
        scopeFields: {},
      },
    });
    assert.deepEqual(codes(violations), ["bad-probe"], `${bad} must be refused`);
    assert.match(violations[0].message, /metacharacter|redirect/);
  }
});

test("a quoted metacharacter is still allowed — quoting is respected", () => {
  const violations = validateTable(stub(), {
    github: {
      mandatory: true,
      resolvable: "partial",
      fingerprints: { executables: ["gh"] },
      probe: "gh pr list --search 'merged:2026-01-01..2026-02-01'",
      scopeFields: {},
    },
  });
  assert.deepEqual(codes(violations), []);
});

test("a malformed mcpProbe is reported", () => {
  const violations = validateTable(
    stub({ routing: { kibana: { capability: "logs" } } }),
    {
      logs: {
        mandatory: true,
        resolvable: "partial",
        fingerprints: { mcp: ["loki"] },
        mcpProbe: { tool: "", args: [] },
        scopeFields: {},
      },
    },
  );
  // Present-but-malformed is not the same as missing: the row DID declare a probe
  // form, so the two shape violations say exactly what is wrong and a generic
  // missing-probe on top would be noise.
  assert.deepEqual(codes(violations), ["bad-mcp-probe", "bad-mcp-probe"]);
  assert.deepEqual(
    violations.map((v) => v.field).sort(),
    ["mcpProbe.args", "mcpProbe.tool"],
  );
});

// ---- structural violations -------------------------------------------------

test("a row for a capability evidenceRouting does not route is an orphan", () => {
  // The literal mistake this catches: seeding a `ci` row. `ci` is an evidenceType
  // that routes to github, not a capability of its own.
  const config = stub();
  config.capabilities.ci = {
    resolvable: "partial",
    fingerprints: { executables: ["gh"] },
    probe: "gh api repos/{repo}",
    scopeFields: {},
  };
  const violations = validateTable(config, config.capabilities);
  assert.deepEqual(codes(violations), ["orphan-row"]);
  assert.match(violations[0].message, /evidenceType mistaken for a capability/);
});

test("a routed capability with no row is unseeded", () => {
  const config = stub();
  config.evidenceRouting.metrics = { capability: "metrics" };
  const violations = validateTable(config, config.capabilities);
  assert.deepEqual(codes(violations), ["unseeded-capability"]);
});

test("a scope field with no consumer is reported", () => {
  const violations = validateTable(stub(), {
    github: {
      mandatory: true,
      resolvable: "partial",
      fingerprints: { executables: ["gh"] },
      probe: "gh api repos/{repo}",
      scopeFields: { repos: { consumer: "  " } },
    },
  });
  assert.deepEqual(codes(violations), ["missing-consumer"]);
});

test("zero or several mandatory capabilities is reported", () => {
  const none = validateTable(stub(), {
    github: {
      resolvable: "always-asked",
      scopeFields: {},
    },
  });
  assert.deepEqual(codes(none), ["mandatory-count"]);
});

test("an always-asked row declaring fingerprints is a violation", () => {
  // discover() ignores fingerprints on an always-asked row, so declaring them
  // documents behaviour that never happens. Rejecting it at load time is what lets
  // the defensive branch in discover() guard a state the loader already refuses.
  const violations = validateTable(
    stub({ routing: { other: { capability: "other" } } }),
    {
      other: {
        mandatory: true,
        resolvable: "always-asked",
        fingerprints: { executables: ["gh"] },
        scopeFields: {},
      },
    },
  );
  assert.deepEqual(codes(violations), ["always-asked-with-fingerprints"]);
});

test("`always` is no longer a permitted resolvable", () => {
  assert.deepEqual([...RESOLVABLE].sort(), ["always-asked", "partial"]);
  const violations = validateTable(stub(), {
    github: { mandatory: true, resolvable: "always", fingerprints: { executables: ["gh"] }, probe: "gh api repos/{repo}", scopeFields: {} },
  });
  assert.ok(violations.some((v) => v.code === "bad-resolvable"));
});

test("exemptFromDiscoveryReport suppresses a capability from the human-facing line only", () => {
  // The flag had no reader at all: it sat in the config with a comment describing
  // behaviour no code implemented, which is the table's own missing-consumer rule
  // violated by the table itself.
  const table = realConfig().capabilities;
  const unavailable = ["infra", "logs", "other"];
  assert.deepEqual(reportableUnavailable(unavailable, table), ["infra", "logs"]);
  assert.ok(unavailable.includes("other"), "the manifest still marks it unavailable");
  assert.deepEqual(reportableUnavailable(unavailable, {}), unavailable, "no table means no suppression");
});

// ---- overlay ---------------------------------------------------------------

test("an overlay row merges scope data over the shipped row of the same name", () => {
  const shipped = {
    github: {
      mandatory: true,
      resolvable: "partial",
      fingerprints: { executables: ["gh"] },
      probe: "gh api repos/{repo}",
      scopeFields: { repos: { consumer: "culprit-PR window" } },
    },
  };
  const { table, violations } = mergeOverlay(shipped, {
    github: { scopeFields: { repos: { consumer: "culprit-PR window" }, subpaths: { consumer: "path overlap" } } },
  });
  assert.deepEqual(violations, []);
  assert.deepEqual(Object.keys(table.github.scopeFields).sort(), ["repos", "subpaths"]);
  assert.equal(table.github.probe, "gh api repos/{repo}", "shipped probe survives the merge");
  assert.deepEqual(shipped.github.scopeFields, { repos: { consumer: "culprit-PR window" } }, "shipped table not mutated");
});

test("an overlay may not set fingerprints or any probe field, and each is named", () => {
  // Without this the probe-shape restriction is self-certifying: the leader
  // allowlist would come from the same customer-controlled row as the probe.
  for (const field of OVERLAY_FORBIDDEN) {
    const { table, violations } = mergeOverlay(
      { github: { resolvable: "partial", fingerprints: { executables: ["gh"] }, probe: "gh api repos/{repo}" } },
      { github: { [field]: field === "mcpProbe" ? { tool: "x" } : ["bash"] } },
    );
    assert.deepEqual(codes(violations), ["overlay-forbidden-field"], `${field} must be refused`);
    assert.equal(violations[0].field, field, "the violation names the offending field");
    assert.deepEqual(
      table.github.fingerprints,
      { executables: ["gh"] },
      "the shipped value survives — the overlay key is dropped, not applied",
    );
  }
});

test("validation runs on the merged table, not the shipped table alone", () => {
  // A shipped table that is valid on its own must not launder an invalid overlay.
  const config = stub();
  const { table, violations: mergeViolations } = mergeOverlay(config.capabilities, {
    github: { scopeFields: { subpaths: {} } },
  });
  assert.deepEqual(mergeViolations, [], "the overlay touches only permitted fields");
  assert.deepEqual(validateTable(config, config.capabilities), [], "shipped alone is valid");
  assert.deepEqual(
    codes(validateTable(config, table)),
    ["missing-consumer"],
    "the overlay's consumer-less field is caught post-merge",
  );
});

test("loadCapabilityTable reports merge and validation violations together", () => {
  const config = stub();
  const { violations } = loadCapabilityTable(config, {
    github: { probe: "bash -c 'x'", scopeFields: { subpaths: {} } },
  });
  assert.deepEqual(codes(violations), ["missing-consumer", "overlay-forbidden-field"]);
});
