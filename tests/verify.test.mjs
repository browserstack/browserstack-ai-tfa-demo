// Verification is now a POLICY over what the agent reports, so this suite tests the
// contract, not a probe table. Three properties carry the weight:
//
//   1. A claim needs evidence. A target reported ok with no named check is
//      normalised to `unverified`. This replaces a whole class of defect: a
//      capability probe used to be substituted for a scope probe, so
//      `promtool --version` reported a metrics namespace verified without reading it.
//   2. Nothing credential-shaped and no raw provider output survives into the
//      result, because the artifact is committed and a leak there is permanent.
//   3. GitHub is binary, and its refusal is a sentence a human can act on.
//
// Every assertion below was checked by MUTATION: break the code it guards, confirm
// the test fails, restore. Four guards in this repo were previously vacuous, so
// "it passes" is not evidence that it can fail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCESS_LEVEL,
  GAP_CLASS,
  MANDATORY_CAPABILITY,
  PR_WINDOW_DAYS,
  UNVERIFIED,
  githubGate,
  looksLikeSecret,
  overBroadWarning,
  prWindowWarning,
  validateVerification,
} from "../lib/verify.mjs";
import { redact } from "../lib/tool-cache.mjs";
import { loadCapabilityTable } from "../lib/capability-table.mjs";
import { FAKE, EMBEDDED, BENIGN } from "./helpers/fake-credentials.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const config = JSON.parse(readFileSync(join(ROOT, "config/rca.config.json"), "utf8"));
const { table } = loadCapabilityTable(config);

const ok = (field, value, checkedBy) => ({ field, value, ok: true, checkedBy });
const codes = (violations) => [...new Set(violations.map((v) => v.code))].sort();

// ---- a claim needs evidence --------------------------------------------------

test("a target reported ok without naming a check is downgraded, not accepted", () => {
  // MUTATION: delete the `!String(t?.checkedBy ?? "").trim()` branch in runOne's
  // successor and this fails on both assertions.
  const r = validateVerification({
    capability: "metrics",
    row: table.metrics,
    result: { verified: true, via: "promtool", targets: [{ field: "metricsNamespace", value: "anything", ok: true }] },
  });
  assert.equal(r.result.targets[0].state, UNVERIFIED);
  assert.equal(r.result.targets[0].ok, false);
  assert.equal(r.result.verified, false, "a capability with no checked target is not verified");
  assert.deepEqual(codes(r.violations), ["unsupported-claim", "verified-without-a-checked-target"]);
});

test("a target that names its check is accepted", () => {
  const r = validateVerification({
    capability: "metrics",
    row: table.metrics,
    result: {
      verified: true,
      via: "mcp__newrelic__nrql_query",
      targets: [ok("metricsNamespace", "prod", "nrql: SELECT count(*) FROM Metric WHERE ns='prod' → 1 row")],
    },
  });
  assert.equal(r.result.verified, true);
  assert.equal(r.result.targets[0].state, "verified");
  assert.deepEqual(r.violations, []);
});

test("a capability nothing in the shipped table names still verifies", () => {
  // The whole point of the rewrite. No seedHint matches New Relic, Coralogix or
  // Dynatrace; the agent says what it checked and the policy accepts it. Before
  // this, such a customer was told "Install promtool on this machine".
  for (const [capability, via, field, value] of [
    ["metrics", "mcp__dynatrace__metrics", "metricsNamespace", "prod-eu"],
    ["logs", "mcp__coralogix__query", "logIndex", "app-prod"],
    ["infra", "flyctl", "namespace", "prod"],
  ]) {
    const r = validateVerification({
      capability,
      row: table[capability],
      result: { verified: true, via, targets: [ok(field, value, `${via} returned 1 result for ${value}`)] },
    });
    assert.equal(r.result.verified, true, `${capability} via ${via}`);
    assert.deepEqual(r.violations, [], `${capability}: ${JSON.stringify(r.violations)}`);
  }
});

test("a verified capability must say what it was reached through", () => {
  const r = validateVerification({
    capability: "logs",
    row: table.logs,
    result: { verified: true, targets: [ok("logIndex", "app", "queried it")] },
  });
  assert.ok(codes(r.violations).includes("via-missing"));
});

test("a target naming a field the row does not declare is reported", () => {
  // The table is the question list. An answer nothing reads must not be collected.
  const r = validateVerification({
    capability: "logs",
    row: table.logs,
    result: { verified: true, via: "x", targets: [ok("clusterName", "c1", "checked")] },
  });
  assert.ok(codes(r.violations).includes("undeclared-target-field"));
});

test("no targets at all is a violation, not a quiet pass", () => {
  const r = validateVerification({ capability: "logs", row: table.logs, result: { verified: true, via: "x" } });
  assert.equal(r.result.verified, false);
  assert.ok(codes(r.violations).includes("targets-missing"));
});

// ---- failures must be actionable --------------------------------------------

test("a failing target needs a known gap class and a next action", () => {
  const bad = validateVerification({
    capability: "infra",
    row: table.infra,
    result: {
      verified: false,
      via: "kubectl",
      targets: [
        { field: "namespace", value: "nope", ok: false, gap: { class: "made-up", nextAction: "do a thing" } },
        { field: "workloads", value: "w", ok: false, gap: { class: GAP_CLASS.SCOPE_INVALID, nextAction: "  " } },
        { field: "runtimeKind", value: "k8s", ok: false },
      ],
    },
  });
  assert.deepEqual(codes(bad.violations), ["bad-gap-class", "failure-without-gap", "gap-without-next-action"]);
});

test("a well-formed failure passes and keeps its gap", () => {
  const r = validateVerification({
    capability: "infra",
    row: table.infra,
    result: {
      verified: false,
      via: "kubectl",
      targets: [{
        field: "namespace",
        value: "nope",
        ok: false,
        gap: { class: GAP_CLASS.SCOPE_INVALID, nextAction: "Confirm the namespace, then re-run setup." },
      }],
    },
  });
  assert.deepEqual(r.violations, []);
  assert.equal(r.result.targets[0].state, "failed");
  assert.equal(r.result.targets[0].gap.class, GAP_CLASS.SCOPE_INVALID);
});

test("a target the agent could not prove is a first-class state, not a failure", () => {
  const r = validateVerification({
    capability: "infra",
    row: table.infra,
    result: {
      verified: true,
      via: "flyctl",
      targets: [
        ok("runtimeKind", "fly", "flyctl status returned the app"),
        { field: "namespace", value: "prod", ok: false, state: UNVERIFIED },
      ],
    },
  });
  assert.deepEqual(r.violations, [], "unverified needs no gap — nothing is wrong, we just have no proof");
  assert.equal(r.result.verified, true, "one checked target still verifies the capability");
  assert.equal(r.result.targets[1].state, UNVERIFIED);
});

// ---- nothing sensitive survives ---------------------------------------------

test("raw provider output is refused wherever it appears", () => {
  // MUTATION: empty RAW_OUTPUT_KEYS and this fails.
  const r = validateVerification({
    capability: "logs",
    row: table.logs,
    result: {
      verified: false,
      via: "x",
      targets: [{ field: "logIndex", value: "a", ok: false, raw: "HTTP 403 ...", gap: { class: GAP_CLASS.CREDENTIAL_UNDER_SCOPED, nextAction: "widen" } }],
      stderr: "traceback ...",
    },
  });
  const fields = r.violations.filter((v) => v.code === "raw-output-in-result").map((v) => v.field).sort();
  assert.deepEqual(fields, ["stderr", "targets[0].raw"]);
});

test("a credential anywhere in a reported result is refused, and located", () => {
  const r = validateVerification({
    capability: "github",
    row: table.github,
    result: { verified: true, via: "gh", targets: [ok("repos", "acme/api", `authed with ${FAKE.githubPat}`)] },
  });
  const v = r.violations.find((x) => x.code === "secret-in-result");
  assert.ok(v, "must be caught");
  assert.equal(v.field, "targets[0].checkedBy", "names WHERE");
  assert.ok(!v.message.includes(FAKE.githubPat), "and never echoes the value");
});

test("looksLikeSecret is never weaker than redact", () => {
  for (const c of Object.values(EMBEDDED)) {
    if (redact(c) === c) continue;
    assert.equal(looksLikeSecret(c).secret, true, `redact flags this and we must too: ${c}`);
  }
  assert.equal(redact(EMBEDDED.urlUserinfo), EMBEDDED.urlUserinfo, "precondition: redact misses this one");
  assert.equal(looksLikeSecret(EMBEDDED.urlUserinfo).secret, true);
});

test("a credential is caught mid-string, not only at position 0", () => {
  // The url-userinfo shape was `^`-anchored while the other two were not, so
  // `LOKI_URL=https://u:p@host` passed and redact missed it too.
  for (const prefix of ["", "endpoint ", "LOKI_URL=", 'url="']) {
    assert.equal(
      looksLikeSecret(prefix + EMBEDDED.urlUserinfo).secret,
      true,
      `must be caught behind ${JSON.stringify(prefix)}`,
    );
  }
});

test("a bare token is caught whether it stands alone or sits in a sentence", () => {
  assert.equal(looksLikeSecret(FAKE.githubPat).secret, true);
  assert.equal(looksLikeSecret(`the token is ${FAKE.githubPat} — rotate it`).secret, true);
});

test("the library's own prose is not a credential", () => {
  // This was the blocker: the entropy fallback (>=32 chars, mixed case, a digit)
  // matched prWindowWarning's message and every gap next action, so
  // writeRcaContext refused any context carrying a gap and told the customer to
  // rotate a credential that never existed.
  const prose = [
    prWindowWarning({ mergedCount: 0, branch: "main" }).message,
    "'prod-2' was not found. Check the value and re-run setup.",
    "Install the runtime CLI on this machine, then re-run setup.",
    overBroadWarning(MANDATORY_CAPABILITY, ["admin:org"]).message,
  ];
  for (const p of prose) {
    assert.equal(looksLikeSecret(p).secret, false, `library prose must not be flagged: ${p}`);
  }
});

test("real answers are never flagged", () => {
  for (const b of BENIGN) assert.equal(looksLikeSecret(b).secret, false, b);
  assert.equal(looksLikeSecret(FAKE.gitSha).secret, false, "a 40-char hex SHA is legitimate here");
});

// ---- GitHub is binary -------------------------------------------------------

test("an unresolved GitHub scope refuses with a sentence, never 'undefined'", () => {
  const g = githubGate({ capability: MANDATORY_CAPABILITY, verified: false, targets: [] });
  assert.equal(g.blocking, true);
  assert.doesNotMatch(g.message, /undefined/);
  assert.match(g.nextAction, /repository and base branch/);
});

test("a failed GitHub target's own next action is the one surfaced", () => {
  const g = githubGate({
    capability: MANDATORY_CAPABILITY,
    verified: false,
    targets: [{
      field: "repos", value: "acme/ghost", state: "failed",
      gap: { class: GAP_CLASS.SCOPE_INVALID, nextAction: "Confirm 'acme/ghost' exists and you can read it." },
    }],
  });
  assert.equal(g.blocking, true);
  assert.match(g.message, /acme\/ghost/);
  assert.match(g.nextAction, /Confirm 'acme\/ghost'/);
});

test("an unproven GitHub target blocks and says so distinctly", () => {
  const g = githubGate({
    capability: MANDATORY_CAPABILITY,
    verified: false,
    targets: [{ field: "baseBranch", value: "main", state: UNVERIFIED }],
  });
  assert.equal(g.blocking, true);
  assert.match(g.message, /could not be proven/);
});

test("no other capability blocks", () => {
  for (const capability of ["infra", "logs", "metrics", "other"]) {
    assert.equal(githubGate({ capability, verified: false, targets: [] }).blocking, false, capability);
  }
});

// ---- scopes and warnings ----------------------------------------------------

test("over-broad scopes are reported for GitHub and nobody else", () => {
  // The scope vocabulary is GitHub's. It was applied to every capability, so an
  // unrelated provider's scope strings were measured against `write:org`.
  assert.ok(overBroadWarning(MANDATORY_CAPABILITY, ["repo", "admin:org"]).scopes.includes("admin:org"));
  assert.equal(overBroadWarning("logs", ["write"]), null);
  assert.equal(overBroadWarning(MANDATORY_CAPABILITY, ["repo:status"]), null);
});

test("reported scopes become the access level; absence is its own state", () => {
  const withScopes = validateVerification({
    capability: "github", row: table.github,
    result: { verified: true, via: "gh", scopes: ["repo"], targets: [ok("repos", "a/b", "gh api")] },
  });
  assert.equal(withScopes.result.accessLevel.state, ACCESS_LEVEL.REPORTED);

  const without = validateVerification({
    capability: "github", row: table.github,
    result: { verified: true, via: "mcp__github__get_repository", targets: [ok("repos", "a/b", "mcp read")] },
  });
  assert.equal(without.result.accessLevel.state, ACCESS_LEVEL.NOT_REPORTABLE,
    "an MCP server that does not surface scopes is not 'narrow' and not 'broad'");
});

test("an empty PR window warns, persists, and names the branch it checked", () => {
  const w = prWindowWarning({ mergedCount: 0, branch: "release/2026-08" });
  assert.equal(w.code, "empty-pr-window");
  assert.equal(w.persist, true);
  assert.equal(w.windowDays, PR_WINDOW_DAYS);
  assert.match(w.message, /release\/2026-08/);
  assert.equal(prWindowWarning({ mergedCount: 3, branch: "main" }), null);
});

// ---- the mandatory gate needs COVERAGE, not one lucky target ----------------

test("GitHub with a verified repo and a FAILED base branch does not pass the gate", () => {
  // `verified` is an OR over targets, so this returned verified:true with zero
  // violations and the gate waved it through — sending the run to its single
  // deliverable, the culprit-PR hunt over that branch, with the branch proven
  // unreachable and nothing said about it. The row's own intent says "a repository
  // is readable AND the base branch's merged-PR list can be listed".
  //
  // MUTATION: drop the `uncovered` check in githubGate and this fails.
  const row = table.github;
  const { result } = validateVerification({
    capability: "github",
    row,
    result: {
      verified: true,
      via: "gh",
      targets: [
        ok("repos", "acme/api", "gh api repos/acme/api -> 200"),
        { field: "baseBranch", value: "nope", ok: false,
          gap: { class: GAP_CLASS.SCOPE_INVALID, nextAction: "Confirm the base branch." } },
      ],
    },
  });
  const gate = githubGate(result, row);
  assert.equal(gate.blocking, true, "partial GitHub must block");
  assert.match(gate.message, /baseBranch/);
  assert.match(gate.nextAction, /Confirm the base branch/);
});

test("GitHub with a target simply MISSING does not pass either", () => {
  const row = table.github;
  const { result } = validateVerification({
    capability: "github", row,
    result: { verified: true, via: "gh", targets: [ok("repos", "acme/api", "gh api -> 200")] },
  });
  const gate = githubGate(result, row);
  assert.equal(gate.blocking, true, "an omitted field is not a verified one");
  assert.match(gate.message, /baseBranch|subpaths/);
});

test("GitHub with every declared field verified passes", () => {
  const row = table.github;
  const { result } = validateVerification({
    capability: "github", row,
    result: {
      verified: true, via: "gh",
      targets: Object.keys(row.scopeFields).map((f) => ok(f, `v-${f}`, `checked ${f}`)),
    },
  });
  assert.equal(githubGate(result, row).blocking, false);
});

test("the gate fails CLOSED on a missing or mis-shaped result", () => {
  // Every non-match used to return {blocking:false}, so a skipped or thrown
  // validateVerification, or a differently-cased capability key, waved the run
  // past the one gate that can stop it. A gate whose default is proceed is not one.
  for (const bad of [undefined, null, {}, { capability: "" }, { verified: true }]) {
    assert.equal(githubGate(bad).blocking, true, `githubGate(${JSON.stringify(bad)}) must block`);
  }
  assert.equal(githubGate({ capability: "logs", verified: false }).blocking, false,
    "but a non-mandatory capability still never blocks");
});

test("a target reported ok while carrying a gap is contradictory and reported", () => {
  // The gap checks are skipped for ok:true, so an unknown class and an empty
  // nextAction rode into the committed context labelled "verified".
  const r = validateVerification({
    capability: "logs", row: table.logs,
    result: { verified: true, via: "x",
      targets: [{ field: "logIndex", value: "a", ok: true, checkedBy: "q",
                  gap: { class: "nonsense", nextAction: "" } }] },
  });
  assert.ok(codes(r.violations).includes("verified-with-gap"));
});

test("a failed gap with no next action never prints 'undefined'", () => {
  const r = validateVerification({
    capability: "github", row: table.github,
    result: { verified: false, via: "gh",
      targets: [{ field: "repos", value: "acme/web", ok: false, gap: { class: GAP_CLASS.SCOPE_INVALID } }] },
  });
  const gate = githubGate(r.result, table.github);
  assert.doesNotMatch(gate.message, /undefined/, gate.message);
  assert.ok(gate.nextAction.trim().length > 0);
});

test("normalisation never UPGRADES a reported failure", () => {
  // It is documented as only ever downgrading an unsupported claim, but computing
  // `verified` purely from the targets turned a reported `verified: false` into
  // true whenever any target carried ok+checkedBy — with no violation. If the
  // agent says it is not verified, the targets can only take that away.
  const r = validateVerification({
    capability: "logs",
    row: table.logs,
    result: { verified: false, via: "logcli", targets: [ok("logIndex", "app", "logcli labels -> 3")] },
  });
  assert.equal(r.result.verified, false, "the agent's own verdict stands");
});
