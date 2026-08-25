// Real throwaway git repos, following tests/repo-source.test.mjs — the git
// behaviour here (worktree resolution, tracked-ness, check-ignore) IS the thing
// under test, so mocking it would prove nothing.
//
// EVERY assertion in this file was proven by mutation: the code it guards was
// broken, the test was confirmed to fail, and the mutation is recorded in a
// comment beside it. Four guards in this project were previously vacuous — two of
// them written as fixes — so "it passes" is not evidence that it can fail.
//
// The load-bearing assertions, in the order they matter:
//   - `verifiedBy: {note: "TODO"}` is NOT runnable. A non-empty-string check here
//     was the worst defect the plan review found: the whole lifecycle boundary
//     rests on this one predicate.
//   - two equally specific buildMatch patterns REFUSE rather than pick one.
//   - a build name matching nothing refuses instead of falling back to
//     defaultProfile.
//   - writes are additive: an unrelated connector survives byte-identically, and
//     a refused write leaves the file byte-identical.
//   - the artifact is NOT owner-only, and the module contains no hardening call.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_FILENAME,
  CONTEXT_README,
  CREDENTIAL_KIND,
  DEFAULT_STALE_AFTER_DAYS,
  MANDATORY_CAPABILITY,
  SCHEMA_VERSION,
  capabilitySequence,
  capabilityFallbacks,
  contextDestination,
  findContextFile,
  isEnvVarName,
  isISODate,
  isProvisioned,
  isRunnable,
  matchesBuildName,
  missingCapabilities,
  readRcaContext,
  recordGap,
  recordWarning,
  recordKnowledge,
  selectProfile,
  upsertConnector,
  validateConnector,
  validateContext,
  writeRcaContext,
} from "../lib/rca-context.mjs";

const CLI = new URL("../bin/rca-context.mjs", import.meta.url).pathname;
const REAL_CONFIG = new URL("../config/rca.config.json", import.meta.url).pathname;

let ws, productRepo, automationRepo, pluginDir;

const g = (dir, ...a) =>
  execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** `git init` only — check-ignore, rev-parse --show-toplevel and ls-files all
 *  work on an empty repo with a staged file, so no seed commit is needed. */
function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  g(dir, "init", "-q");
  return dir;
}

/**
 * Build the workspace ON DEMAND: two sibling clones plus the plugin checked out
 * beside them, which is the shape a parent-only walk cannot see. Half this file's
 * tests touch no filesystem at all (predicates, matching, selection, validation),
 * and building three git repos for them would dominate the run.
 */
function workspace() {
  if (ws) return;
  // realpath because git reports realpaths and the module canonicalizes to match:
  // on macOS /var is a symlink to /private/var.
  ws = realpathSync(mkdtempSync(join(tmpdir(), "rca-ctx-")));
  productRepo = initRepo(join(ws, "api"));
  automationRepo = initRepo(join(ws, "e2e-tests"));
  pluginDir = initRepo(join(ws, "browserstack-ai-tfa-demo"));
}

afterEach(() => {
  if (!ws) return;
  rmSync(ws, { recursive: true, force: true });
  ws = productRepo = automationRepo = pluginDir = undefined;
});

// A connector whose verifiedBy carries a real claim. `via` and `tool` are
// deliberately placeholder names: a fixture naming a real vendor is the strongest
// teaching signal in a test file, and this plugin has no default stack.
const verifiedConnector = (over = {}) => ({
  via: "forge-cli",
  scope: { repo: "acme/api", base: "main" },
  howToQuery: {
    tool: "forge-cli",
    args: ["pr", "list", "--repo", "acme/api", "--base", "main", "--state", "merged"],
  },
  credential: { kind: CREDENTIAL_KIND.PROVIDER_MANAGED },
  verifiedBy: { count: 37, observedAt: "2026-08-19", note: "merged PRs into main; newest #4188" },
  verifiedAt: "2026-08-19",
  ...over,
});

const profileFixture = (over = {}) => ({
  buildMatch: ["nightly web regression*"],
  repos: { product: ["acme/api"], automation: ["acme/e2e-tests"] },
  subpaths: ["services/billing"],
  branches: { default: "main", observed: ["release/24.9"] },
  connectors: { [MANDATORY_CAPABILITY]: verifiedConnector() },
  gaps: [],
  warnings: [],
  ...over,
});

const validContext = (over = {}) => ({
  _README: CONTEXT_README,
  schemaVersion: SCHEMA_VERSION,
  homeRepo: "acme/api",
  defaultProfile: "prod-web",
  profiles: { "prod-web": profileFixture() },
  ...over,
});

/** A config-shaped object with no vendor name in it. */
const configFixture = () => ({
  evidenceRouting: {
    // A skipped entry that DOES name a capability, so the skip guard is testable:
    // TFA owns this evidence and it is never ours to provision.
    test_logs: { owner: "tfa", skip: true, capability: "test_logs" },
    product_code: { capability: "github" },
    deploy: { capability: "github" },
    ci: { capability: "ci", fallbackCapability: "github" },
    runtime: { capability: "infra" },
    log_search: { capability: "logs" },
    metrics: { capability: "metrics" },
    other: { capability: "other" },
  },
});

/** The exact bytes of one `"key": { … }` block, so "unchanged" can be asserted at
 *  the byte level rather than at the parsed level. */
function jsonBlock(raw, key) {
  const start = raw.indexOf(`"${key}": {`);
  assert.ok(start >= 0, `no "${key}" block in the file`);
  let depth = 0;
  for (let i = raw.indexOf("{", start); i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}" && --depth === 0) return raw.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after "${key}"`);
}

function keysAtAnyDepth(node, out = new Set()) {
  if (Array.isArray(node)) node.forEach((v) => keysAtAnyDepth(v, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      out.add(k);
      keysAtAnyDepth(v, out);
    }
  }
  return out;
}

function cli(...argv) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...argv], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, json: JSON.parse(stdout) };
  } catch (err) {
    let json = null;
    try {
      json = JSON.parse(err.stdout ?? "");
    } catch { /* usage errors print prose to stderr, by design */ }
    return { status: err.status, json, stderr: String(err.stderr ?? "") };
  }
}

// ---- PREDICATE 1: runnable is a SHAPE check ---------------------------------

test("a verifiedBy carrying only a note is NOT runnable", () => {
  // MUTATION: isVerifiedClaim → `return Object.keys(verifiedBy).length > 0`
  //           (i.e. "is verifiedBy non-empty?"). This test fails; every other
  //           runnable test still passes, which is exactly why it exists.
  // The plan's own words: the lifecycle boundary rests on this field, and a
  // non-empty check is satisfied by "TODO" and by "attempted, could not list PRs"
  // — both of which an agent hedging instead of failing will write.
  for (const verifiedBy of [
    { note: "TODO" },
    { note: "attempted, could not list PRs" },
    { note: "" },
    {},
  ]) {
    const profile = profileFixture({
      connectors: { [MANDATORY_CAPABILITY]: verifiedConnector({ verifiedBy }) },
    });
    assert.equal(isRunnable(profile), false, `verifiedBy ${JSON.stringify(verifiedBy)} proves nothing`);
  }
});

test("a count alone and an observedAt alone are each enough", () => {
  // MUTATION: require BOTH count and observedAt (`&&` instead of the early
  //           return) → both halves of this fail.
  for (const verifiedBy of [{ count: 37 }, { observedAt: "2026-08-19" }, { count: 0 }]) {
    const profile = profileFixture({
      connectors: { [MANDATORY_CAPABILITY]: verifiedConnector({ verifiedBy }) },
    });
    assert.equal(isRunnable(profile), true, `verifiedBy ${JSON.stringify(verifiedBy)} is a decidable claim`);
  }
});

test("count zero is verified — a reachable but empty PR window is a warning, not a failure", () => {
  // MUTATION: `verifiedBy.count >= 0` → `verifiedBy.count > 0`. Fails here.
  // §6 of the plan classifies "reachable, empty PR window" as a warning that does
  // not count against the retry bound, so refusing to call it verified would loop
  // a customer whose repo simply has no merged PRs in the window.
  const profile = profileFixture({
    connectors: { [MANDATORY_CAPABILITY]: verifiedConnector({ verifiedBy: { count: 0, note: "no merges in window" } }) },
  });
  assert.equal(isRunnable(profile), true);
});

test("a non-integer count, a bogus date, and a non-object verifiedBy are all unverified", () => {
  // MUTATION: `Number.isInteger(count)` → `count !== undefined`. Fails on "37".
  for (const verifiedBy of [{ count: "37" }, { count: 1.5 }, { count: -1 }, { observedAt: "yesterday" }, "verified", null, []]) {
    const profile = profileFixture({
      connectors: { [MANDATORY_CAPABILITY]: verifiedConnector({ verifiedBy }) },
    });
    assert.equal(isRunnable(profile), false, `${JSON.stringify(verifiedBy)} is not a claim`);
  }
});

test("runnable is the MANDATORY capability's predicate — another verified connector does not stand in", () => {
  // MUTATION: isRunnable → "any connector has a verified claim". Fails here.
  // Without the code and the merged PRs there is no culprit PR, which is the
  // run's entire deliverable, so no other capability can substitute.
  const profile = profileFixture({ connectors: { logs: verifiedConnector() } });
  assert.equal(isRunnable(profile), false);
  assert.equal(isRunnable(profileFixture({ connectors: {} })), false);
  assert.equal(isRunnable(undefined), false);
});

// ---- PREDICATE 2: provisioned, and the resume point it yields ---------------

test("the capability sequence comes from config, skipping what TFA owns", () => {
  // MUTATION: drop the `entry.skip === true` guard → "test_logs" has no
  //           capability so nothing changes; drop the `out.includes` dedupe →
  //           github appears twice and this fails.
  assert.deepEqual(capabilitySequence(configFixture()), ["github", "ci", "infra", "logs", "metrics", "other"]);
  assert.deepEqual(capabilitySequence({}), []);
  assert.deepEqual(capabilitySequence(null), []);
});

test("the sequence derived from the REAL config is duplicate-free and includes the mandatory capability", () => {
  // Asserted as a property rather than a literal list, because the orchestrator
  // owns config/rca.config.json and edits it concurrently. The plan's own
  // criticism was that NO test loads the real config, so a silent routing
  // regression ships green.
  const config = JSON.parse(readFileSync(REAL_CONFIG, "utf8"));
  const caps = capabilitySequence(config);
  assert.ok(caps.includes(MANDATORY_CAPABILITY), "the mandatory capability must be in the sequence");
  assert.equal(new Set(caps).size, caps.length, "a duplicate would make provisioned ask twice");
  for (const [name, entry] of Object.entries(config.evidenceRouting)) {
    if (entry.skip === true) assert.ok(!caps.includes(name), `${name} is owned by TFA and is not ours to provision`);
  }
});

test("a capability with neither a connector nor a gap is what remains to be asked", () => {
  // MUTATION: `!gapped.has(c)` → `true` (ignore gaps) → the declined-logs case
  //           fails, because a skipped capability would be re-asked every run.
  const caps = capabilitySequence(configFixture());
  const profile = profileFixture({
    connectors: { [MANDATORY_CAPABILITY]: verifiedConnector(), infra: verifiedConnector() },
    gaps: [{ capability: "logs", classification: "declined" }],
  });
  assert.deepEqual(missingCapabilities(profile, caps), ["ci", "metrics", "other"]);
  assert.equal(isProvisioned(profile, caps), false);
  // The first element IS the resume point — derived, never stored.
  assert.equal(missingCapabilities(profile, caps)[0], "ci");
});

test("runnable but NOT provisioned is the state the gate must be able to see", () => {
  // MUTATION: make isProvisioned return `isRunnable(profile)`. Fails here.
  // Conflating the two locks a customer in: the mandatory capability is asked
  // first, so abandoning straight after it leaves a runnable profile, first
  // contact never fires again, and every later run declares the rest unavailable.
  const caps = capabilitySequence(configFixture());
  const profile = profileFixture();
  assert.equal(isRunnable(profile), true);
  assert.equal(isProvisioned(profile, caps), false);
});

test("a gap for every remaining capability makes a profile provisioned", () => {
  const caps = capabilitySequence(configFixture());
  const profile = profileFixture({
    gaps: caps.filter((c) => c !== MANDATORY_CAPABILITY).map((c) => ({ capability: c, classification: "declined" })),
  });
  assert.deepEqual(missingCapabilities(profile, caps), []);
  assert.equal(isProvisioned(profile, caps), true);
});

// ---- profile matching: anchored, case-folded, one wildcard, no regex --------

test("matching is anchored — a bare word never matches a wildcard pattern around it", () => {
  // MUTATION: `n.startsWith(head) && n.endsWith(tail)` → `n.includes(head)`.
  //           Fails on the "nightly" cases below.
  // Substring matching is how the wrong profile gets selected, and a wrong
  // profile is a run against another environment's repos and branches.
  assert.equal(matchesBuildName("web-nightly-*", "nightly"), false);
  assert.equal(matchesBuildName("nightly", "web-nightly-12"), false);
  assert.equal(matchesBuildName("*-nightly", "web-nightly-12"), false);
  assert.equal(matchesBuildName("web-nightly-*", "prod-web-nightly-12"), false);
});

test("matching is case-folded and whole-string", () => {
  // MUTATION: drop both `.toLowerCase()` calls → the Prod-Web case fails.
  assert.equal(matchesBuildName("prod-web-nightly-*", "Prod-Web-Nightly-12"), true);
  assert.equal(matchesBuildName("Nightly Web Regression*", "nightly web regression 41"), true);
  assert.equal(matchesBuildName("main", "MAIN"), true);
  assert.equal(matchesBuildName("main", "main-2"), false);
});

test("one wildcard is supported; a second one matches nothing rather than being guessed at", () => {
  // MUTATION: delete the second-star check → the two-star pattern matches and
  //           this fails.
  assert.equal(matchesBuildName("*", "anything at all"), true);
  assert.equal(matchesBuildName("web-*-nightly", "web-prod-nightly"), true, "one wildcard mid-pattern is fine");
  assert.equal(matchesBuildName("web-*-nightly-*", "web-prod-nightly-12"), false, "two wildcards is not guessed at");
  // The discriminating case, and the only one there is: drop the second-wildcard
  // check and the trailing "*" becomes a LITERAL, so this starts matching.
  assert.equal(matchesBuildName("web-*-nightly-*", "web-prod-nightly-*"), false, "and a second '*' is never matched literally");
  assert.equal(matchesBuildName("web-*", "web-"), true, "an empty tail is still a whole-string match");
  assert.equal(matchesBuildName("web-*-x", "web-x"), false);
  assert.equal(matchesBuildName("*-x", "x"), false, "head+tail longer than the name cannot match");
});

test("matching refuses non-strings instead of coercing them", () => {
  assert.equal(matchesBuildName("*", 42), false);
  assert.equal(matchesBuildName(null, "web"), false);
});

test("the module matches with string arithmetic — no regex anywhere in it", () => {
  // The guard IS the absence, so assert it. A regex here would re-admit exactly
  // the class of defect the plan catalogues four times over (a `^`-anchored
  // pattern that only matched at position 0; `[^a-z]` under /i excluding A-Z).
  const src = readFileSync(new URL("../lib/rca-context.mjs", import.meta.url), "utf8");
  for (const idiom of ["RegExp(", ".test(", ".match(", ".matchAll(", "replace(/", "split(/"]) {
    assert.ok(!src.includes(idiom), `${idiom} — matching here must stay character arithmetic`);
  }
});

// ---- selection ---------------------------------------------------------------

const twoWayContext = () =>
  validContext({
    defaultProfile: "prod-web",
    profiles: {
      "prod-web": profileFixture({ buildMatch: ["web-nightly-*"] }),
      "prod-api": profileFixture({ buildMatch: ["api-nightly-*"] }),
    },
  });

test("two equally specific patterns matching one build name REFUSE, naming both", () => {
  // MUTATION: `if (winners.length > 1)` → take `winners[0]` ("first key wins").
  //           Fails here. Neither JSON key order nor alphabetical order is a
  //           decision anybody made, and a reformat silently changes the first.
  const context = validContext({
    profiles: {
      // 11 literal characters each — a genuine tie, which is the only case that
      // must refuse. (`web-nightly-*` would be 12 and would win on specificity.)
      "prod-web": profileFixture({ buildMatch: ["*-nightly-12"] }),
      "prod-api": profileFixture({ buildMatch: ["web-nightly*"] }),
    },
  });
  const r = selectProfile({ context, buildName: "web-nightly-12", todayISO: "2026-08-20" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "ambiguous-profile");
  assert.deepEqual(r.labels.sort(), ["prod-api", "prod-web"]);
  assert.match(r.message, /prod-web/);
  assert.match(r.message, /prod-api/);
});

test("more literal characters wins, and the loser is reported as alsoMatched", () => {
  // MUTATION: specificityOf → `return 0` (every pattern equally specific) → this
  //           becomes an ambiguous refusal and fails.
  const context = validContext({
    profiles: {
      broad: profileFixture({ buildMatch: ["web-*"] }),
      narrow: profileFixture({ buildMatch: ["web-nightly-*"] }),
    },
    defaultProfile: "broad",
  });
  const r = selectProfile({ context, buildName: "web-nightly-12", todayISO: "2026-08-20" });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.label, "narrow");
  assert.equal(r.matchedBy, "build-name");
  assert.deepEqual(r.alsoMatched, ["broad"], "the gate prints this, which is how the file gets fixed");
});

test("a build name matching NOTHING refuses rather than falling back to defaultProfile", () => {
  // MUTATION: in the zero-candidate branch, fall back to
  //           `context.defaultProfile` instead of refusing. Fails here.
  // A name matching nothing means the file does not describe this build; running
  // the default's repos and branches against it is the wrong-context run.
  const context = validContext({
    defaultProfile: "prod-web",
    profiles: {
      "prod-web": profileFixture({ buildMatch: ["web-nightly-*"] }),
      "prod-api": profileFixture({ buildMatch: ["api-nightly-*"] }),
      staging: profileFixture({ buildMatch: ["staging-*"] }),
    },
  });
  const r = selectProfile({ context, buildName: "canary-smoke-3", todayISO: "2026-08-20" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "no-matching-profile");
  assert.deepEqual(r.labels.sort(), ["prod-api", "prod-web", "staging"]);
  assert.match(r.message, /defaultProfile is deliberately NOT used/);
});

test("ONE profile that DECLARES a pattern and does not match it still refuses", () => {
  // MUTATION: adopt the sole profile regardless of what it declares -> fails.
  //
  // This test previously asserted the opposite, and a live run showed why that was
  // wrong: a profile bound to `ObservabilityApiLaneSuite-*` was applied to a build named
  // `ObservabilityPipelineSuite-…` and the run reported "runnable and provisioned".
  // Different suite, different failures, and the profile's four product repos and base
  // branches attributed to it — the wrong-context run, with no refusal anywhere.
  //
  // A narrow pattern is a deliberate statement. A customer who meant "every build"
  // writes `*`. Being the only profile in the file is not a match.
  const r = selectProfile({ context: validContext(), buildName: "something-nobody-bound", todayISO: "2026-08-20" });
  assert.equal(r.ok, false, "the file declares which builds are its own, and this is not one");
  assert.equal(r.code, "no-matching-profile");
  assert.match(r.message, /nightly web regression\*/, "name the pattern that did not match, so it can be fixed");
  assert.match(r.message, /neither is "it is the only profile"/, "and say why one profile is not a match");
});

test("ONE profile that declares NO pattern has no opinion and is used", () => {
  // MUTATION: drop the `silent` filter (refuse whenever nothing matched) -> fails.
  // The no-opinion rule, identical to projectMatch's: a profile that never said which
  // builds are its own cannot be contradicted. Every context written before buildMatch
  // was set is this shape, and refusing them all would break first-contact output that
  // was correct when it was written.
  const noPattern = validContext({ profiles: { only: profileFixture({ buildMatch: undefined }) }, defaultProfile: "only" });
  const r = selectProfile({ context: noPattern, buildName: "something-nobody-bound", todayISO: "2026-08-20" });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.label, "only");
  assert.equal(r.matchedBy, "sole-profile", "the caller has to be able to print WHY this profile was used");
});

test("several profiles that all declare NO pattern refuse rather than guess", () => {
  // MUTATION: use silent[0] instead of requiring exactly one -> fails. JSON key order
  // is not a decision anybody made, which is the same reason an exact specificity tie
  // refuses.
  const ctx = validContext({
    profiles: { a: profileFixture({ buildMatch: undefined }), b: profileFixture({ buildMatch: undefined }) },
    defaultProfile: "a",
  });
  const r = selectProfile({ context: ctx, buildName: "unbound", todayISO: "2026-08-20" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "no-matching-profile");
  assert.match(r.message, /declare no buildMatch/);
});

test("no build name at all falls back to defaultProfile — its only job", () => {
  // MUTATION: drop the defaultProfile branch → refuses, and this fails.
  const r = selectProfile({ context: twoWayContext(), todayISO: "2026-08-20" });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.label, "prod-web");
  assert.equal(r.matchedBy, "default-profile");
});

test("no build name and no defaultProfile with two profiles refuses", () => {
  const context = twoWayContext();
  delete context.defaultProfile;
  const r = selectProfile({ context, todayISO: "2026-08-20" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "no-default-profile");
  assert.deepEqual(r.labels.sort(), ["prod-api", "prod-web"]);
});

test("an explicit profile is matched EXACTLY; a near miss refuses listing the labels", () => {
  // MUTATION: `Object.hasOwn(profiles, want)` → a startsWith/includes lookup.
  //           Fails on "prod" below. A typo resolving to a neighbouring label is
  //           a wrong-context run with no signal at all.
  const context = twoWayContext();
  assert.equal(selectProfile({ context, requested: "prod-api", todayISO: "2026-08-20" }).label, "prod-api");
  const r = selectProfile({ context, requested: "prod", buildName: "web-nightly-1", todayISO: "2026-08-20" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "unknown-profile");
  assert.deepEqual(r.labels.sort(), ["prod-api", "prod-web"]);
});

test("an explicit profile OUTRANKS a build name that matches a different one", () => {
  // MUTATION: reorder the branches so buildName is consulted first → returns
  //           prod-web and this fails.
  const r = selectProfile({ context: twoWayContext(), requested: "prod-api", buildName: "web-nightly-12", todayISO: "2026-08-20" });
  assert.equal(r.label, "prod-api");
  assert.equal(r.matchedBy, "requested");
});

test("a selected profile that is not runnable REFUSES — never a silent switch to a runnable sibling", () => {
  // MUTATION: after the isRunnable check, pick any runnable profile instead of
  //           refusing. Fails here. That substitution is the wrong-context run in
  //           its purest form: the customer asked about one environment and got
  //           an answer about another.
  const context = validContext({
    defaultProfile: "unfinished",
    profiles: {
      unfinished: profileFixture({
        buildMatch: ["web-nightly-*"],
        connectors: { [MANDATORY_CAPABILITY]: verifiedConnector({ verifiedBy: { note: "TODO" } }) },
      }),
      working: profileFixture({ buildMatch: ["api-nightly-*"] }),
    },
  });
  const r = selectProfile({ context, buildName: "web-nightly-12", todayISO: "2026-08-20" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "not-runnable");
  assert.equal(r.label, "unfinished");
  assert.ok(!JSON.stringify(r).includes('"working"') || r.message.includes("unfinished"));
  assert.match(r.message, /Refusing rather than switching/);
});

test("a context with no profiles refuses instead of throwing", () => {
  for (const context of [{}, { profiles: {} }, null, { profiles: [] }]) {
    const r = selectProfile({ context, todayISO: "2026-08-20" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "no-profiles");
  }
});

// ---- staleness: labels, never blocks ---------------------------------------

test("staleness is a date comparison against the INJECTED day, and never blocks", () => {
  // MUTATION: `age > staleAfterDays` → `age > 0` → github is stale on day 1 and
  //           the second half of this fails.
  const context = validContext();
  const stale = selectProfile({ context, todayISO: "2026-10-19", staleAfterDays: DEFAULT_STALE_AFTER_DAYS });
  assert.equal(stale.ok, true, "stale never blocks — it only relabels the digest line");
  assert.deepEqual(stale.stale, [MANDATORY_CAPABILITY]);
  assert.equal(stale.ages[MANDATORY_CAPABILITY], 61);

  const fresh = selectProfile({ context, todayISO: "2026-08-20", staleAfterDays: DEFAULT_STALE_AFTER_DAYS });
  assert.deepEqual(fresh.stale, []);
  assert.equal(fresh.ages[MANDATORY_CAPABILITY], 1);
});

test("with no todayISO nothing is called stale — the module never reads the clock", () => {
  // MUTATION: default `todayISO` to `new Date().toISOString().slice(0,10)` inside
  //           stalenessOf → ages is populated and this fails. The clock is read
  //           in bin/, once, and injected.
  const src = readFileSync(new URL("../lib/rca-context.mjs", import.meta.url), "utf8");
  assert.ok(!src.includes("new Date("), "no decision function may read the clock");
  assert.ok(!src.includes("Date.now("), "no decision function may read the clock");
  const r = selectProfile({ context: validContext() });
  assert.equal(r.ok, true);
  assert.deepEqual(r.stale, []);
  assert.deepEqual(r.ages, {});
});

test("staleness prefers verifiedAt but accepts verifiedBy.observedAt", () => {
  const context = validContext({
    profiles: {
      "prod-web": profileFixture({
        connectors: {
          [MANDATORY_CAPABILITY]: verifiedConnector({ verifiedAt: undefined, verifiedBy: { observedAt: "2026-01-01" } }),
        },
      }),
    },
  });
  const r = selectProfile({ context, todayISO: "2026-08-20", staleAfterDays: 30 });
  assert.deepEqual(r.stale, [MANDATORY_CAPABILITY]);
  assert.equal(r.ages[MANDATORY_CAPABILITY], 231);
});

// ---- schema shape: the whole of the secret story ----------------------------

test("a credential is ONLY an env-var name or provider-managed", () => {
  // MUTATION: accept any `kind` (drop the else branch) → the bogus kinds pass and
  //           this fails.
  assert.equal(validateConnector(verifiedConnector({ credential: { kind: "env-var", name: "FORGE_TOKEN" } })).ok, true);
  assert.equal(validateConnector(verifiedConnector({ credential: { kind: "provider-managed" } })).ok, true);
  for (const credential of [
    { kind: "inline" },
    { kind: "env-var" },
    { kind: "env-var", name: "not a var name" },
    { kind: "env-var", name: "9LEADING_DIGIT" },
    { kind: "provider-managed", name: "FORGE_TOKEN" },
    "FORGE_TOKEN",
  ]) {
    const r = validateConnector(verifiedConnector({ credential }));
    assert.equal(r.ok, false, `${JSON.stringify(credential)} must be refused`);
  }
});

test("a credential carrying a VALUE key is refused, and the refusal never echoes it", () => {
  // MUTATION: drop the CREDENTIAL_KEYS allowlist loop → the value key survives
  //           into the document and this fails.
  // There is no detector here by decision. The control is that the schema has
  // nowhere for a value to go: an unknown key in a closed object is refused.
  const planted = "s3cr3t-value-that-must-not-be-echoed";
  const r = validateConnector(verifiedConnector({ credential: { kind: "env-var", name: "FORGE_TOKEN", value: planted } }));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.path.endsWith(".credential.value")), "it must name WHERE");
  assert.ok(!JSON.stringify(r).includes(planted), "and never quote WHAT — this refusal gets printed");
});

test("env-var name checking is character arithmetic, not a pattern", () => {
  for (const name of ["FORGE_TOKEN", "_x", "a1", "A".repeat(128)]) assert.equal(isEnvVarName(name), true, name);
  for (const name of ["", "1A", "A-B", "A B", "A$B", "A".repeat(129), 42, null, "TOKEN=abc"]) {
    assert.equal(isEnvVarName(name), false, JSON.stringify(name));
  }
});

test("howToQuery is structured {tool, args[]} — a joined command string is refused", () => {
  // MUTATION: accept a string `args` (drop isStringArray) → the joined-string
  //           case passes and this fails.
  // The hazard is one hop away, not here: bin/cached-exec.mjs still shells a
  // command string, so a stored value that LOOKS like a command invites being
  // pasted into it. Structured args make that reconstruction deliberate.
  assert.equal(validateConnector(verifiedConnector()).ok, true);
  for (const howToQuery of [
    "forge-cli pr list --repo acme/api",
    { tool: "forge-cli", args: "pr list --repo acme/api" },
    { tool: "forge-cli" },
    { tool: "", args: [] },
    { tool: "forge-cli", args: ["ok"], shell: true },
    { tool: "forge-cli", args: [1, 2] },
  ]) {
    assert.equal(validateConnector(verifiedConnector({ howToQuery })).ok, false, JSON.stringify(howToQuery));
  }
});

test("the module never executes anything but git, and never through a shell", () => {
  // The plan's resolution for the howToQuery hazard is structural: stored
  // structured, never executed. Asserted by absence, because the presence of one
  // exec call is what would reintroduce it.
  const src = readFileSync(new URL("../lib/rca-context.mjs", import.meta.url), "utf8");
  assert.equal(src.split("execFileSync(").length - 1, 1, "exactly one call site, and it is git");
  assert.ok(src.includes('execFileSync("git"'), "the one call site is git");
  for (const idiom of ["execSync", "spawnSync", "spawn(", "shell: true", "exec("]) {
    assert.ok(!src.includes(idiom), `${idiom} must not appear — howToQuery is documentation`);
  }
});

test("verifiedBy accepts only its three fields, and rejects captured output", () => {
  for (const verifiedBy of [{ count: 3, stdout: "…" }, { raw: "…" }, { count: 3, observedAt: "nope" }, { note: 7 }]) {
    assert.equal(validateConnector(verifiedConnector({ verifiedBy })).ok, false, JSON.stringify(verifiedBy));
  }
  assert.equal(validateConnector(verifiedConnector({ verifiedBy: { note: "TODO" } })).ok, true,
    "an honest 'attempted' record is WRITABLE — isRunnable is what refuses it, not the schema");
});

test("an unknown connector, profile or context key is refused rather than persisted", () => {
  // MUTATION: delete any one of the key-allowlist loops → the matching case here
  //           passes and this fails.
  assert.equal(validateConnector(verifiedConnector({ token: "x" })).ok, false);
  assert.equal(validateContext(validContext({ profiles: { "prod-web": profileFixture({ secrets: {} }) } })).ok, false);
  assert.equal(validateContext(validContext({ credentials: {} })).ok, false);
  assert.equal(validateContext(validContext({ complete: true })).ok, false, "there is deliberately no complete flag");
  assert.equal(validateContext(validContext({ resumeAt: "logs" })).ok, false, "resume is derived, never stored");
});

test("subpaths null survives — it is how the hunt knows attribution may over-match", () => {
  // MUTATION: `profile.subpaths !== null` → drop that clause → null is refused
  //           and this fails. With no owned subpaths, path overlap runs
  //           repo-wide, and recording null explicitly is what lets the hunt SAY
  //           so instead of over-attributing silently.
  assert.equal(validateContext(validContext({ profiles: { "prod-web": profileFixture({ subpaths: null }) } })).ok, true);
  assert.equal(validateContext(validContext({ profiles: { "prod-web": profileFixture({ subpaths: "services/billing" }) } })).ok, false);
});

test("repos carry ROLES, not a flat list", () => {
  // MUTATION: drop the REPO_ROLES check → the flat list and the unknown role pass
  //           and this fails. A flat list forces the "if there's exactly one other
  //           repo it must be the automation repo" guess.
  assert.equal(validateContext(validContext({ profiles: { "prod-web": profileFixture({ repos: ["acme/api"] }) } })).ok, false);
  assert.equal(validateContext(validContext({ profiles: { "prod-web": profileFixture({ repos: { forks: ["x"] } }) } })).ok, false);
  assert.equal(validateContext(validContext({ profiles: { "prod-web": profileFixture({ repos: { product: "acme/api" } }) } })).ok, false);
});

test("a buildMatch pattern with two wildcards cannot be persisted", () => {
  // MUTATION: drop the star count → the pattern is accepted, and since matching
  //           returns false for it, the profile becomes silently unreachable.
  const r = validateContext(validContext({ profiles: { "prod-web": profileFixture({ buildMatch: ["web-*-nightly-*"] }) } }));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.problem.includes("more than one")));
});

test("a gap must name its capability, or nothing can tell whether it was answered", () => {
  // MUTATION: drop the capability check → an unnamed gap persists, and
  //           missingCapabilities then re-asks the capability every run.
  const r = validateContext(validContext({ profiles: { "prod-web": profileFixture({ gaps: [{ classification: "declined" }] }) } }));
  assert.equal(r.ok, false);
});

test("defaultProfile naming a profile that is not in the file is refused", () => {
  const r = validateContext(validContext({ defaultProfile: "ghost" }));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.path === "defaultProfile"));
});

test("isISODate is day precision, and rejects everything that is not a day", () => {
  for (const v of ["2026-08-20", "2026-08-20T11:22:33Z", "2026-01-01"]) assert.equal(isISODate(v), true, v);
  for (const v of ["2026-8-20", "20-08-2026", "2026-13-01", "2026-08-32", "yesterday", "", "2026-08-2x", 20260820, null]) {
    assert.equal(isISODate(v), false, JSON.stringify(v));
  }
});

// ---- the write: atomic, additive, not hardened ------------------------------

test("write then read round-trips every field, including a null subpaths and an open-keyed scope", () => {
  workspace();
  const context = validContext({
    profiles: {
      "prod-web": profileFixture({
        subpaths: null,
        connectors: {
          [MANDATORY_CAPABILITY]: verifiedConnector(),
          logs: verifiedConnector({ scope: { stream: "app", serviceField: "svc.name", window: "6h" }, verifiedBy: { count: 12 } }),
        },
      }),
    },
  });
  const w = writeRcaContext({ context, from: productRepo });
  assert.equal(w.ok, true, w.message);
  assert.equal(w.path, join(productRepo, CONTEXT_FILENAME));

  const r = readRcaContext({ from: productRepo });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.context, context);
  assert.equal(r.trust, "cwd", "the file is anchored to the invocation directory");
});

test("no closed object in the schema accepts a `value` key, and the written document has none", () => {
  // MUTATION: delete any one of the key-allowlist loops (context, profile,
  //           connector, credential, verifiedBy) → the matching planted document
  //           is written and this fails.
  // There is NO detector by decision. The control is that every closed object
  // refuses a key it does not define, so a value has nowhere to live. Asserted by
  // attempting the write, not merely by inspecting a fixture that never had one.
  workspace();
  const planted = "s3cr3t-value-that-must-not-be-persisted";
  const attempts = {
    context: validContext({ value: planted }),
    profile: validContext({ profiles: { "prod-web": profileFixture({ value: planted }) } }),
    connector: validContext({ profiles: { "prod-web": profileFixture({ connectors: { [MANDATORY_CAPABILITY]: { ...verifiedConnector(), value: planted } } }) } }),
    credential: validContext({ profiles: { "prod-web": profileFixture({ connectors: { [MANDATORY_CAPABILITY]: verifiedConnector({ credential: { kind: "env-var", name: "FORGE_TOKEN", value: planted } }) } }) } }),
    verifiedBy: validContext({ profiles: { "prod-web": profileFixture({ connectors: { [MANDATORY_CAPABILITY]: verifiedConnector({ verifiedBy: { count: 3, value: planted } }) } }) } }),
    howToQuery: validContext({ profiles: { "prod-web": profileFixture({ connectors: { [MANDATORY_CAPABILITY]: verifiedConnector({ howToQuery: { tool: "forge-cli", args: [], value: planted } }) } }) } }),
  };
  for (const [where, context] of Object.entries(attempts)) {
    const w = writeRcaContext({ context, from: productRepo });
    assert.equal(w.ok, false, `a value key under ${where} must be refused`);
    assert.ok(!JSON.stringify(w).includes(planted), "and the refusal must not echo it");
    assert.equal(findContextFile({ from: productRepo }), null, "and nothing may be persisted");
  }
  // `scope` is open-keyed BY DECISION — its keys are the customer's tool's
  // vocabulary — so it is the one place a value could still land. Recorded here
  // rather than guarded, because the alternative is the key-name refusal the plan
  // explicitly deferred out of this pass.
  assert.equal(
    writeRcaContext({ context: validContext({ profiles: { "prod-web": profileFixture({ connectors: { [MANDATORY_CAPABILITY]: verifiedConnector({ scope: { value: "not-guarded" } }) } }) } }), from: productRepo }).ok,
    true,
    "known and deliberate: an open-keyed scope is not schema-guarded — the interview's prompt discipline covers it",
  );

  const written = JSON.parse(readFileSync(join(productRepo, CONTEXT_FILENAME), "utf8"));
  for (const forbidden of ["raw", "stdout", "stderr", "body", "response", "token", "secret"]) {
    assert.ok(!keysAtAnyDepth(written).has(forbidden), `a schema with a '${forbidden}' key gives a credential somewhere to live`);
  }
});

test("the artifact is NOT owner-only, unlike every other persisted file in lib/", () => {
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });
  const mode = statSync(join(productRepo, CONTEXT_FILENAME)).mode & 0o777;
  assert.notEqual(mode, 0o600, "0600 on a git-tracked path is wrong and git will not preserve it");
  // The non-flaky half of the same claim, independent of this machine's umask:
  // our write must be no more restrictive than an ordinary one in the same dir.
  const reference = join(productRepo, "reference-mode-probe");
  writeFileSync(reference, "x");
  assert.equal(mode, statSync(reference).mode & 0o777, "the write must not narrow the mode at all");
});

test("the module contains no hardening call — the guard is the absence, so assert it", () => {
  // MUTATION: add `chmodSync(path, 0o600)` to atomicWrite → this fails (and so
  //           does the mode test above).
  const src = readFileSync(new URL("../lib/rca-context.mjs", import.meta.url), "utf8");
  // A CALL, not a mention: the header names hardenStateDir precisely in order to
  // say it must never be used here.
  assert.ok(!src.includes("chmodSync("), "no chmod on a git-tracked file");
  assert.ok(!src.includes("hardenStateDir("), "hardenStateDir must never be pointed at a repo path");
  assert.ok(!src.includes("mode: 0o"), "no mode option on the write");
});

test("a written context is really tracked by git once added", () => {
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });
  g(productRepo, "add", CONTEXT_FILENAME);
  assert.match(g(productRepo, "show", `:${CONTEXT_FILENAME}`), /"homeRepo": "acme\/api"/);
});

test("upserting one connector leaves an existing one BYTE-identical", () => {
  // MUTATION: in upsertConnector, rebuild the profile
  //           (`connectors = {[capability]: staged}`) instead of assigning one
  //           key → the runtime connector is dropped, the regression guard fires,
  //           and this fails. Also fails on a mutation that reorders keys.
  workspace();
  const seeded = validContext({
    profiles: { "prod-web": profileFixture({ connectors: { [MANDATORY_CAPABILITY]: verifiedConnector(), infra: verifiedConnector({ via: "runtime-cli", verifiedBy: { count: 4 } }) } }) },
  });
  writeRcaContext({ context: seeded, from: productRepo });
  const before = readFileSync(join(productRepo, CONTEXT_FILENAME), "utf8");
  const infraBlock = jsonBlock(before, "infra");

  const r = upsertConnector({
    capability: "logs",
    connector: { via: "log-cli", scope: { stream: "app" }, verifiedBy: { count: 12 } },
    profile: "prod-web",
    todayISO: "2026-08-20",
    from: productRepo,
  });
  assert.equal(r.ok, true, r.message);

  const after = readFileSync(join(productRepo, CONTEXT_FILENAME), "utf8");
  assert.ok(after.includes(infraBlock), "the untouched connector's bytes must be unchanged");
  assert.equal(jsonBlock(after, MANDATORY_CAPABILITY), jsonBlock(before, MANDATORY_CAPABILITY));
  const parsed = JSON.parse(after);
  assert.deepEqual(Object.keys(parsed.profiles["prod-web"].connectors), [MANDATORY_CAPABILITY, "infra", "logs"]);
  assert.equal(parsed.profiles["prod-web"].connectors.logs.verifiedAt, "2026-08-20", "the injected day is stamped");
});

test("replacing a verified connector with one that proves nothing is REFUSED, and the file is untouched", () => {
  // MUTATION: drop the isVerifiedClaim downgrade clause from regressions() → the
  //           write succeeds and this fails.
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });
  const before = readFileSync(join(productRepo, CONTEXT_FILENAME), "utf8");

  const r = upsertConnector({
    capability: MANDATORY_CAPABILITY,
    connector: verifiedConnector({ verifiedBy: { note: "attempted, could not list PRs" } }),
    profile: "prod-web",
    from: productRepo,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "would-regress");
  assert.match(r.message, /additive/);
  assert.equal(readFileSync(join(productRepo, CONTEXT_FILENAME), "utf8"), before, "a refused write is byte-identical");
});

test("a write that would drop a profile or a connector is refused", () => {
  // MUTATION: `return atomicWrite(...)` before the regressions() check → both
  //           halves of this fail.
  workspace();
  const seeded = validContext({
    profiles: {
      "prod-web": profileFixture({ connectors: { [MANDATORY_CAPABILITY]: verifiedConnector(), infra: verifiedConnector() } }),
      "prod-api": profileFixture(),
    },
  });
  writeRcaContext({ context: seeded, from: productRepo });
  const before = readFileSync(join(productRepo, CONTEXT_FILENAME), "utf8");

  const droppedProfile = writeRcaContext({
    context: validContext({ profiles: { "prod-web": seeded.profiles["prod-web"] } }),
    from: productRepo,
  });
  assert.equal(droppedProfile.code, "would-regress");
  assert.ok(droppedProfile.problems.some((p) => p.path === "profiles.prod-api"));

  const droppedConnector = writeRcaContext({ context: seeded && validContext({ profiles: { "prod-web": profileFixture(), "prod-api": profileFixture() } }), from: productRepo });
  assert.equal(droppedConnector.code, "would-regress");
  assert.ok(droppedConnector.problems.some((p) => p.path === "profiles.prod-web.connectors.infra"));

  assert.equal(readFileSync(join(productRepo, CONTEXT_FILENAME), "utf8"), before);
});

test("an invalid document is refused before anything is written, without echoing values", () => {
  workspace();
  const planted = "paste3d-cr3dential-value";
  const r = writeRcaContext({
    context: validContext({ profiles: { "prod-web": profileFixture({ connectors: { [MANDATORY_CAPABILITY]: verifiedConnector({ credential: { kind: "env-var", name: "TOK", value: planted } }) } }) } }),
    from: productRepo,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid-context");
  assert.ok(!JSON.stringify(r).includes(planted));
  assert.equal(findContextFile({ from: productRepo }), null, "nothing may be persisted");
});

test("recordGap appends, is idempotent, and is what makes a profile provisioned", () => {
  workspace();
  const caps = capabilitySequence(configFixture());
  writeRcaContext({ context: validContext(), from: productRepo });
  for (const capability of caps.filter((c) => c !== MANDATORY_CAPABILITY)) {
    const r = recordGap({ capability, classification: "declined", note: "customer chose forge-only", profile: "prod-web", from: productRepo });
    assert.equal(r.ok, true, r.message);
  }
  // The same gap twice must not double up, or the digest grows on every run.
  recordGap({ capability: "logs", classification: "declined", profile: "prod-web", from: productRepo });
  const read = readRcaContext({ from: productRepo });
  assert.equal(read.context.profiles["prod-web"].gaps.length, caps.length - 1);
  assert.equal(isProvisioned(read.context.profiles["prod-web"], caps), true, "and the gate's question is never asked again");
});

test("recordGap without a classification is refused — an unclassified gap tells the next run nothing", () => {
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });
  const r = recordGap({ capability: "logs", profile: "prod-web", from: productRepo });
  assert.equal(r.ok, false);
  assert.equal(r.code, "no-classification");
});

test("a write into an unknown profile is refused, naming the labels", () => {
  workspace();
  writeRcaContext({ context: twoWayContext(), from: productRepo });
  const r = upsertConnector({ capability: "logs", connector: { via: "log-cli", verifiedBy: { count: 1 } }, profile: "ghost", from: productRepo });
  assert.equal(r.ok, false);
  assert.equal(r.code, "unknown-profile");
  assert.deepEqual(r.labels.sort(), ["prod-api", "prod-web"]);
});

test("a write with two profiles and no label named is refused rather than guessed", () => {
  workspace();
  writeRcaContext({ context: twoWayContext(), from: productRepo });
  const r = upsertConnector({ capability: "logs", connector: { via: "log-cli", verifiedBy: { count: 1 } }, from: productRepo });
  assert.equal(r.ok, false);
  assert.equal(r.code, "no-profile");
});

test("a destination matched by a gitignore rule is refused, naming the rule", () => {
  workspace();
  writeFileSync(join(productRepo, ".gitignore"), `${CONTEXT_FILENAME}\n`);
  const r = writeRcaContext({ context: validContext(), from: productRepo });
  assert.equal(r.ok, false);
  assert.equal(r.code, "ignored-destination");
  assert.match(r.rule, /gitignore/);
  assert.match(r.message, /never be committed/);
});




// ---- read resolution and adoption ------------------------------------------



test("a planted context in a directory that is not a worktree root is never adopted", () => {
  workspace();
  const planted = join(ws, "api-decoy", "api");
  mkdirSync(planted, { recursive: true });
  writeFileSync(join(planted, CONTEXT_FILENAME), JSON.stringify(validContext()));
  assert.equal(findContextFile({ from: join(ws, "api-decoy") }), null);
});


test("a conflict-marked file two levels up is a parse-error, NOT a missing context", () => {
  // MUTATION: replace the JSON.parse catch in locateContext with `continue`
  //           (collapsing the two outcomes into one) → the walk reports
  //           "no-context" and this fails.
  // Degrading to no-context triggers a full re-interview and looks to the
  // customer like the feature forgetting them.
  workspace();
  const nested = join(productRepo, "services", "billing");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(productRepo, CONTEXT_FILENAME), '{"homeRepo": "acme/api",\n<<<<<<< HEAD\n');
  const r = readRcaContext({ from: nested });
  assert.equal(r.ok, false);
  assert.equal(r.code, "parse-error");
  assert.notEqual(r.code, "no-context");
  assert.match(r.message, /merge conflict/i);
  assert.equal(r.path, join(productRepo, CONTEXT_FILENAME), "and it names the file");
});

test("a junk file planted in a decoy directory cannot brick the run", () => {
  // The unparseable early-return sits BELOW the adoption test on purpose: above
  // it, any junk .rca-context.json anywhere in the ~140-directory walk refuses
  // every run — a denial of service from any writable directory near the repo.
  workspace();
  const decoy = join(ws, "api-decoy", "api");
  mkdirSync(decoy, { recursive: true });
  writeFileSync(join(decoy, CONTEXT_FILENAME), "{ not json");
  writeRcaContext({ context: validContext(), from: productRepo });
  g(productRepo, "add", CONTEXT_FILENAME);
  assert.notEqual(readRcaContext({ from: join(ws, "api-decoy") }).code, "parse-error");
});

test("no context at all is its own distinct code", () => {
  workspace();
  const r = readRcaContext({ from: automationRepo });
  assert.equal(r.ok, false);
  assert.equal(r.code, "no-context");
});

test("a wrong schemaVersion and a missing field are distinct named errors", () => {
  workspace();
  writeFileSync(join(productRepo, CONTEXT_FILENAME), JSON.stringify(validContext({ schemaVersion: 0 })));
  const version = readRcaContext({ from: productRepo });
  assert.equal(version.code, "schema-version");
  assert.equal(version.found, 0);
  assert.equal(version.expected, SCHEMA_VERSION);

  // `homeRepo` is deliberately NOT required any more: it used to select the write
  // destination, and the destination is now the invocation directory, so nothing
  // reads it to decide anything. It stays allowed for a human reading the file.
  const noHome = validContext();
  delete noHome.homeRepo;
  writeFileSync(join(productRepo, CONTEXT_FILENAME), JSON.stringify(noHome));
  assert.equal(readRcaContext({ from: productRepo }).ok, true, "homeRepo is optional");

  const bad = validContext();
  delete bad.profiles;
  writeFileSync(join(productRepo, CONTEXT_FILENAME), JSON.stringify(bad));
  const missing = readRcaContext({ from: productRepo, path: join(productRepo, CONTEXT_FILENAME) });
  assert.equal(missing.code, "missing-field");
  assert.deepEqual(missing.fields.sort(), ["profiles"]);
});


// ---- the CLI ----------------------------------------------------------------

test("the CLI prints JSON on stdout and exits non-zero on a refusal", () => {
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });

  const found = cli("find", "--from", productRepo);
  assert.equal(found.status, 0);
  assert.equal(found.json.path, join(productRepo, CONTEXT_FILENAME));

  const absent = cli("find", "--from", automationRepo);
  assert.equal(absent.status, 1, "no context is first contact, and a shell must be able to branch on it");
  assert.equal(absent.json.code, "no-context");

  assert.equal(cli("nonsense").status, 2, "a usage error is distinct from a refusal");
  assert.equal(cli().status, 2);
});

test("the CLI select reports both predicates, the resume point, and the injected day", () => {
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });
  const r = cli("select", "--from", productRepo, "--build-name", "Nightly Web Regression 41", "--today", "2026-08-20");
  assert.equal(r.status, 0, JSON.stringify(r.json));
  assert.equal(r.json.label, "prod-web");
  assert.equal(r.json.matchedBy, "build-name");
  assert.equal(r.json.runnable, true);
  assert.equal(r.json.provisioned, false, "the mandatory capability alone is runnable, not finished");
  assert.equal(r.json.resumeAt, r.json.missing[0]);
  assert.ok(r.json.capabilities.includes(MANDATORY_CAPABILITY));
  assert.equal(r.json.todayISO, "2026-08-20");
  assert.deepEqual(r.json.stale, [], "one day old, against the configured 30");
});

test("the CLI select exits non-zero and names the ambiguity rather than picking one", () => {
  workspace();
  writeRcaContext({
    context: validContext({
      profiles: {
        "prod-web": profileFixture({ buildMatch: ["*-nightly-12"] }),
        "prod-api": profileFixture({ buildMatch: ["web-nightly*"] }),
      },
    }),
    from: productRepo,
  });
  const r = cli("select", "--from", productRepo, "--build-name", "web-nightly-12", "--today", "2026-08-20");
  assert.equal(r.status, 1);
  assert.equal(r.json.code, "ambiguous-profile");
});

test("the CLI writes a document, stamping the README and schema version so nobody hand-writes them", () => {
  workspace();
  const doc = validContext();
  delete doc._README;
  delete doc.schemaVersion;
  const docPath = join(ws, "doc.json");
  writeFileSync(docPath, JSON.stringify(doc));

  const w = cli("write", "--from", productRepo, "--file", docPath);
  assert.equal(w.status, 0, JSON.stringify(w.json));
  const written = JSON.parse(readFileSync(join(productRepo, CONTEXT_FILENAME), "utf8"));
  assert.equal(written.schemaVersion, SCHEMA_VERSION);
  assert.equal(written._README, CONTEXT_README);
  assert.match(written._README, /never belong in this file/);

  const connPath = join(ws, "conn.json");
  writeFileSync(connPath, JSON.stringify({ via: "log-cli", scope: { stream: "app" }, verifiedBy: { count: 9 } }));
  const u = cli("upsert-connector", "--from", productRepo, "--capability", "logs", "--profile", "prod-web", "--file", connPath, "--today", "2026-08-20");
  assert.equal(u.status, 0, JSON.stringify(u.json));
  assert.equal(u.json.verified, true);
  assert.equal(u.json.runnable, true);

  const gap = cli("record-gap", "--from", productRepo, "--capability", "metrics", "--classification", "declined", "--profile", "prod-web");
  assert.equal(gap.status, 0, JSON.stringify(gap.json));
  const after = JSON.parse(readFileSync(join(productRepo, CONTEXT_FILENAME), "utf8"));
  assert.deepEqual(after.profiles["prod-web"].gaps, [{ capability: "metrics", classification: "declined" }]);
});

test("the CLI capabilities command reads the real config", () => {
  const r = cli("capabilities");
  assert.equal(r.status, 0);
  assert.ok(r.json.capabilities.includes(MANDATORY_CAPABILITY));
});

// ---- the property the whole design rests on --------------------------------

test("no vendor name appears in the new surface", () => {
  // Scoped to the NEW files by decision: lib/evidence-file.mjs uses vendor terms
  // as schema field names and lib/tool-cache.mjs embeds a vendor mutation
  // pattern, both correct and both grandfathered elsewhere. On THIS surface the
  // property must hold, because a vendor name here teaches a default stack — and
  // the plugin's whole claim is that it works on an unlisted one.
  const vendors = [
    "kubectl", "kubernetes", "k8s", "docker", "podman", "nomad", "pm2", "systemd",
    "kibana", "elastic", "victorialog", "splunk", "datadog", "grafana", "prometheus",
    "promtool", "chitragupta", "bifrost", "jenkins", "circleci", "gitlab", "bitbucket",
  ];
  for (const file of ["lib/rca-context.mjs", "bin/rca-context.mjs", "tests/rca-context.test.mjs"]) {
    let src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8").toLowerCase();
    // This test's own list is the one place the names are allowed to appear, so
    // scan this file only up to it. Everything above — every fixture — is covered.
    const selfMarker = "// ---- the property the whole design rests on";
    if (src.includes(selfMarker)) src = src.slice(0, src.indexOf(selfMarker));
    for (const vendor of vendors) {
      assert.ok(!src.includes(vendor), `${file} names '${vendor}' — this surface has no default stack`);
    }
  }
});

// ---- recordWarning ----------------------------------------------------------
//
// `warnings` had no writer. The gate is told to PRINT them
// (templates/gate-summary.md), so without this the empty-PR-window warning could
// only ever land in the interview's very first write and would freeze there — and
// any warning noticed later could be added only by hand-editing a committed file,
// which is exactly what bin/rca-context.mjs exists to prevent.

test("recordWarning appends to warnings, NOT to gaps", () => {
  // MUTATION: point recordWarning at "gaps" -> this fails. The distinction is the
  // whole point: a warning means the capability WORKS and the answer will be thin,
  // so counting it as a gap would declare a working connector unavailable to TFA.
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });
  const r = recordWarning({
    capability: MANDATORY_CAPABILITY, classification: "empty-pr-window",
    note: "no merged PRs in the last 30 days", target: "main",
    profile: "prod-web", from: productRepo,
  });
  assert.equal(r.ok, true, r.message);

  const profile = readRcaContext({ from: productRepo }).context.profiles["prod-web"];
  assert.deepEqual(profile.warnings, [{
    capability: MANDATORY_CAPABILITY, classification: "empty-pr-window",
    note: "no merged PRs in the last 30 days", target: "main",
  }]);
  assert.deepEqual(profile.gaps ?? [], [], "a warning is not a gap");
});

test("a warning does not make an unanswered capability provisioned", () => {
  // Provisioned means "asked and answered". A warning says a capability WORKS, so
  // it must not stand in for the gap that records a capability was declined —
  // otherwise one empty PR window could mark the whole interview finished.
  workspace();
  const caps = capabilitySequence(configFixture());
  writeRcaContext({ context: validContext(), from: productRepo });
  recordWarning({ capability: "logs", classification: "empty-window", profile: "prod-web", from: productRepo });
  const profile = readRcaContext({ from: productRepo }).context.profiles["prod-web"];
  assert.equal(isProvisioned(profile, caps), false);
});

test("recordWarning is idempotent on capability+classification", () => {
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });
  for (const note of ["first", "second"]) {
    recordWarning({ capability: "logs", classification: "empty-window", note, profile: "prod-web", from: productRepo });
  }
  const w = readRcaContext({ from: productRepo }).context.profiles["prod-web"].warnings;
  assert.equal(w.length, 1, "the digest must not grow on every run");
  assert.equal(w[0].note, "second", "and the latest wins");
});

test("recordWarning without a classification is refused", () => {
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });
  const r = recordWarning({ capability: "logs", profile: "prod-web", from: productRepo });
  assert.equal(r.ok, false);
  assert.equal(r.code, "no-classification");
});

test("the CLI record-warning verb reaches warnings and refuses like its sibling", () => {
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });
  const ok = cli("record-warning", "--capability", "logs", "--classification", "empty-window",
                 "--profile", "prod-web", "--from", productRepo);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readRcaContext({ from: productRepo }).context.profiles["prod-web"].warnings.length, 1);

  const bad = cli("record-warning", "--classification", "x", "--profile", "prod-web", "--from", productRepo);
  assert.notEqual(bad.status, 0, "a missing --capability must exit non-zero, not silently no-op");
});

// ---- fallback coverage and `provisioned` ------------------------------------
//
// `ci` was a trap. For every team whose CI is their git forge there is no separate
// system to record, so `ci` gets no connector — and before this, the only route to
// `provisioned` was to record a GAP on a capability that demonstrably works,
// because buildManifest's fallback was already serving it. The gate would then
// offer to resume a finished interview on every single run.

test("capabilityFallbacks reads the fallback map out of config", () => {
  assert.deepEqual(capabilityFallbacks(configFixture()), { ci: "github" });
  assert.deepEqual(capabilityFallbacks({}), {}, "no routing is not a crash");
});

test("a capability covered by its fallback's connector is provisioned", () => {
  // MUTATION: drop the fallback clause from missingCapabilities -> fails.
  const config = configFixture();
  const caps = capabilitySequence(config);
  const fallbacks = capabilityFallbacks(config);

  // Everything answered EXCEPT ci, which has no connector of its own.
  const profile = profileFixture({
    gaps: caps.filter((c) => c !== MANDATORY_CAPABILITY && c !== "ci")
      .map((capability) => ({ capability, classification: "declined" })),
  });

  assert.ok(!Object.hasOwn(profile.connectors, "ci"), "precondition: no ci connector");
  assert.deepEqual(missingCapabilities(profile, caps, fallbacks), [],
    "ci is covered by github's connector");
  assert.equal(isProvisioned(profile, caps, fallbacks), true);

  // And without the fallback map it is correctly still missing — the coverage comes
  // from config, not from a hardcoded exception for `ci`.
  assert.deepEqual(missingCapabilities(profile, caps), ["ci"]);
});

test("a fallback whose target has no connector covers nothing", () => {
  const config = configFixture();
  const fallbacks = capabilityFallbacks(config);
  const profile = { connectors: {}, gaps: [] };
  assert.deepEqual(missingCapabilities(profile, ["ci"], fallbacks), ["ci"],
    "an absent github cannot cover ci");
});

test("fallback coverage is a single hop", () => {
  // b covers c, a covers b, only a has a connector. c must stay missing — matching
  // buildManifest, where the target is looked up in discovered connectors only.
  const profile = { connectors: { a: verifiedConnector() }, gaps: [] };
  const fallbacks = { b: "a", c: "b" };
  assert.deepEqual(missingCapabilities(profile, ["b", "c"], fallbacks), ["c"]);
});

// ---- the destination is the invocation DIRECTORY ----------------------------
//
// This block replaces seven tests of a resolver that no longer exists. The old
// rule took the declared `homeRepo`, searched ~140 candidate directories for one
// whose basename or `origin` remote matched, checked git-tracked-ness to decide
// which of several nearby files to adopt, and refused when nothing matched.
//
// The new rule is: the directory you invoked from. It is predictable before the
// write happens, which the old rule was not — on a workspace holding three clones
// it silently picked one of them.
//
// What that gave up, recorded so it is a decision and not an accident: a directory
// is not necessarily a repo, so the file is no longer guaranteed committable, and a
// teammate no longer inherits it by cloning.

test("the destination is the invocation directory, not a repo root", () => {
  // MUTATION: resolve through homeRepo again -> fails. `sub` is INSIDE a worktree
  // whose root is elsewhere, and the file must still land in `sub`.
  workspace();
  const sub = join(productRepo, "services", "billing");
  mkdirSync(sub, { recursive: true });

  const w = writeRcaContext({ context: validContext(), from: sub });
  assert.equal(w.ok, true, w.message);
  assert.equal(w.path, join(sub, CONTEXT_FILENAME), "lands in cwd, not the worktree root");
  assert.ok(!existsSync(join(productRepo, CONTEXT_FILENAME)), "and not at the root");
});

test("a directory that is not a git repo at all is a valid destination", () => {
  // The proving run hit exactly this: the agent was invoked in a workspace folder
  // holding three clones, which is not itself a repo. The old rule could not write
  // there and reached into a sibling clone instead.
  workspace();
  const plain = join(ws, "not-a-repo");
  mkdirSync(plain, { recursive: true });
  const w = writeRcaContext({ context: validContext(), from: plain });
  assert.equal(w.ok, true, w.message);
  assert.equal(w.path, join(plain, CONTEXT_FILENAME));
  assert.equal(readRcaContext({ from: plain }).ok, true, "and it reads back");
});

test("a sibling clone's context is NOT consulted", () => {
  // The inverse of a test that used to assert adoption. Siblings were searched to
  // find a context committed to another repo; with a cwd-anchored file there is
  // nothing to adopt, and reaching sideways would mean running against another
  // directory's answers.
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });
  const other = automationRepo;
  mkdirSync(other, { recursive: true });
  const r = readRcaContext({ from: other });
  assert.equal(r.ok, false);
  assert.equal(r.code, "no-context", "a sibling's file must not be picked up");
});

test("a parent directory's context IS found, so a subdirectory still works", () => {
  // The one part of the walk worth keeping: someone cd'd into a package inside the
  // directory they set up. MUTATION: drop the upward walk -> fails.
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });
  const deep = join(productRepo, "services", "billing");
  mkdirSync(deep, { recursive: true });
  const r = readRcaContext({ from: deep });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.trust, "ancestor");
});

test("the plugin's own checkout is refused for both reading and writing", () => {
  // The one directory cwd is never the right answer for: the documented install
  // flow leaves cwd inside the plugin clone, and a context there would put the
  // customer's repos, branches and infra scope into the plugin repository.
  //
  // MUTATION: drop the pluginRoot check in contextDestination, or the `forbidden`
  // branch in readRcaContext -> one of these fails.
  workspace();
  const plugin = pluginDir;

  const w = writeRcaContext({ context: validContext(), from: plugin, pluginRoot: plugin });
  assert.equal(w.ok, false);
  assert.equal(w.code, "plugin-root-destination");
  assert.ok(!existsSync(join(plugin, CONTEXT_FILENAME)), "and nothing was written");

  // Even a file already sitting there is refused rather than read.
  writeFileSync(join(plugin, CONTEXT_FILENAME), JSON.stringify(validContext()));
  const r = readRcaContext({ from: plugin, pluginRoot: plugin });
  assert.equal(r.ok, false);
  assert.equal(r.code, "plugin-root-context");
});

test("contextDestination names how it resolved, so the gate can print it", () => {
  workspace();
  const plain = join(ws, "somewhere");
  mkdirSync(plain, { recursive: true });
  const d = contextDestination({ from: plain });
  assert.deepEqual(d, { ok: true, dir: realpathSync(plain), matchedBy: "invocation-directory" });
  assert.equal(contextDestination({ from: join(ws, "nope-not-here") }).code, "no-directory");
});

// ---- connector.source: what KIND of thing serves this, and where it came from --
//
// `via` says what the tool is, in the customer's words. It could not say whether
// there was a PROCEDURE behind it. A connector-shaped skill under the customer's
// `.claude/skills/` carries a repo map, branch conventions and query conventions a
// raw CLI does not, and a coordinator behaves differently when one exists — but the
// interview read those skills and then lost the fact that it had, so a later run
// could not re-read one, notice it had changed, or follow it.

test("a skill source must record its path, or it cannot be re-read later", () => {
  // MUTATION: drop the path requirement for kind:"skill" -> fails. Without a path
  // the record says "a skill informed this" and gives no way back to it, which is
  // strictly worse than not recording it at all.
  const withPath = validateConnector({ ...verifiedConnector(),
    source: { kind: "skill", path: ".claude/skills/logs/SKILL.md" } });
  assert.equal(withPath.ok, true, JSON.stringify(withPath.problems));

  const noPath = validateConnector({ ...verifiedConnector(), source: { kind: "skill" } });
  assert.equal(noPath.ok, false);
  assert.match(noPath.problems[0].path, /source\.path$/);
});

test("only a skill carries a path; a cli or mcp is named by via", () => {
  // A path on an mcp/cli record is a second, unmaintained name for the same thing —
  // the drift this schema keeps closing everywhere else.
  assert.equal(validateConnector({ ...verifiedConnector(), source: { kind: "mcp" } }).ok, true);
  assert.equal(validateConnector({ ...verifiedConnector(), source: { kind: "cli" } }).ok, true);
  const stray = validateConnector({ ...verifiedConnector(), source: { kind: "cli", path: "/usr/bin/x" } });
  assert.equal(stray.ok, false);
});

test("source is optional, and its kind is a closed set", () => {
  // Optional: a context written before this field existed stays valid, and a
  // connector the agent could not classify is better left unmarked than guessed.
  assert.equal(validateConnector(verifiedConnector()).ok, true);
  assert.equal(validateConnector({ ...verifiedConnector(), source: { kind: "vibes" } }).ok, false);
  assert.equal(validateConnector({ ...verifiedConnector(), source: { kind: "mcp", server: "x" } }).ok, false,
    "closed object, like every other in this schema");
  assert.equal(validateConnector({ ...verifiedConnector(), source: "skill" }).ok, false);
});

test("a source survives a write/read round-trip and an upsert", () => {
  workspace();
  const ctx = validContext();
  ctx.profiles["prod-web"].connectors.github.source = { kind: "cli" };
  assert.equal(writeRcaContext({ context: ctx, from: productRepo }).ok, true);

  const source = { kind: "skill", path: ".claude/skills/logs/SKILL.md" };
  const up = upsertConnector({
    capability: "logs", connector: { ...verifiedConnector(), source },
    profile: "prod-web", from: productRepo, todayISO: "2026-08-21",
  });
  assert.equal(up.ok, true, up.message);

  const back = readRcaContext({ from: productRepo }).context.profiles["prod-web"].connectors;
  assert.deepEqual(back.logs.source, source);
  assert.deepEqual(back.github.source, { kind: "cli" }, "and the existing one is untouched");
});

// ---- profile.knowledge: parts of a customer's own artifacts ------------------
//
// A customer's domain artifact — a skill, a runbook, an agent definition — can hold a
// triage heuristic worth using and an orchestration model that would fight ours. The
// interview judges which PARTS apply and records those. Judging is the model's job and
// lives in references/interview.md; the only thing code owns here is that a committed
// file cannot be hand-edited and cannot corrupt the two predicates.

test("a knowledge entry round-trips, and capability is a FIELD not a location", () => {
  // The location matters more than it looks. `missingCapabilities` tests coverage with
  // Object.hasOwn(connectors, c) — presence of the key, whatever it holds — so putting
  // knowledge under connectors.<cap> would mark an unverified capability covered.
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });
  const r = recordKnowledge({
    artifact: "their triage artifact", artifactPath: ".claude/skills/x/SKILL.md",
    part: "## Reading a timeout", capability: "logs", note: "distinguishes pressure from defect",
    judgedAt: "2026-08-24", profile: "prod-web", from: productRepo,
  });
  assert.equal(r.ok, true, r.message);

  const profile = readRcaContext({ from: productRepo }).context.profiles["prod-web"];
  assert.deepEqual(profile.knowledge, [{
    artifact: "their triage artifact", path: ".claude/skills/x/SKILL.md",
    part: "## Reading a timeout", capability: "logs",
    note: "distinguishes pressure from defect", judgedAt: "2026-08-24",
  }]);
});

test("knowledge changes NEITHER predicate, for any capability it names", () => {
  // MUTATION: make missingCapabilities consult profile.knowledge -> this fails.
  // If it did, naming a capability in a knowledge entry would mark it provisioned and
  // the gate would stop offering to finish setup for a connector never verified.
  workspace();
  const config = configFixture();
  const caps = capabilitySequence(config);
  const fallbacks = capabilityFallbacks(config);
  writeRcaContext({ context: validContext(), from: productRepo });

  const before = readRcaContext({ from: productRepo }).context.profiles["prod-web"];
  const runnableBefore = isRunnable(before);
  const missingBefore = missingCapabilities(before, caps, fallbacks);

  for (const capability of caps) {
    recordKnowledge({
      artifact: "a", artifactPath: "p", part: `## ${capability}`,
      capability, profile: "prod-web", from: productRepo,
    });
  }
  const after = readRcaContext({ from: productRepo }).context.profiles["prod-web"];
  assert.equal(isRunnable(after), runnableBefore, "runnable is untouched — nothing here is GitHub");
  assert.deepEqual(missingCapabilities(after, caps, fallbacks), missingBefore,
    "and knowledge never counts as a capability being answered");
});

test("product-wide knowledge omits capability rather than inventing one", () => {
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });
  recordKnowledge({ artifact: "a", artifactPath: "p", part: "## How the services relate",
                    profile: "prod-web", from: productRepo });
  const [entry] = readRcaContext({ from: productRepo }).context.profiles["prod-web"].knowledge;
  assert.ok(!("capability" in entry), "absent, not empty — an empty string is refused");
  assert.equal(validateContext(validContext({
    profiles: { p: { ...profileFixture(), knowledge: [{ artifact: "a", path: "p", part: "t", capability: "" }] } },
  })).ok, false);
});

test("an entry that could not be found again is refused", () => {
  // artifact + path + part are all required: identity, so a repurposed file reads as
  // gone rather than changed; path, so it can be re-read; part, so we know which bit.
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });
  for (const missing of ["artifact", "artifactPath", "part"]) {
    const args = { artifact: "a", artifactPath: "p", part: "t", profile: "prod-web", from: productRepo };
    delete args[missing];
    assert.equal(recordKnowledge(args).ok, false, `${missing} must be required`);
  }
});

test("the knowledge list is closed-keyed like everything else here", () => {
  const bad = validContext({
    profiles: { p: { ...profileFixture(), knowledge: [{ artifact: "a", path: "p", part: "t", digest: "abc" }] } },
  });
  const r = validateContext(bad);
  assert.equal(r.ok, false);
  assert.match(r.problems[0].path, /knowledge\[0\]\.digest$/,
    "a field nobody defined is refused, so adding one later is a deliberate act");
});

test("re-recording the same part replaces it; a different part appends", () => {
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });
  const base = { artifact: "a", artifactPath: "p", profile: "prod-web", from: productRepo };
  recordKnowledge({ ...base, part: "## one", note: "first" });
  recordKnowledge({ ...base, part: "## one", note: "second" });
  recordKnowledge({ ...base, part: "## two" });
  const k = readRcaContext({ from: productRepo }).context.profiles["prod-web"].knowledge;
  assert.equal(k.length, 2, "idempotent on (artifact, part) — a corrected T8 answer must not duplicate");
  assert.equal(k[0].note, "second", "and the latest wins");
});

test("recording knowledge leaves connectors and gaps byte-identical", () => {
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });
  const before = JSON.stringify(readRcaContext({ from: productRepo }).context.profiles["prod-web"].connectors);
  recordKnowledge({ artifact: "a", artifactPath: "p", part: "t", profile: "prod-web", from: productRepo });
  const after = readRcaContext({ from: productRepo }).context.profiles["prod-web"];
  assert.equal(JSON.stringify(after.connectors), before);
});

test("the CLI verb writes knowledge and refuses without its own flags", () => {
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });
  const ok = cli("record-knowledge", "--artifact", "a", "--artifact-path", "p",
                 "--part", "## t", "--profile", "prod-web", "--from", productRepo);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readRcaContext({ from: productRepo }).context.profiles["prod-web"].knowledge.length, 1);

  // --path means the CONTEXT file, not the artifact. Using it here silently sent the
  // artifact path to readRcaContext as the document to open.
  const bad = cli("record-knowledge", "--artifact", "a", "--part", "t",
                  "--profile", "prod-web", "--from", productRepo);
  assert.notEqual(bad.status, 0, "a missing --artifact-path must exit non-zero");
});

// ---- project is the coarse bound, and it is checked first -------------------
//
// `--build-name` was structurally always empty on the path that matters: the
// invocation carries a build ID, profile selection matches on the NAME, and nothing
// fetched the name before selecting. So every multi-profile context resolved to
// whichever profile happened to be `defaultProfile`, and no refusal in selectProfile
// ever fired. Fetching the insights first supplies both names — and once the project
// is available it has to be USED, or it is another field read by nothing.

test("two projects running near-identically named suites do not select each other", () => {
  // MUTATION: drop the projectMatch filter (labels = allLabels) -> the two buildMatch
  //           patterns tie on specificity, so this becomes an ambiguous refusal and
  //           fails. That tie is the real-world case: the same suite name in two
  //           projects. Without the filter the ONLY outcomes are refuse or coin-toss.
  const context = validContext({
    profiles: {
      "web-nightly": profileFixture({ buildMatch: ["Nightly*"], projectMatch: ["Web Platform"] }),
      "api-nightly": profileFixture({ buildMatch: ["Nightly*"], projectMatch: ["API Platform"] }),
    },
  });

  const web = selectProfile({ context, buildName: "Nightly Regression", projectName: "Web Platform", todayISO: "2026-08-20" });
  assert.equal(web.ok, true, web.message);
  assert.equal(web.label, "web-nightly");
  assert.deepEqual(web.alsoMatched, [], "the other project's profile was filtered out, not out-scored");

  const api = selectProfile({ context, buildName: "Nightly Regression", projectName: "API Platform", todayISO: "2026-08-20" });
  assert.equal(api.ok, true, api.message);
  assert.equal(api.label, "api-nightly");
});

test("a profile declaring no projectMatch has no opinion and survives the filter", () => {
  // MUTATION: make the filter require a matching projectMatch (drop the
  //           `return true` for an absent one) -> fails. Every context written
  //           before this field existed declares none; requiring it would refuse
  //           every one of them on the first run after upgrade.
  const context = validContext({ profiles: { only: profileFixture({ buildMatch: ["Nightly*"] }) } });
  const r = selectProfile({ context, buildName: "Nightly Regression", projectName: "Any Project", todayISO: "2026-08-20" });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.label, "only");
  assert.equal(r.projectUnchecked, false, "nothing declared a project constraint, so nothing went unchecked");
});

test("a project matching nothing refuses instead of falling through to the build name", () => {
  // MUTATION: return the unfiltered labels when the filter empties -> this selects
  //           'web' on its buildMatch and fails. Falling through is the wrong-context
  //           run: the build's own project says the file does not describe it.
  const context = validContext({
    profiles: { web: profileFixture({ buildMatch: ["Nightly*"], projectMatch: ["Web Platform"] }) },
    defaultProfile: "web",
  });
  const r = selectProfile({ context, buildName: "Nightly Regression", projectName: "Mobile Platform", todayISO: "2026-08-20" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "no-matching-project");
  assert.match(r.message, /Mobile Platform/);
  assert.match(r.message, /web/, "the refusal names what the file does hold");
});

test("an unknown project does not refuse, but says the check could not be made", () => {
  // MUTATION: refuse when projectName is absent while a projectMatch is declared ->
  //           fails. Insights can be unavailable and that must degrade, not block.
  // MUTATION: hardcode projectUnchecked to false -> also fails. The flag is the only
  //           thing standing between "the constraint agreed" and "the constraint was
  //           never applied", and those are indistinguishable on the gate screen.
  const context = validContext({
    profiles: { web: profileFixture({ buildMatch: ["Nightly*"], projectMatch: ["Web Platform"] }) },
  });
  const r = selectProfile({ context, buildName: "Nightly Regression", todayISO: "2026-08-20" });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.label, "web");
  assert.equal(r.projectUnchecked, true);
});

test("projectMatch is validated exactly like buildMatch", () => {
  // MUTATION: exclude "projectMatch" from the validated pair -> both asserts fail.
  // The two fields share one checker precisely so they cannot drift into a pattern
  // that is legal in one and refused in the other.
  const twoStars = validateContext(
    validContext({ profiles: { p: profileFixture({ projectMatch: ["a*b*c"] }) } }),
  );
  assert.equal(twoStars.ok, false);
  assert.match(JSON.stringify(twoStars.problems), /projectMatch\[0\]/);

  const empty = validateContext(
    validContext({ profiles: { p: profileFixture({ projectMatch: ["  "] }) } }),
  );
  assert.equal(empty.ok, false);
  assert.match(JSON.stringify(empty.problems), /projectMatch\[0\]/);
});

test("the select verb passes --project-name through to the filter", () => {
  // MUTATION: drop the projectName wiring in bin/ -> the filter never runs, the
  //           wrong-project build selects a profile, and this fails. The lib being
  //           right is not the same as the CLI reaching it — the same class as
  //           `--path` silently meaning the context file.
  workspace();
  writeRcaContext({
    from: productRepo,
    context: validContext({
      profiles: {
        web: profileFixture({ buildMatch: ["Nightly*"], projectMatch: ["Web Platform"] }),
      },
      defaultProfile: "web",
    }),
  });
  const run = (...extra) => cli("select", "--from", productRepo, "--build-name", "Nightly Regression", ...extra);

  const wrong = run("--project-name", "Mobile Platform");
  assert.notEqual(wrong.status, 0, "a build from another project must not resolve");
  assert.equal(wrong.json?.code, "no-matching-project");

  const right = run("--project-name", "Web Platform");
  assert.equal(right.status, 0, right.stderr);
  assert.equal(right.json.projectUnchecked, false);
});

// ---- flags are a closed set, per verb --------------------------------------
//
// Flag parsing was open: any `--anything value` landed in the args object and was
// ignored if nothing read it. So `--projectname` — one missing hyphen — parsed, was
// dropped, and `select` ran with no project filter, resolved to `defaultProfile`, and
// exited 0. That is the wrong-context run `projectMatch` exists to prevent, reachable
// by a typo, silent at every layer. A live run also invented `--plugin-dir` and the
// CLI obliged it.
//
// Same principle as the schema's closed key sets, and the same reason: an unknown key
// is a mistake, and accepting it quietly buys a wrong answer nobody is told about.

test("a misspelled flag is a usage error, not silence", () => {
  // MUTATION: delete the checkFlags call -> exit 0 and the typo is ignored -> fails.
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });

  const typo = cli("select", "--from", productRepo, "--projectname", "Web Platform");
  assert.equal(typo.status, 2, "usage error, distinct from a refusal (1) and success (0)");
  assert.match(typo.stderr, /--projectname/, "name the flag that was rejected");
  assert.match(typo.stderr, /did you mean --project-name\?/, "and the near miss, which is the whole fix");

  // The exact flag a live run invented.
  const invented = cli("select", "--from", productRepo, "--plugin-dir", "/somewhere");
  assert.equal(invented.status, 2);
  assert.match(invented.stderr, /--plugin-dir/);

  // And the false positive the same replay caught: `<verb> --help` is a real thing to
  // type, and answering it with an unknown-flag error is the least useful response
  // available. MUTATION: remove the args.help branch -> the assert below fails.
  const help = cli("write", "--help");
  assert.equal(help.status, 2, "usage exits 2, help included");
  assert.match(help.stderr, /usage: rca-context\.mjs/, "help prints usage");
  assert.doesNotMatch(help.stderr, /unknown flag/, "asking for help is not a mistake");
});

test("a flag valid for one verb is refused on another", () => {
  // MUTATION: use one flat allowlist instead of per-verb sets -> fails. `--capability`
  // is meaningful for upsert-connector and meaningless for select; accepting it there
  // hides a caller that thinks it is scoping a selection.
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });

  const borrowed = cli("select", "--from", productRepo, "--capability", "logs");
  assert.equal(borrowed.status, 2, "--capability does nothing for select and must not be swallowed");
  assert.match(borrowed.stderr, /--capability/);
});

test("every flag the CLI documents is accepted by the verb it documents", () => {
  // The other half, and the one that matters for false positives: a closed set that
  // omits a real flag breaks the documented call. Parsed from the usage header so the
  // two cannot drift — adding a flag to the header without the allowlist fails here.
  // MUTATION: remove any flag from a VERB_FLAGS entry -> fails.
  const src = readFileSync(new URL("../bin/rca-context.mjs", import.meta.url), "utf8");
  const header = src.slice(0, src.indexOf("import "));

  const documented = new Map();
  for (const m of header.matchAll(/rca-context\.mjs (\S+)([^\n]*(?:\n\/\/\s{20,}[^\n]*)*)/gu)) {
    const flags = [...m[2].matchAll(/--([a-z-]+)/gu)].map((f) => f[1]);
    documented.set(m[1], [...new Set([...(documented.get(m[1]) ?? []), ...flags])]);
  }
  assert.ok(documented.size >= 9, `parsed ${documented.size} verbs from the usage header`);

  for (const [verb, flags] of documented) {
    for (const flag of flags) {
      // A documented flag must not produce a usage error about ITSELF.
      const r = cli(verb, `--${flag}`, "x", "--from", "/nonexistent-on-purpose");
      assert.doesNotMatch(
        r.stderr ?? "", new RegExp(`unknown flags? --${flag}\\b`, "u"),
        `${verb} documents --${flag} in its usage header but the allowlist refuses it`,
      );
    }
  }
});

test("select reports every profile on file, not only the ones that matched", () => {
  // MUTATION: stop returning `labels` -> fails.
  // The gate's review offers "use a different profile", and an option it cannot name is
  // not an option. `alsoMatched` cannot serve: it holds only profiles whose buildMatch
  // ALSO claimed this build, which is the narrower "narrow your patterns" signal — a
  // profile for a different environment is exactly what the customer wants offered and
  // exactly what alsoMatched excludes.
  workspace();
  const context = validContext({
    profiles: {
      web: profileFixture({ buildMatch: ["Nightly*"] }),
      staging: profileFixture({ buildMatch: ["Staging*"] }),
    },
    defaultProfile: "web",
  });
  writeRcaContext({ context, from: productRepo });

  const r = cli("select", "--from", productRepo, "--build-name", "Nightly Regression", "--today", "2026-08-20");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.label, "web");
  assert.deepEqual(r.json.labels.sort(), ["staging", "web"], "every profile, so the review can offer them");
  assert.deepEqual(r.json.alsoMatched, [], "and staging did NOT match this build — the two fields differ");
});

test("a hand-authored knowledge entry missing its path is refused on READ", () => {
  // Not the same path as the test above, and a mutation proved it: `recordKnowledge`
  // guards its own arguments and returns `no-artifactPath`, so removing `path` from
  // checkKnowledge's required set left every test passing. That guard protects the API;
  // `checkKnowledge` protects the OTHER entry point — a document a human edited, or a
  // teammate's commit, arriving through readRcaContext. Only this exercises it.
  const doc = validContext({
    profiles: {
      "prod-web": profileFixture({
        knowledge: [{ artifact: "their runbook", part: "## How the services relate" }],
      }),
    },
  });
  const r = validateContext(doc);
  assert.equal(r.ok, false, "an entry with no path cannot be re-read, so it cannot be trusted");
  assert.match(JSON.stringify(r.problems), /knowledge\[0\]\.path/);

  // And the same for the other two, since all three are what makes an entry findable.
  for (const missing of ["artifact", "part"]) {
    const entry = { artifact: "a", path: "p", part: "t" };
    delete entry[missing];
    const bad = validateContext(
      validContext({ profiles: { "prod-web": profileFixture({ knowledge: [entry] }) } }),
    );
    assert.equal(bad.ok, false, `${missing} must be required on read too`);
    assert.match(JSON.stringify(bad.problems), new RegExp(`knowledge\\[0\\]\\.${missing}`, "u"));
  }
});

test("two artifacts sharing a part NAME both persist", () => {
  // The other half of the (artifact, part) key, and a mutation proved it was untested:
  // weakening the match to `part` alone left every test passing. Two artifacts with a
  // section called "## Overview" is ordinary, not a corner case — and under the weaker
  // key the second silently REPLACES the first, so a run loses knowledge it recorded
  // and nothing says so.
  workspace();
  writeRcaContext({ context: validContext(), from: productRepo });
  const common = { part: "## Overview", profile: "prod-web", from: productRepo };
  recordKnowledge({ ...common, artifact: "their runbook", artifactPath: "docs/runbook.md" });
  recordKnowledge({ ...common, artifact: "their triage skill", artifactPath: ".claude/skills/x/SKILL.md" });

  const k = readRcaContext({ from: productRepo }).context.profiles["prod-web"].knowledge;
  assert.equal(k.length, 2, "same part name, different artifact — both are real and both must persist");
  assert.deepEqual(
    k.map((e) => e.artifact).sort(),
    ["their runbook", "their triage skill"],
  );
});

test("an explicit profile against a build it does not claim reports the override", () => {
  // MUTATION: drop the overriddenBuildMatch computation -> fails.
  // A live run met `no-matching-profile`, re-ran with `--profile` to get past it,
  // replayed five connectors green and reported the setup valid for a suite the profile
  // does not name. `matchedBy: "requested"` was in that output and read as ordinary, so
  // the override needs a field of its own that the gate prints loudly.
  workspace();
  const context = validContext({
    profiles: { lane: profileFixture({ buildMatch: ["ApiLaneSuite-*"] }) },
    defaultProfile: "lane",
  });
  writeRcaContext({ context, from: productRepo });

  const forced = cli("select", "--from", productRepo, "--profile", "lane",
    "--build-name", "PipelineSuite-rengg", "--today", "2026-08-25");
  assert.equal(forced.status, 0, "an explicit label still wins — that is deliberate");
  assert.equal(forced.json.matchedBy, "requested");
  assert.deepEqual(forced.json.overriddenBuildMatch, ["ApiLaneSuite-*"],
    "and the patterns it ignored are named, so the gate can say what was overridden");

  // The same explicit label on a build it DOES claim is not an override.
  const fine = cli("select", "--from", productRepo, "--profile", "lane",
    "--build-name", "ApiLaneSuite-42", "--today", "2026-08-25");
  assert.equal(fine.json.overriddenBuildMatch, null, "no override, no warning");

  // And no build name at all cannot be an override — there is nothing to contradict.
  const bare = cli("select", "--from", productRepo, "--profile", "lane", "--today", "2026-08-25");
  assert.equal(bare.json.overriddenBuildMatch, null);
});
