// Interview planning is pure bookkeeping over an environment and an ASSIGNMENT, so
// every case replays from a literal. The assignment is the agent's judgement about
// what each tool is; this module only works out what is still owed and refuses an
// assignment the table cannot honour.
//
// Fixtures assert against the REAL shipped table, so a hint added to
// config/rca.config.json without a fixture shows up here as a changed route set
// rather than as silent behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchHint, planInterview, preFillFromConnectorSkills } from "../lib/discovery.mjs";
import { buildManifest, unavailableCapabilities } from "../lib/routing.mjs";
import { loadCapabilityTable } from "../lib/capability-table.mjs";
import { discoveryFixtures } from "./helpers/discovery-fixtures.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const config = JSON.parse(readFileSync(join(ROOT, "config/rca.config.json"), "utf8"));
const { table } = loadCapabilityTable(config);
const fixtures = discoveryFixtures();

const plan = (env, extra = {}) => planInterview({ table, env, ...extra });
const caps = (list) => list.map((x) => x.capability).sort();

test("fixtures cover every capability a route can resolve", () => {
  assert.ok(fixtures.length >= 6, "the fixture set must not shrink silently");
  const covered = new Set(fixtures.flatMap((fx) => fx.expect.available ?? []));
  assert.deepEqual([...covered].sort(), ["github", "infra", "logs", "metrics"],
    "`other` is always-asked and can never be resolved — asserted directly below");
});

for (const fx of fixtures) {
  test(`fixture ${fx.file}: ${fx.name}`, () => {
    const r = plan(fx.env, fx.assigned ? { assigned: fx.assigned } : {});
    const manifest = buildManifest(config, r.routes);

    assert.deepEqual(
      Object.entries(manifest).filter(([, v]) => v.available).map(([k]) => k).sort(),
      [...(fx.expect.available ?? [])].sort(),
      "available set",
    );
    assert.deepEqual(unavailableCapabilities(manifest).sort(), [...(fx.expect.unavailable ?? [])].sort(),
      "unavailable set");

    for (const [cap, via] of Object.entries(fx.expect.via ?? {})) {
      assert.equal(manifest[cap].via, via, `${cap} via`);
    }
    if (fx.expect.relevant) {
      assert.deepEqual(caps(r.relevant), [...fx.expect.relevant].sort(), "relevant set");
    }
    if (fx.expect.unassigned) {
      assert.deepEqual(r.unassigned.map((u) => u.name).sort(), [...fx.expect.unassigned].sort(), "unassigned set");
    }
    if (fx.expect.questions) {
      assert.deepEqual(r.questions.map((q) => `${q.capability}.${q.field}`), fx.expect.questions, "questions owed");
    }
    assert.deepEqual(r.violations, [], "a fixture must not produce violations");
  });
}

// ---- the agent's assignment is authoritative --------------------------------

test("an agent assignment beats a hint for the same capability", () => {
  // MUTATION: let `hint` win over `byAgent` and this fails. A workspace can hold a
  // familiar CLI and a better route the agent knows about; the hint must never
  // override the judgement.
  const env = { executables: ["kubectl"], mcpServers: [], repoFiles: [] };
  assert.equal(plan(env).routes.find((r) => r.capability === "infra").via, "kubectl");

  const assigned = { infra: { via: "mcp__acme__runtime", kind: "mcp", why: "kubectl points at a stale cluster" } };
  const infra = plan(env, { assigned }).routes.find((x) => x.capability === "infra");
  assert.equal(infra.via, "mcp__acme__runtime");
  assert.equal(infra.source, "agent");
  assert.equal(infra.why, "kubectl points at a stale cluster", "the reason is carried, so the gate can show it");
});

test("an assignment naming an unknown capability is refused, and says what to do", () => {
  const r = plan({ executables: [] }, { assigned: { featureflags: { via: "ldcli" } } });
  assert.deepEqual(r.violations.map((v) => v.code), ["assigned-unknown-capability"]);
  assert.match(r.violations[0].message, /capability it SERVES/);
});

test("an assignment with no route is refused", () => {
  const r = plan({ executables: [] }, { assigned: { logs: { kind: "mcp", why: "they use something" } } });
  assert.deepEqual(r.violations.map((v) => v.code), ["assigned-without-route"]);
});

test("an always-asked capability is never resolved, by assignment or by hint", () => {
  // `other` is the catch-all. Resolving it would swallow the unrecognised stack it
  // exists to surface.
  const r = plan({ executables: ["gh"] }, { assigned: { other: { via: "something", kind: "mcp" } } });
  assert.equal(r.routes.some((x) => x.capability === "other"), false);
  assert.equal(r.relevant.some((x) => x.capability === "other"), false);
});

// ---- hints are hints --------------------------------------------------------

test("an MCP hint matches one way only", () => {
  // Two-way containment made the hint "github" match a server named "hub" or "it",
  // reporting GitHub present on a machine with none — and then disagreeing with
  // verification, which used the one-way rule.
  for (const server of ["hub", "git", "it", "mcp", "lo"]) {
    assert.deepEqual(plan({ mcpServers: [server] }).routes, [], `'${server}' must satisfy no hint`);
  }
  for (const server of ["github-mcp", "mcp__github__get_repository", "claude_ai_GitHub"]) {
    assert.deepEqual(caps(plan({ mcpServers: [server] }).routes), ["github"], server);
  }
});

test("a file hint matches only on a path boundary", () => {
  const rel = (repoFiles) => caps(plan({ repoFiles }).relevant);
  assert.deepEqual(rel(["k8s/deployment.yaml"]), ["infra"]);
  assert.deepEqual(rel(["k8something/deployment.yaml"]), [], "not a directory that merely starts the same");
  assert.deepEqual(rel([".github/workflows/test.yml"]), ["github"]);
});

test("file evidence is relevance, never a route", () => {
  // A directory in the tree cannot prove this machine can reach anything. Counting
  // it as availability is what made discovery and verification disagree.
  const r = plan({ repoFiles: ["k8s/deployment.yaml", ".github/workflows/ci.yml"] });
  assert.deepEqual(r.routes, [], "no route from files alone");
  assert.deepEqual(caps(r.relevant), ["github", "infra"]);
  assert.ok(r.questions.some((q) => q.capability === "infra"),
    "but its questions ARE asked — a teammate who can reach it inherits the answer");
});

test("matchHint is a convenience and reports which kind it found", () => {
  assert.deepEqual(matchHint(table.github, { executables: ["gh"] }), { via: "gh", kind: "executable", name: "gh" });
  assert.equal(matchHint(table.infra, { repoFiles: ["helm/chart.yaml"] }).kind, "file");
  assert.equal(matchHint(table.logs, { executables: ["nope"] }), null);
});

// ---- questions --------------------------------------------------------------

test("every question names the consumer that reads its answer", () => {
  const r = plan({ executables: ["gh", "kubectl", "logcli", "promtool"] });
  assert.ok(r.questions.length > 0, "the fixture must produce questions, else it proves nothing");
  for (const q of r.questions) {
    assert.ok(typeof q.consumer === "string" && q.consumer.trim().length > 0,
      `${q.capability}.${q.field} has no consumer`);
  }
});

test("only the mandatory capability's questions are marked mandatory", () => {
  const r = plan({ executables: ["gh", "kubectl"] });
  assert.deepEqual([...new Set(r.questions.filter((q) => q.mandatory).map((q) => q.capability))], ["github"]);
});

test("a capability with no route and no relevance owes no questions", () => {
  const r = plan({ executables: ["gh"] });
  assert.equal(r.questions.some((q) => q.capability === "logs"), false,
    "asking for a log index on a machine with no log route wastes the human's time");
});

// ---- connector-skill pre-fill ------------------------------------------------

test("a connector skill fills only fields the table declares", () => {
  const { scopeByCapability, violations } = preFillFromConnectorSkills(table, [{
    name: "acme-github", path: "../.claude/skills/acme-github/SKILL.md", capability: "github",
    scope: { repos: ["acme/api"], baseBranch: "main", inventedField: "ignored" },
  }]);
  assert.deepEqual(Object.keys(scopeByCapability.github).sort(), ["baseBranch", "repos"]);
  assert.deepEqual(violations.map((v) => v.code), ["connector-undeclared-field"],
    "and the customer is told, rather than silently ignored");
});

test("a connector naming a capability the table does not define is reported", () => {
  const { violations } = preFillFromConnectorSkills(table, [{ name: "odd", capability: "featureflags", scope: {} }]);
  assert.deepEqual(violations.map((v) => v.code), ["connector-unknown-capability"]);
});

test("pre-filled scope removes the question it answers", () => {
  const env = { executables: ["gh"] };
  const before = plan(env).questions.filter((q) => q.capability === "github").map((q) => q.field);
  const after = plan(env, {
    connectorSkills: [{ name: "acme-github", capability: "github", scope: { repos: ["acme/api"] } }],
  }).questions.filter((q) => q.capability === "github").map((q) => q.field);
  assert.ok(before.includes("repos"));
  assert.ok(!after.includes("repos"));
});
