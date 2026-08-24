// Guard against SHIPPED-BUT-UNREACHABLE code.
//
// Twice now a helper was built, unit-tested, and manually verified — and then
// invoked by nothing. `bin/repo-read.mjs` and `bin/evidence-show.mjs` were both
// referenced in zero skill/agent files, so at runtime every coordinator kept
// doing the expensive thing the helper existed to avoid. Unit tests can't catch
// this: the module works perfectly in isolation, which is exactly why the gap
// survives review.
//
// The prompt layer IS the call graph here. An agent only runs what its skill or
// agent markdown names, so "is this string mentioned in a prompt file" is the
// real reachability test, crude as it looks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** Every .md under the dirs an agent actually reads. */
function promptText() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith(".md")) out.push(readFileSync(p, "utf8"));
    }
  };
  for (const d of ["skills", "agents", "workflows", ".claude"]) walk(join(ROOT, d));
  return out.join("\n");
}

test("every bin/ helper is named by at least one prompt file", () => {
  const prompts = promptText();
  const helpers = readdirSync(join(ROOT, "bin")).filter((f) => f.endsWith(".mjs"));
  assert.ok(helpers.length > 0, "expected some helpers to check");

  const orphans = helpers.filter((h) => !prompts.includes(h));
  assert.deepEqual(
    orphans,
    [],
    `unreachable helper(s): ${orphans.join(", ")}. A helper no skill or agent ` +
      `names will never run — either reference it from the prompt layer or delete it.`,
  );
});

// The exported-but-uncalled variant of the same bug: lib functions that exist
// only because a test calls them. Checked for the few whose whole purpose is to
// be driven by the gate, where being uncalled means the feature is off.
test("gate-critical lib exports are actually invoked outside tests", () => {
  const prompts = promptText();
  const src = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith(".mjs")) src.push(readFileSync(p, "utf8"));
    }
  };
  walk(join(ROOT, "lib"));
  walk(join(ROOT, "bin"));
  const haystack = src.join("\n") + "\n" + prompts;

  // Each of these is a no-op unless something drives it: discovery that is
  // never run means every read falls back to the network, and a map that is
  // never written means every coordinator re-probes the filesystem.
  for (const fn of ["discoverWorkspaceRoot", "resolveLocalRepos", "setLocalRepos", "recomputeCoverage"]) {
    // Definition line doesn't count as a call site.
    const uses = haystack.split(fn).length - 1;
    assert.ok(uses >= 2, `${fn} appears ${uses}x outside tests — defined but never driven`);
  }
});

// The root cause of the 23% discovery tax was DRIFT: helpers were added faster
// than the docs described them, so agents grepped lib/ at runtime to learn the
// API. Documenting it once fixes today; this test keeps it fixed.
test("every exported lib helper appears in the SKILL's API reference", () => {
  // The API surface lives in references/api.md (loaded on-demand at Step 2+);
  // SKILL.md only points at it. Scan both so the drift guard still fires.
  const skill =
    readFileSync(join(ROOT, "skills/rca-build/SKILL.md"), "utf8") +
    "\n" +
    readFileSync(join(ROOT, "skills/rca-build/references/api.md"), "utf8");

  // Internal-by-convention: replay/test seams and trivial helpers a coordinator
  // never calls. Anything NOT listed here must be documented.
  const INTERNAL = new Set([
    "emptyEvidenceFile", "writeEvidenceFile", "contribDirFor", "contribPathFor",
    "hasTrustworthyPrList", "stalenessOf", "makeEvidenceCache", "assertGithubEntry",
    "replaySubmit", "replayRead",
    "selectRepresentative", "localCloneFor", "hasCommit", "ensureCommit",
    "orderAsks", "routeAsk",
    "unavailableCapabilities", "toolCacheDirFor", "cacheKey",
    "isCacheable",
    // tool-cache module internals — agents drive the cache through
    // bin/cached-exec.mjs / bin/cached-mcp.mjs, never by importing it.
    "isImmutableRead", "isRunStableRead", "isCacheableMcp", "redact", "cacheGet",
    "cachePut", "cacheStats", "mcpCacheKey", "banner",
  ]);

  const undocumented = [];
  for (const f of readdirSync(join(ROOT, "lib")).filter((f) => f.endsWith(".mjs"))) {
    const src = readFileSync(join(ROOT, "lib", f), "utf8");
    for (const m of src.matchAll(/^export (?:function|const) ([A-Za-z0-9_]+)/gm)) {
      const name = m[1];
      if (INTERNAL.has(name)) continue;
      if (!skill.includes(name)) undocumented.push(`${f}:${name}`);
    }
  }

  assert.deepEqual(
    undocumented,
    [],
    `undocumented helper(s): ${undocumented.join(", ")}. Add them to the SKILL's ` +
      `"API reference" section — an agent that can't find a signature there greps ` +
      `lib/ at runtime, which cost 92 of 407 tool calls on one measured run.`,
  );
});

// ---- no vendor names on the new surface -------------------------------------
//
// Scoped to the surface this milestone created, plus the two prompt-layer files
// that teach hardest. NOT scoped to all of lib/ bin/ config/: that fails on day
// one and would get quietly widened into an allowlist so broad the guard becomes
// one of the vacuous ones this file exists to prevent.
//
// Three pre-existing surfaces are grandfathered BY NAME, each for a stated
// reason, so the exemption is a closed list a reviewer can read:
//   lib/evidence-file.mjs   `kubectlSweep`/`victorialogs` are committed schema
//                           field names; renaming them breaks resume for builds
//                           already in flight.
//   bin/evidence-show.mjs   prints those same field names.
//   lib/tool-cache.mjs      its mutation pattern must name real destructive
//                           subcommands to refuse them — that is the point.
const VENDORS = [
  "kubectl", "kubernetes", "k8s", "docker", "nomad", "pm2", "ecs", "eks",
  "prometheus", "grafana", "victorialogs", "kibana", "elastic", "datadog",
  "splunk", "loki", "logcli", "promtool", "instana", "dynatrace", "newrelic",
  "new relic", "coralogix", "flyctl", "chitragupta", "bifrost",
];

const GRANDFATHERED = new Set([
  "lib/evidence-file.mjs", "bin/evidence-show.mjs", "lib/tool-cache.mjs",
]);

/** Every file under the given repo-relative dirs, recursively. */
function filesUnder(...dirs) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(ROOT, rel))) {
      const r = `${rel}/${e}`;
      if (statSync(join(ROOT, r)).isDirectory()) walk(r);
      else out.push(r);
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

test("the new surface names no vendor, and neither do the templates or examples", () => {
  // MUTATION: put `via kubectl` back into templates/gate-summary.md -> fails.
  const targets = [
    ...["lib/rca-context.mjs", "bin/rca-context.mjs",
        "skills/rca-build/references/interview.md",
        "skills/rca-build/references/capabilities.md",
        "skills/rca-build/references/context-file.md",
        "agents/ai-tfa-coordinator.md",
        "skills/rca-build/SKILL.md"],
    ...filesUnder("skills/rca-build/templates", "skills/rca-build/examples"),
    // config/rca.config.json is deliberately NOT here. Its `evidenceRouting` keys
    // include `k8s` and `kibana` — TFA's wire vocabulary for an ask type, which we
    // receive and do not choose. A flat text scan cannot tell those from a name we
    // picked, so the config property is asserted in tests/config.test.mjs instead,
    // where it checks capability and fallback NAMES specifically.
  ].filter((p) => { try { statSync(join(ROOT, p)); return true; } catch { return false; } });

  // references/capabilities.md is the ONE exception, and a narrow one: it teaches
  // scope questions by instantiating each generic rule across several
  // differently-built stacks. A single named product there would be a default; a
  // set of them is a set of alternatives. It is still barred from the generic
  // rules — that can only be reviewed by reading it, not asserted here.
  const ILLUSTRATIVE = "skills/rca-build/references/capabilities.md";

  const hits = [];
  for (const rel of targets) {
    if (GRANDFATHERED.has(rel) || rel === ILLUSTRATIVE) continue;
    const text = readFileSync(join(ROOT, rel), "utf8").toLowerCase();
    // Tokenised, not substring-matched. A bare `includes` made every short name a
    // landmine: "ecs" matched inside `execSync`, so the guard reported a vendor in
    // a sentence about child processes. Split on non-alphanumerics and compare
    // whole words; multi-word names fall back to a substring test, which is safe
    // because they are distinctive.
    const words = new Set(text.split(/[^a-z0-9]+/u).filter(Boolean));
    for (const v of VENDORS) {
      const present = v.includes(" ") ? text.includes(v) : words.has(v);
      if (!present) continue;
      // Naming a field that IS a grandfathered schema key, in order to explain it,
      // is documentation rather than a default. Narrow on purpose.
      if ((v === "kubectl" && text.includes("kubectlsweep")) ||
          (v === "victorialogs" && text.includes("victorialogs`"))) continue;
      hits.push(`${rel}: ${v}`);
    }
  }
  assert.deepEqual(
    [...new Set(hits)].sort(), [],
    `vendor name(s) on the new surface. A named product here becomes the default a ` +
      `customer on anything else is measured against — which is what the deleted ` +
      `probe table did. Say what the capability IS, not who provides it.`,
  );
});

// ---- the question-budget rule is stated once, and pointed at ----------------
//
// The failure this prevents: a file asserting "never ask the user anything" with
// no carve-out, which an agent then obeys during first contact and refuses to
// interview. This repo's history is a record of agents following the most
// emphatic rule they encountered rather than the intended one.
//
// A per-FILE check over a fixed literal phrase set, deliberately — not a regex
// over English, which is the class this project bans from its own scripts. The
// coordinator is exempt BY NAME because its statements are correct unqualified:
// a coordinator is never dispatched during first contact, so its budget really is
// zero, always.
test("any file asserting a never-ask rule points at the question budget", () => {
  // MUTATION: delete "§ The question budget" from SKILL.md -> fails.
  const PHRASES = [
    "never ask the user", "never asks the user", "never prompt",
    "no second gate question", "never ask you anything",
  ];
  const EXEMPT = new Set(["agents/ai-tfa-coordinator.md"]);
  const POINTER = "question budget";

  const offenders = [];
  for (const rel of filesUnder("skills", "agents").filter((p) => p.endsWith(".md"))) {
    if (EXEMPT.has(rel)) continue;
    const text = readFileSync(join(ROOT, rel), "utf8").toLowerCase();
    if (!PHRASES.some((p) => text.includes(p))) continue;
    if (!text.includes(POINTER)) offenders.push(rel);
  }

  assert.deepEqual(
    offenders, [],
    `file(s) assert a never-ask rule without pointing at § The question budget. ` +
      `Unqualified, that rule reads as a prohibition on the setup interview, and an ` +
      `agent will obey it and refuse to interview.`,
  );
});

// ---- every CLI verb named in prose exists -----------------------------------
//
// Written because it already happened: SKILL.md instructed the agent to run
// `bin/rca-context.mjs read --build-name …` and `bin/rca-context.mjs upsert`.
// Neither exists — the verbs are `select` and `upsert-connector`. An agent
// following a nonexistent verb gets a usage error at the one moment it is trying
// to decide whether it may run at all, and no test noticed.
//
// The verb list comes from each bin/ script's own usage header, so a new verb is
// documented in exactly one place and this guard reads it from there.
//
// KNOWN BLIND SPOT, stated because half the real bug is in it: this checks the VERB
// only, not its flags. `read --build-name` names a verb that exists and a flag it
// does not accept, and this guard passes it. Validating flags means parsing usage
// text, which is the pattern-over-prose class this project keeps out of its own
// scripts — so that half stays a review concern rather than a fragile test.
test("every bin/ CLI verb named in a prompt file actually exists", () => {
  // MUTATION: `rca-context.mjs upsert-connector` -> `rca-context.mjs upsert` in
  // SKILL.md (the nonexistent verb actually shipped) -> fails.
  const prose = filesUnder("skills", "agents")
    .filter((p) => p.endsWith(".md"))
    .map((p) => readFileSync(join(ROOT, p), "utf8"));

  const bad = [];
  for (const script of readdirSync(join(ROOT, "bin")).filter((f) => f.endsWith(".mjs"))) {
    const src = readFileSync(join(ROOT, "bin", script), "utf8");
    // Usage lines in the header: `//   node bin/<script> <verb> …`
    const verbs = new Set(
      [...src.matchAll(new RegExp(`^//\\s+node\\s+\\S*${script}\\s+([a-z][a-z-]*)`, "gm"))]
        .map((m) => m[1]),
    );
    if (verbs.size === 0) continue; // not a verb-dispatch script

    for (const text of prose) {
      for (const m of text.matchAll(new RegExp(`${script}\\s+([a-z][a-z-]*)`, "g"))) {
        // A flag, not a verb.
        if (m[1].startsWith("-")) continue;
        if (!verbs.has(m[1])) bad.push(`${script}: '${m[1]}' (real: ${[...verbs].sort().join(", ")})`);
      }
    }
  }

  assert.deepEqual(
    [...new Set(bad)].sort(), [],
    `prompt file(s) name a CLI verb that does not exist. An agent following it gets ` +
      `a usage error, and the instruction reads as authoritative.`,
  );
});

// ---- the greeting is the first thing the customer reads ---------------------
//
// The greeting is the only step in this flow with NO observable artifact. Every
// other step produces something that can refuse or be counted: a CLI call, a
// written file, an AskUserQuestion, a digest. This one produces prose, so nothing
// in the budget arithmetic, the ledger, or this suite can notice it was skipped or
// buried — and in a real run it arrived seventh, after five tool calls, quoted
// inside a status update about context-file resolution. The copy was complete and
// the customer still read it as missing.
//
// A test cannot check what an agent says. What it CAN check is that the two
// instructions which make the ordering possible are both present, since the
// failure came from their absence: the context load must be silent, and the
// greeting must be framed as the first OUTPUT rather than merely before the first
// question.
test("the greeting is instructed as the first output, over a silent context load", () => {
  // MUTATION: drop either instruction from SKILL.md -> fails.
  const skill = readFileSync(join(ROOT, "skills/rca-build/SKILL.md"), "utf8");

  assert.match(
    skill, /silently\s*—\s*\n?\s*emit nothing about it|Run it silently/i,
    "Step 0 must tell the agent to load the context WITHOUT narrating it; " +
      "narrating it is what pushed the greeting to seventh place",
  );
  assert.match(
    skill, /first output to the customer/i,
    "Step 0a must frame the greeting as the first OUTPUT. 'before asking anything' " +
      "was satisfied literally by greeting after five tool calls",
  );
});

// ---- agents clean up the scratch they create --------------------------------
//
// Written because one run left 28 files in a customer's repo root: four `.java`
// files and 572 KB: fetched sources, saved diffs, raw API responses, redirected
// stderr, a drafted message. Several coordinators had independently chosen the same
// short names, so they were overwriting each other as well as littering.
//
// The fix cannot be a cleanup sweep. 54d5bb0 removed `pruneStateDir` because the
// plugin runs on a user's machine and must not delete their data, and `rm *.log` in
// a customer's repo eats theirs too. So the rule is per-agent and by name: you
// delete what YOU created, which only you know. That makes it judgement rather than
// a script — and judgement in prose is exactly what needs a guard, because nothing
// else can notice when it stops happening.
test("agents get a scratch directory of their own and delete what they create", () => {
  // MUTATION: drop the section from the coordinator, or the pointer from SKILL.md.
  const coordinator = readFileSync(join(ROOT, "agents/ai-tfa-coordinator.md"), "utf8");
  const skill = readFileSync(join(ROOT, "skills/rca-build/SKILL.md"), "utf8");

  assert.match(coordinator, /Scratch goes in your own directory/,
    "the coordinator must be given a directory of its own — parallel agents sharing a " +
      "cwd pick the same short names and overwrite each other, not just litter");
  assert.match(coordinator, /scratchDirFor/,
    "and be pointed at the helper, so the isolation is structural rather than remembered");
  assert.match(coordinator, /delete it before you finish|delete what \*?it\*? created|by name/i,
    "and it must be scoped to what it created, by name");
  assert.match(coordinator, /never deletes a file it did not create/i,
    "with the no-glob guarantee stated, or a 'cleanup' step becomes a sweep over user data");
  assert.match(skill, /scratchDirFor/,
    "the orchestrator must pass the helper down in its dispatch, and apply it to itself");
});

// ---- customer knowledge: excerpts, never paths ------------------------------
//
// A coordinator that receives a PATH reads the whole artifact — including the phase
// ordering, trigger conditions and output contract that this feature exists to leave
// behind — and a coordinator is a prompt-following agent. The excerpt/path distinction
// is the entire screen, so it needs a guard: the rule is prose, and prose is what
// nothing else can notice going missing.
test("coordinators are handed knowledge as text, never as an artifact path", () => {
  // MUTATION: change the coordinator's `knowledge` input to carry a path -> fails.
  // Whitespace-normalised: these phrases wrap across lines in prose, and whether a rule
  // counts as stated must not depend on where the line happens to break. Same fix the
  // question-budget guard above needed for the same reason.
  const flat = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\s+/gu, " ");
  const coordinator = flat("agents/ai-tfa-coordinator.md");
  const skill = flat("skills/rca-build/SKILL.md");

  assert.match(coordinator, /text, never a path/i,
    "the coordinator's knowledge input must say it carries text and not a path");
  assert.match(skill, /never a path to it|verbatim/i,
    "and Step 5 must say the same where it builds the dispatch prompt");

  // The scope rule is the other half: an excerpt that names a place is scope, and scope
  // is already answered by verified profile fields that outrank any artifact. Getting
  // this wrong lands as a wrong PR on the dashboard.
  assert.match(coordinator, /never to decide which repo, branch or path/i,
    "an excerpt must never be allowed to bound scope");
});

test("the knowledge surface is inside the no-vendor-name scan", () => {
  // The excerpt input, the Step 5 clause and the candidate-pass rules are the largest
  // new prompt surface this feature adds, and none of the three files carrying them was
  // scanned before. A named product area in any of them teaches a default.
  const scan = readFileSync(join(ROOT, "tests/wiring.test.mjs"), "utf8");
  for (const rel of [
    "agents/ai-tfa-coordinator.md",
    "skills/rca-build/SKILL.md",
    "skills/rca-build/references/interview.md",
  ]) {
    assert.ok(scan.includes(`"${rel}"`),
      `${rel} must be in the vendor scan's target list — it now carries customer-facing prose`);
  }
});
