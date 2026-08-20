// Verification is a POLICY over what the agent reports, so this suite tests the
// contract, not a probe table — and not the report's own shape.
//
// It used to also test `validateVerification`, which re-checked the report the
// agent had just written. That is gone, and so are ~15 tests: they proved a
// validator agreed with itself. The one rule that looked structural — `checkedBy`
// must be present — turned out to be a presence check that `checkedBy:
// "promtool --version"`, the literal historical defect, satisfied. It read as
// enforcement and was not. The rule survives where it changes an outcome: inside
// `githubGate`, on the one capability whose absence stops the run.
//
// Three properties carry the weight now:
//
//   1. GitHub is binary, its gate needs COVERAGE of every declared field, it fails
//      CLOSED, and its refusal is a sentence a human can act on.
//   2. Nothing credential-shaped survives into a committed field, and the scanner
//      is never weaker than the redactor.
//   3. Warnings are scoped to the capability whose vocabulary they read.
//
// Every assertion was checked by MUTATION: break the code it guards, confirm the
// test fails, restore. Four guards in this repo were previously vacuous, so "it
// passes" is not evidence that it can fail.

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
} from "../lib/verify.mjs";
import { redact } from "../lib/tool-cache.mjs";
import { FAKE, EMBEDDED, BENIGN } from "./helpers/fake-credentials.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const config = JSON.parse(readFileSync(join(ROOT, "config/rca.config.json"), "utf8"));
const githubRow = config.capabilities.github;
const declaredFields = Object.keys(githubRow.scopeFields).filter((f) => !f.startsWith("$"));

/** A proven target, as the agent reports one. */
const ok = (field, value = `v-${field}`, checkedBy = `checked ${field}`) =>
  ({ field, value, ok: true, checkedBy });
const report = (targets, capability = MANDATORY_CAPABILITY) => ({ capability, targets });

// ---- the mandatory gate needs COVERAGE, not one lucky target ----------------

test("GitHub with every declared field proven passes", () => {
  assert.equal(githubGate(report(declaredFields.map((f) => ok(f))), githubRow).blocking, false);
});

test("GitHub with a proven repo and a FAILED base branch does not pass", () => {
  // This is the defect the coverage rule exists for. `verified` was an OR over
  // targets, so this reported verified:true and the gate waved it through — into
  // the run's single deliverable, the culprit-PR hunt over that branch, with the
  // branch proven unreachable and nothing said. The row's own intent says "a
  // repository is readable AND the base branch's merged-PR list can be listed".
  //
  // MUTATION: drop the `uncovered` check in githubGate and this fails.
  const gate = githubGate(
    report([
      ...declaredFields.filter((f) => f !== "baseBranch").map((f) => ok(f)),
      { field: "baseBranch", value: "nope", ok: false,
        gap: { class: GAP_CLASS.SCOPE_INVALID, nextAction: "Confirm the base branch." } },
    ]),
    githubRow,
  );
  assert.equal(gate.blocking, true, "partial GitHub must block");
  assert.match(gate.message, /baseBranch/);
  assert.match(gate.nextAction, /Confirm the base branch/);
});

test("a field simply OMITTED does not pass either", () => {
  const gate = githubGate(report([ok("repos")]), githubRow);
  assert.equal(gate.blocking, true, "an omitted field is not a verified one");
  for (const f of declaredFields.filter((f) => f !== "repos")) assert.match(gate.message, new RegExp(f));
});

test("a target claiming ok while naming no check is called out as exactly that", () => {
  // The interesting failure mode: it reads like success and proves nothing. It must
  // not be reported as merely "missing", or the agent re-sends the same claim.
  //
  // MUTATION: weaken isProven to `t?.ok === true` and this fails.
  const gate = githubGate(
    report([...declaredFields.filter((f) => f !== "baseBranch").map((f) => ok(f)),
            { field: "baseBranch", value: "main", ok: true }]),
    githubRow,
  );
  assert.equal(gate.blocking, true);
  assert.match(gate.message, /names no check/);
  assert.match(gate.message, new RegExp(UNVERIFIED), "and names the state it should have been reported as");
});

test("checkedBy must carry something, not just exist", () => {
  for (const empty of [undefined, null, "", "   ", "\t\n"]) {
    const gate = githubGate(report(declaredFields.map((f) => ({ ...ok(f), checkedBy: empty }))), githubRow);
    assert.equal(gate.blocking, true, `checkedBy ${JSON.stringify(empty)} must not count as proof`);
  }
});

test("the gate fails CLOSED on a missing or mis-shaped report", () => {
  // Every non-match used to return {blocking:false}, so a skipped or thrown
  // verification step, or a differently-cased capability key, waved the run past
  // the one gate that can stop it. A gate whose default is proceed is not one.
  for (const bad of [undefined, null, {}, { capability: "" }, { targets: [] }, { capability: "GitHub" }]) {
    assert.equal(githubGate(bad, githubRow).blocking, true, `githubGate(${JSON.stringify(bad)}) must block`);
  }
});

test("no other capability blocks", () => {
  for (const capability of ["infra", "logs", "metrics", "other"]) {
    assert.equal(githubGate(report([], capability), githubRow).blocking, false, capability);
  }
});

test("a refusal never prints 'undefined' and always carries a next action", () => {
  const cases = [
    report([]),
    report([{ field: "repos", value: "acme/web", ok: false, gap: { class: GAP_CLASS.SCOPE_INVALID } }]),
    report([{ field: "repos", ok: false, gap: { class: GAP_CLASS.SCOPE_INVALID, nextAction: "" } }]),
    report([ok("repos")]),
    { capability: MANDATORY_CAPABILITY },
  ];
  for (const c of cases) {
    const gate = githubGate(c, githubRow);
    assert.equal(gate.blocking, true);
    assert.doesNotMatch(gate.message, /undefined|null/, JSON.stringify(c));
    assert.ok(gate.nextAction.trim().length > 0, `no next action for ${JSON.stringify(c)}`);
  }
});

test("a row declaring no scope fields still needs one proven target", () => {
  // Guards the `declared.length === 0` branch in both directions: without a row we
  // cannot check coverage, so the weaker rule applies — but it is not "no rule".
  assert.equal(githubGate(report([ok("anything")]), null).blocking, false);
  assert.equal(githubGate(report([{ field: "anything", ok: true }]), null).blocking, true);
  assert.equal(githubGate(report([]), {}).blocking, true);
});

// ---- secrets never reach a committed field ----------------------------------

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
    assert.equal(looksLikeSecret(prefix + EMBEDDED.urlUserinfo).secret, true,
      `must be caught behind ${JSON.stringify(prefix)}`);
  }
});

test("a bare token is caught whether it stands alone or sits in a sentence", () => {
  // Both boundaries were live defects, in opposite directions. Applying entropy to
  // the WHOLE value flagged the library's own prose; skipping any value containing
  // whitespace let `export SOME_TOKEN <40 chars>` through clean. Words, not values.
  assert.equal(looksLikeSecret(FAKE.githubPat).secret, true);
  assert.equal(looksLikeSecret(`the token is ${FAKE.githubPat} — rotate it`).secret, true);
  assert.equal(looksLikeSecret(`export SOME_TOKEN ${FAKE.highEntropy}`).secret, true);
});

test("the library's own prose is not a credential", () => {
  // This was a P0 blocker: the entropy fallback (>=32 chars, mixed case, a digit)
  // matched prWindowWarning's message and every gap next action, so writeRcaContext
  // refused any context carrying a gap and told the customer to rotate a credential
  // that never existed.
  const prose = [
    prWindowWarning({ mergedCount: 0, branch: "main" }).message,
    "'prod-2' was not found. Check the value and re-run setup.",
    "Install the runtime CLI on this machine, then re-run setup.",
    overBroadWarning(MANDATORY_CAPABILITY, ["admin:org"]).message,
    githubGate(report([]), githubRow).message,
    githubGate(report([ok("repos")]), githubRow).message,
  ];
  for (const p of prose) {
    assert.equal(looksLikeSecret(p).secret, false, `library prose must not be flagged: ${p}`);
  }
});

test("real answers are never flagged", () => {
  for (const b of BENIGN) assert.equal(looksLikeSecret(b).secret, false, b);
  assert.equal(looksLikeSecret(FAKE.gitSha).secret, false, "a 40-char hex SHA is legitimate here");
});

// ---- warnings stay inside their own vocabulary ------------------------------

test("over-broad scopes are reported for GitHub and nobody else", () => {
  // The scope vocabulary is GitHub's. It was applied to every capability, so an
  // unrelated provider's scope strings were measured against `write:org`.
  assert.ok(overBroadWarning(MANDATORY_CAPABILITY, ["repo", "admin:org"]).scopes.includes("admin:org"));
  assert.equal(overBroadWarning("logs", ["write"]), null);
  assert.equal(overBroadWarning(MANDATORY_CAPABILITY, ["repo:status"]), null);
});

test("an empty PR window warns, persists, and names the branch it checked", () => {
  const w = prWindowWarning({ mergedCount: 0, branch: "release/2026-08" });
  assert.equal(w.code, "empty-pr-window");
  assert.equal(w.persist, true, "it predicts a dead culprit hunt, so printing once is not enough");
  assert.equal(w.windowDays, PR_WINDOW_DAYS);
  assert.match(w.message, /release\/2026-08/);
  assert.equal(prWindowWarning({ mergedCount: 3, branch: "main" }), null);
});

test("the access-level vocabulary the prose teaches is the one the code exports", () => {
  // ACCESS_LEVEL is now reported BY the agent rather than derived from its report,
  // so nothing in lib/ would notice the enum and the prose drifting apart. An agent
  // told to report `not-reportable` against code spelling it differently produces a
  // value no reader can match.
  const setup = readFileSync(join(ROOT, "skills/rca-build/references/setup.md"), "utf8");
  assert.match(setup, new RegExp(`\`${ACCESS_LEVEL.NOT_REPORTABLE}\``),
    "setup.md must name the exact state a provider reporting no scopes gets");
  assert.notEqual(ACCESS_LEVEL.NOT_REPORTABLE, ACCESS_LEVEL.REPORTED);
});
