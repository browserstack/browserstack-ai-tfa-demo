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
  // Whitespace-normalised, and matching the RULE rather than its exact wording: this
  // sentence legitimately changes as Step 0 grows silent calls ("it" -> "both"), and a
  // guard that breaks on the object of the verb fails on correct edits while still
  // missing a reworded deletion.
  const skill = readFileSync(join(ROOT, "skills/rca-build/SKILL.md"), "utf8").replace(/\s+/gu, " ");

  assert.match(
    skill, /silently — emit nothing about/iu,
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

// ---- the pre-read must precede the question it feeds ------------------------
//
// A proving run reached the repo question with only `git remote` values to offer,
// so the one right answer was absent from the options and the customer had to type
// it. The answer was in a file the run had already located and never opened: a
// suite's own test-selection config, naming the product repos and the branch.
//
// Two prose rules made that the compliant path. The pre-read ran AFTER the question
// it exists to inform, justified by "there is no customer worktree to read yet" —
// true only when cwd is the plugin clone, false whenever the customer is invoked in
// a directory holding their checkouts. And "no recursion — you do not glob what a
// first glob revealed" stopped the read one call short of the file. Both are
// ordering and phrasing, which no other test can notice going missing.
test("the repo pre-read is ordered before the repo question", () => {
  // MUTATION: move the pre-read section back after T3 -> fails.
  const src = readFileSync(join(ROOT, "skills/rca-build/references/interview.md"), "utf8");

  const preread = src.search(/^##\s+\S+\s+—\s+repo pre-read/mu);
  const question = src.search(/^##\s+\S+\s+—\s+GitHub: repos/mu);
  assert.ok(preread > 0, "interview.md must have a repo pre-read section");
  assert.ok(question > 0, "interview.md must have a GitHub repos/branches question");
  assert.ok(
    preread < question,
    "the pre-read must come BEFORE the repo question — its options are what the " +
      "pre-read found. Ordered after, the question can only offer git remotes",
  );

  // Whitespace-normalised: a reflow must not un-state a rule.
  const flat = src.replace(/\s+/gu, " ");

  // The rule that stopped the read one call short. Its absence is the assertion:
  // it is re-addable in one edit and looked reasonable for two milestones.
  //
  // Matched as the BUDGET BULLET, not as the words: the replacement prose quotes the
  // deleted rule verbatim as its rationale, which is how this repo records what it
  // removed (cf. the discoveryHints guard in config.test.mjs). A guard that cannot
  // tell a citation from an instruction would forbid explaining the deletion.
  assert.doesNotMatch(
    flat, /- \*\*no recursion\*\*/iu,
    "the no-recursion rule stopped the pre-read at the directory holding the answer",
  );
  assert.match(
    flat, /Following a hit is the point/iu,
    "and the budget must say so positively, or the omission reads as an oversight",
  );

  // A budget spent entirely on listings learns the shape of the tree and nothing in
  // it. Every pre-read call in the proving run was `ls`, `find` or `git remote`.
  assert.match(
    flat, /file reads, not directory listings/iu,
    "the budget must say what to spend the calls ON, not only how many there are",
  );
});

test("the build's own metadata is named as a bound, not just as context", () => {
  // MUTATION: drop the tier from the hierarchy, or the section from capabilities.md
  // -> fails. The proving run held `ENV:<name>` from the build insights while it
  // searched a live control plane for the product's name, found the shared grouping
  // instead of the per-run one, and asked the customer to confirm it. Both exist and
  // both answer to the product's name; only the metadata says which one ran.
  // Blockquote markers are stripped BEFORE collapsing whitespace. The rule this
  // guards is stated inside a `>` block, and `\s+ -> " "` alone leaves the wrapped
  // marker mid-sentence ("for > it, check"), so the match silently never fires —
  // the same class as the line-wrap bug the excerpt guard above had.
  const flat = (rel) =>
    readFileSync(join(ROOT, rel), "utf8").replace(/^\s*>\s?/gmu, "").replace(/\s+/gu, " ");
  const interview = flat("skills/rca-build/references/interview.md");
  const capabilities = flat("skills/rca-build/references/capabilities.md");

  assert.match(
    interview, /\*\*The build's own metadata\*\*/u,
    "the evidence hierarchy must carry the build's metadata as its own tier — it is " +
      "free, exact, and describes THIS run rather than the setup in general",
  );
  assert.match(
    capabilities, /before listing a live control plane for it, check whether the build's metadata already names it/iu,
    "capabilities.md states the levels a read needs; it must also say to check the " +
      "metadata before asking a human or probing for one",
  );
  // The failure mode is the reason this is a rule: a wrong-but-authorised read.
  assert.match(
    capabilities, /reads as success/iu,
    "and must say why it matters — the wrong grouping returns evidence, not an error, " +
      "so the empty-read rule cannot catch it",
  );
});

// ---- nothing is asked before the build is read and the artifacts are opened ----
//
// Two ordering defects from the same proving run, and neither is visible in any
// single sentence — only in the sequence.
//
// The interview referenced "the insights read at T1" while T1 only ASKED for the
// build id; nothing fetched them. `fetchBuildInsights` was named once, at the gate,
// long after the interview had spent its questions. So the run asked for branches
// the build's own tags carried, and searched a live control plane for a grouping the
// build's environment tag named exactly.
//
// And the artifact pass carried the sentence "so this happens after T1 — not at T2"
// while itself sitting inside T2 — a contradiction that resolves in the reader's
// favour only by luck.
test("the build's insights are read before any turn that asks", () => {
  // MUTATION: move the fetch turn after T2, or delete it -> fails.
  const src = readFileSync(join(ROOT, "skills/rca-build/references/interview.md"), "utf8");

  const fetchTurn = src.search(/^##\s+\S+\s+—\s+fetch the build's insights/mu);
  const artifacts = src.search(/^##\s+T2\s+—/mu);
  const firstScopeAsk = src.search(/^##\s+\S+\s+—\s+GitHub: repos/mu);

  assert.ok(fetchTurn > 0, "the interview must have a turn that fetches build insights");
  assert.ok(
    fetchTurn < artifacts,
    "insights come BEFORE the artifact pass — judging whether an artifact applies to " +
      "THIS build is what the metadata is for; without it nothing can be ruled out",
  );
  assert.ok(
    fetchTurn < firstScopeAsk,
    "and before the first scope question, or the interview asks for what the build stated",
  );

  // The tool has to be named, not gestured at. It was referenced as "the insights"
  // by a turn that never called anything.
  assert.match(
    src.slice(fetchTurn, artifacts), /fetchBuildInsights/u,
    "the fetch turn must name the tool it calls",
  );

  // Nothing may claim insights were read at a turn that only asks for the build id.
  assert.doesNotMatch(
    src, /insights read at T1\./u,
    "T1 asks for the build id; the fetch is its own turn and must be cited as such",
  );
});

test("the artifact pass precedes every question but the build id", () => {
  // MUTATION: drop either statement -> fails. The rule is an ORDERING, so it cannot
  // be inferred from any one section; both files have to assert it.
  const flat = (rel) =>
    readFileSync(join(ROOT, rel), "utf8").replace(/^\s*>\s?/gmu, "").replace(/\s+/gu, " ");
  const interview = flat("skills/rca-build/references/interview.md");
  const skill = flat("skills/rca-build/SKILL.md");

  assert.match(
    interview, /No question is asked before this pass/iu,
    "the artifact pass must state that it precedes the questions",
  );
  assert.match(
    skill, /Nothing is asked before the artifact pass/iu,
    "and SKILL.md must carry it as a hard rule — the reference file is loaded at Step " +
      "0b, so a rule only stated there cannot govern whether Step 0b is entered right",
  );

  // The contradiction: the pass asserted it happened somewhere other than where it is.
  assert.doesNotMatch(
    interview, /so this happens after T1 — not at T2/iu,
    "the pass sat inside T2 while claiming not to be at T2",
  );

  // The three harness-defined artifact directories, not just skills. A populated
  // knowledge/ directory and six agent definitions were unreachable by a skills-only
  // glob. This closes the harness's set; it is not a list that grows.
  for (const dir of ["skills", "agents", "knowledge"]) {
    assert.match(
      interview, new RegExp(`\\.claude/${dir}/`, "u"),
      `the artifact glob must reach .claude/${dir}/ — a customer's triage knowledge ` +
        "sits there at least as readily as in a skill",
    );
  }
});

// ---- selection needs a name, and only insights have one --------------------
//
// Step 0 ran `select --build-name "<build name, if known>"` and the name is NEVER
// known there: the invocation carries an id. A proving run passed `""`, no
// `buildMatch` could match, and selection fell through to `defaultProfile` — the
// wrong-context run that selectProfile's five refusals exist to prevent, reached
// without one of them firing. Nothing in the code can catch this; the fetch either
// precedes the select in the prose or it does not.
test("Step 0 fetches the build's insights before it selects a profile", () => {
  // MUTATION: reorder the two, or drop --project-name from the documented call -> fails.
  const src = readFileSync(join(ROOT, "skills/rca-build/SKILL.md"), "utf8");
  const step0 = src.slice(src.search(/^## Step 0 —/mu), src.search(/^### Step 0a/mu));

  const fetchAt = step0.indexOf("fetchBuildInsights");
  const selectAt = step0.indexOf("rca-context.mjs select");
  assert.ok(fetchAt > 0, "Step 0 must fetch the build's insights — an id is not a name");
  assert.ok(selectAt > 0, "Step 0 must select a profile");
  assert.ok(
    fetchAt < selectAt,
    "the fetch must come FIRST. Selecting on an empty build name matches no buildMatch " +
      "and silently resolves to defaultProfile, which is the wrong-context run",
  );

  const flat = step0.replace(/\s+/gu, " ");
  assert.match(flat, /--build-name/u, "and pass the name it just fetched");
  assert.match(flat, /--project-name/u, "and the project — the coarse bound, checked first");

  // The stale form: a placeholder admitting the name is not known is the bug itself.
  assert.doesNotMatch(
    flat, /--build-name "<build name, if known>"/u,
    "'if known' was never true at Step 0; that is what made every selection blind",
  );
});

test("the gate prints what selection matched on, not only what it chose", () => {
  // MUTATION: drop matchedBy or projectUnchecked from the template -> fails.
  // `label` alone cannot distinguish "this build's name and project chose this" from
  // "nothing matched, so you got the default", and those need different reactions.
  const flat = readFileSync(join(ROOT, "skills/rca-build/templates/gate-summary.md"), "utf8")
    .replace(/^\s*>\s?/gmu, "").replace(/\s+/gu, " ");

  assert.match(flat, /matchedBy/u, "the gate screen must show HOW the profile was chosen");
  assert.match(flat, /projectUnchecked/u,
    "and must say when a declared project constraint could not be evaluated — a " +
      "silently unapplied constraint is indistinguishable from one that agreed");
});

// ---- every documented question shape must be a LEGAL question shape ---------
//
// `AskUserQuestion` refuses a part carrying fewer than 2 options, and refuses the
// WHOLE call — so one settled part takes the genuinely-open parts down with it. Two
// live runs lost a turn to this, and the reference file was the reason: it documented
// a conclusive pre-read as degrading to "a single confirm, which is still one call",
// and six of its own JSON examples showed one-option parts.
//
// This parses the examples rather than trusting the prose, because the examples are
// what gets copied.
test("no documented question shape has a part with fewer than two options", () => {
  // MUTATION: drop an option from any example in either file -> fails.
  // BOTH files: the template carries the gate review's question and is copied just as
  // directly as the interview's. Auditing only one of them is how the next one-option
  // part ships.
  const files = [
    "skills/rca-build/references/interview.md",
    "skills/rca-build/templates/gate-summary.md",
  ];
  const offenders = [];
  for (const rel of files) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    for (const block of src.matchAll(/```json\n([\s\S]*?)\n```/gu)) {
      const line = src.slice(0, block.index).split("\n").length;
      for (const opts of block[1].matchAll(/"options":\s*\[([\s\S]*?)\]\}/gu)) {
        const n = (opts[1].match(/\{\s*"label"/gu) ?? []).length;
        if (n < 2) offenders.push(`${rel}:${line} (${n} option${n === 1 ? "" : "s"})`);
      }
    }
  }
  const src = readFileSync(join(ROOT, files[0]), "utf8");
  assert.deepEqual(
    offenders, [],
    "a part with <2 options is rejected by the tool and the whole call fails, losing " +
      "the parts that did need asking. State a settled part; never pad it to two",
  );

  const flat = src.replace(/\s+/gu, " ");
  assert.match(flat, /At least 2 options per part/iu,
    "and the minimum must be stated where the maximum is — only the max was documented");
  // The deleted instruction must not return — but the replacement QUOTES it as its
  // own rationale, which is how this repo records what it removed. So the assertion is
  // that every occurrence is a citation: preceded by "used to say". An instructional
  // one is not. Third time a guard here has needed this distinction; matching the bare
  // words would forbid explaining the deletion.
  const DELETED = "degrades to a single confirm, which is still one call";
  for (let i = flat.indexOf(DELETED); i !== -1; i = flat.indexOf(DELETED, i + 1)) {
    assert.match(
      flat.slice(Math.max(0, i - 60), i), /used to say/iu,
      "that shape does not exist — a settled part is dropped, not confirmed. Only a " +
        "citation of the removed rule is allowed here, not the rule itself",
    );
  }
  assert.match(flat, /When the pre-read settled a part, drop that part/iu,
    "and the replacement must be stated positively, or its absence reads as an oversight");
});

test("a bound the build's metadata produced becomes an offered capability", () => {
  // MUTATION: drop either statement -> fails. A live run recorded `ci` as a gap while
  // its own gap note said the CI run URL was known from the insights: the bound was
  // produced and then dropped, so the customer was never offered the capability the
  // build had located for them.
  const flat = readFileSync(join(ROOT, "skills/rca-build/references/interview.md"), "utf8")
    .replace(/^\s*>\s?/gmu, "").replace(/\s+/gu, " ");

  assert.match(flat, /If T1b named a bound for a capability, that capability appears here/iu,
    "T5 must offer what the metadata bounded — it is the strongest-cited candidate there is");
  assert.match(flat, /A bound read here becomes a T5 candidate/iu,
    "and T1b must say so where the fields are introduced, not only where they are used");
});

test("the artifact pass has to account for what it opened", () => {
  // MUTATION: drop the accounting rule, or restore T8's "omit when nothing was
  // recorded" -> fails.
  //
  // The pass had no outcome: reading is silent and judging is silent, so "I looked and
  // took nothing" produced exactly the screen that "I never looked" produced. A live
  // run opened a team's regression-RCA procedure, culprit-PR finder and build-triage
  // engine, recorded nothing from any of them, and nothing anywhere said so — in a run
  // whose deliverable is culprit-PR attribution.
  const flat = readFileSync(join(ROOT, "skills/rca-build/references/interview.md"), "utf8")
    .replace(/\s+/gu, " ");

  assert.match(flat, /Account for every artifact you opened/iu,
    "each opened artifact needs a recorded part or a stated reason nothing applied");
  assert.match(flat, /Omit the block only when nothing was OPENED/u,
    "and the digest must distinguish 'opened, nothing applied' from 'never looked'");
  assert.doesNotMatch(
    flat, /Omit the block entirely when nothing was recorded/iu,
    "that rule is what made the two cases print the same screen",
  );
});

// ---- a repeat run can see and correct what a previous run persisted ---------
//
// The gate printed a summary and spent its one question on whichever field was
// non-assumable. Everything else a previous run persisted — repos, branches,
// subpaths, which profile was chosen and why — was applied without ever being shown,
// on a setup that may have been approved weeks ago by someone else.
//
// No new code carries this. `writeRcaContext` already refuses to drop a profile, drop
// a connector, or downgrade a verified one, so read-amend-write is the safe additive
// path for correcting a field, adding a repo, and adding a whole profile alike. A
// per-field verb was written for this and deleted: it duplicated a protection that
// lives in the writer and could not create a profile, which is one of the things the
// review has to allow.
test("the gate reviews the persisted setup and can change it", () => {
  // MUTATION: drop Part C, the bound, or the skip-on-first-contact rule -> fails.
  const flat = (rel) =>
    readFileSync(join(ROOT, rel), "utf8").replace(/^\s*>\s?/gmu, "").replace(/\s+/gu, " ");
  const skill = flat("skills/rca-build/SKILL.md");
  const template = flat("skills/rca-build/templates/gate-summary.md");

  assert.match(skill, /Part C — review and confirm/u, "the gate needs a review part");
  assert.match(skill, /Skip entirely when first contact ran this session/iu,
    "and it must NOT fire right after T8 already took the same approval");
  assert.match(skill, /Bounded at two further passes/iu,
    "a correction loop with no bound is the interview again, at every run");

  // Persistence has to be named, or a correction is re-typed on every run — which is
  // what happened when this pointed at `upsert-connector`, a call that cannot write
  // `profile.repos`.
  assert.doesNotMatch(
    skill, /Record the answer back into the active profile \(`bin\/rca-context\.mjs upsert-connector`\)/u,
    "upsert-connector cannot write repos; naming it there made the answer non-persistent",
  );
  assert.match(skill, /would-regress/u,
    "and the writer's additive refusal must be cited, or the agent will not trust a plain write");

  // A change that invalidates a verification must not carry the old proof forward.
  assert.match(skill, /A change to scope invalidates what was verified against the old scope/iu,
    "a just-corrected branch has never been proved reachable");

  // The review is only real if the values are on screen.
  for (const field of ["matchedBy", "others on file", "subpaths", "knowledge"]) {
    assert.match(
      template, new RegExp(field.replace(/ /gu, " "), "iu"),
      `the review screen must show ${field} — a value not on screen cannot be corrected`,
    );
  }
});

// ---- the gate's stated budget and its never-ask prose must agree --------------
//
// The existing ledger guard checks that a never-ask rule POINTS AT the budget. That is
// not the same as agreeing with it, and the difference shipped: Part C allows two
// correction passes while two files still said "There is no second gate question,
// ever." Both pointed at the budget, so the ledger guard was satisfied — and an agent
// meeting an absolute rule and a table that permits three follows the absolute one.
// This repo's history is explicit about that: 164962f added 52 lines enforcing a rule
// and 395960c added 82 more because the same rule lost to a louder one.
test("no file forbids a second gate question while the budget permits three", () => {
  // MUTATION: restore "no second gate question, ever" in either file -> fails.
  const files = [
    "skills/rca-build/SKILL.md",
    "skills/rca-build/templates/gate-summary.md",
    "skills/rca-build/references/interview.md",
    "agents/ai-tfa-coordinator.md",
  ];
  for (const rel of files) {
    const flat = readFileSync(join(ROOT, rel), "utf8").replace(/\s+/gu, " ");
    assert.doesNotMatch(
      flat, /no second gate question, ever/iu,
      `${rel} states an absolute the budget contradicts; an agent follows the absolute`,
    );
  }

  // And the distinction that makes both true has to be stated, or "pass" reads as a
  // licence to ask anything on the second one.
  const skill = readFileSync(join(ROOT, "skills/rca-build/SKILL.md"), "utf8").replace(/\s+/gu, " ");
  assert.match(skill, /A pass is not a question/iu,
    "re-asking the SAME question after acting on it is a pass; asking something new is not");
  assert.match(skill, /never a second question in a pass/iu,
    "the fold-it-in rule still has to bind inside every pass, including the later ones");
});

// ---- one profile is not a match ---------------------------------------------
test("the selection rules do not license adopting a non-matching sole profile", () => {
  // MUTATION: restore "one profile in the file: use it" -> fails.
  // A live run took a profile bound to `ObservabilityApiLaneSuite-*`, applied it to a
  // build named `ObservabilityPipelineSuite-…`, and reported "runnable and provisioned".
  // The code allowed it and context-file.md documented it, one line above a refusal
  // arguing the opposite.
  const flat = readFileSync(join(ROOT, "skills/rca-build/references/context-file.md"), "utf8")
    .replace(/\s+/gu, " ");
  assert.match(
    flat, /neither is "it is the only profile in the file"/u,
    "the documented rule must say that being the only profile is not a match",
  );
  assert.doesNotMatch(
    flat, /one profile in the file: use it and\s*say so/u,
    "that is the rule that produced a wrong-context run",
  );
});

test("a stored call may not pin a per-build identifier", () => {
  // MUTATION: drop either statement -> fails.
  // A live run stored a CI call ending `/351/api/json`. The gate replays stored calls,
  // so it returned HTTP 200 on every later build and `ci` read as verified while
  // pointing at another build's run — a probe that passes and proves nothing, which is
  // the defect class this repo has now hit three times.
  const flat = (rel) =>
    readFileSync(join(ROOT, rel), "utf8").replace(/^\s*>\s?/gmu, "").replace(/\s+/gu, " ");
  assert.match(
    flat("skills/rca-build/references/interview.md"),
    /Never pin a per-build identifier into `args`/u,
    "the authoring rules must forbid it where connectors are authored",
  );
  assert.match(
    flat("skills/rca-build/references/interview.md"),
    /`verifiedBy\.note` describes the verification, not the build/u,
    "and a per-build fact must not be stored as a cross-build note",
  );
  assert.match(
    flat("skills/rca-build/references/capabilities.md"),
    /Store the mapping, never the resolved run/u,
    "and ci — where a run number is the obvious thing to pin — must say it too",
  );
});

// ---- a refusal routes into the interview, and is never laundered -------------
//
// `no-matching-profile` was a dead end: correct as a code outcome, useless as a
// product one. A live run hit it, re-ran `select --profile <label>` to override the
// check that had just fired, replayed five connectors green, and reported the setup as
// valid for a suite the profile does not name. The customer caught it, not the plugin.
//
// The refusal is a question for the customer — new profile, extend the existing one, or
// use it once — so it belongs in the interview, which is where questions live.
test("a no-matching refusal enters the interview instead of stopping", () => {
  // MUTATION: drop the routing row, the launder rule, or the mode -> fails.
  const flat = (rel) =>
    readFileSync(join(ROOT, rel), "utf8").replace(/^\s*>\s?/gmu, "").replace(/\s+/gu, " ");
  const skill = flat("skills/rca-build/SKILL.md");
  const interview = flat("skills/rca-build/references/interview.md");
  const template = flat("skills/rca-build/templates/gate-summary.md");

  assert.match(skill, /no-matching-profile/u, "Step 0's outcome table must route this code");
  assert.match(skill, /adopt-or-extend/iu, "and name the mode the interview enters");
  assert.match(skill, /A refusal is a routing decision, not a failure/iu,
    "or an agent prints the refusal and stops, which helps nobody");

  // The laundering rule, and the signal that betrays it.
  assert.match(skill, /Never launder a refusal with `--profile`/u,
    "re-running with an explicit label overrides the check that just fired");
  assert.match(skill, /overriddenBuildMatch/u, "and the field that makes it visible must be cited");
  assert.match(template, /OVERRIDE/u, "the gate has to print it where it cannot be read past");

  // The mode's whole point is not re-asking what is already verified.
  assert.match(interview, /Connectors are inherited, never re-authored|adopt-or-extend/iu,
    "the interview needs the mode's entry turn");
  assert.match(skill, /Connectors are inherited, never re-authored/iu,
    "a sibling suite in the same environment must not re-interview for the same connectors");
  // Anchored to the OPTION, not to the phrase: "writes nothing" also occurs in the
  // GitHub-refusal rule further down, so the loose form passes even with this rule
  // deleted. A mutation caught that — the guard was nearly vacuous.
  assert.match(skill, /"This run only" writes nothing/u,
    "the run-only option must say it persists nothing, or the next run surprises them");
});

// ---- a PR-hunting excerpt has three possible homes, not one -----------------
//
// Culprit-PR attribution is the run's deliverable, so it is what a customer's artifacts
// most often describe — and the artifact pass had no rule for it. "Candidate PRs come
// from <somewhere>" reads as machinery and gets dropped; a genuine exclusion rule reads
// as machinery too and gets dropped with it. One customer file already carried a
// "frontend-only PR filter" that IS knowledge, and a sourcing procedure that is not.
test("PR-hunting excerpts are routed by kind, not all treated as knowledge", () => {
  // MUTATION: drop any of the three destinations -> fails.
  const flat = readFileSync(join(ROOT, "skills/rca-build/references/interview.md"), "utf8")
    .replace(/\s+/gu, " ");

  assert.match(flat, /How to REACH the PRs/u,
    "a route is a connector — filed as knowledge it becomes prose that changes nothing");
  assert.match(flat, /Which PRs COUNT as candidates/u,
    "an exclusion or ranking is judgement, and judgement is what knowledge is for");
  // Bold markers survive whitespace-normalisation, so the phrase is matched in pieces
  // rather than as one span. Asserting the un-emphasised sentence is how this failed.
  //
  // The refusal is scoped to ARTIFACTS. It was written blanket, which then forbade the
  // customer supplying a PR list at invocation — so the rule now turns on who is
  // speaking, and both halves are asserted: a file still cannot replace the window, and
  // a human typing a list for this run can.
  assert.match(flat, /An ARTIFACT that replaces the definition of the candidate window\*\* is machinery and\s*is refused/u,
    "an artifact must still be refused — it was found on disk and competes silently");
  assert.match(flat, /What decides this is who is speaking, not what is said/u,
    "the distinction has to be stated, or the carve-out reads as arbitrary");
  assert.match(flat, /it does not admit a file, a recalled convention, or an inference/u,
    "and the carve-out must be bounded, or it becomes 'anything may replace the window'");

  // The honest cost of a non-CLI route, stated where it is decided rather than found.
  assert.match(flat, /the shared pre-fetch is bypassed/u,
    "prefetch-prs.mjs speaks the forge CLI only; a connector on another route pays per coordinator");
});

// ---- culprit PRs travel structured, and the prose channel is GONE -----------
//
// `tfaRcaTurn` takes `prDetails`: one object per suspect PR, six required fields
// (repo, number, title, author, link, tag: latent|regression). The word appeared
// nowhere in this repo — not in the coordinator, not in the skill, not in code — while
// the coordinator's culprit-PR mandate said "Feed the PR link(s) to TFA in the turn
// message". A sampled run sent `prDetails` zero times across sixteen coordinators. They
// were not ignoring an instruction; they were following one.
//
// `related_prs` is optional in the RCA the BrowserStack agent synthesises, so a PR that
// arrives as prose is the one that gets dropped.
test("the coordinator sends culprit PRs in prDetails, not in the message", () => {
  const raw = readFileSync(join(ROOT, "agents/ai-tfa-coordinator.md"), "utf8");
  const flat = raw.replace(/\s+/gu, " ");

  // MUTATION: remove the prDetails contract -> fails.
  assert.match(flat, /prDetails/u, "the structured channel must be named where PRs are decided");
  for (const field of ["repo", "number", "title", "author", "link", "tag"]) {
    assert.match(
      flat, new RegExp(`\\b${field}\\b`, "u"),
      `prDetails requires ${field} per entry, so the contract has to name it`,
    );
  }
  assert.match(flat, /regression.{0,20}latent|latent.{0,20}regression/u,
    "tag is an enum of exactly two values; naming them is what stops a third being invented");

  // THE property, and the one this repo has failed twice: the old channel is REPLACED,
  // not supplemented. A structured contract sitting beside "put the links in the
  // message" leaves two channels, and the prose one is the older and more emphatic —
  // which is how 164962f and 395960c both happened.
  // MUTATION: restore the prose instruction alongside the contract -> fails.
  assert.doesNotMatch(
    flat, /Feed the PR link\(s\) to TFA in the turn message/u,
    "the prose instruction must be gone, not kept next to prDetails",
  );
  assert.match(flat, /the message is never the channel/u,
    "and saying so explicitly is what keeps a helpful-looking prose line from creeping back");

  // Fabricating a field to satisfy a required shape is worse than omitting the PR.
  assert.match(flat, /Do not fabricate a field to satisfy the shape/u,
    "six required fields plus an unclassifiable suspect is where a guessed enum comes from");
});

test("the suspect packet carries every field prDetails requires", () => {
  // MUTATION: drop repo or tag from the template -> fails. The packet is the source the
  // hand-off maps from; a field missing here has to be re-derived from a permalink by
  // every reader, which is what `repo` was before this.
  const packet = readFileSync(join(ROOT, "skills/rca-build/templates/suspect-packet.md"), "utf8");
  for (const field of ["repo:", "pr:", "author:", "tag:", "link:"]) {
    assert.match(packet, new RegExp(`^\\s*${field.replace(":", ":")}`, "mu"),
      `the packet must carry ${field} — prDetails requires it and cannot be filled without it`);
  }
  assert.match(packet, /identity is\s+`?repo \+ number`?|repo \+ number/u,
    "a number alone is ambiguous across a profile's several product repos");
  assert.match(packet, /different axis from `verdict`/u,
    "tag is what kind of fault it is; verdict is whether it survived falsification");

  // A worked example is the strongest teaching signal in the skill, so it has to show
  // the fields rather than teach the old shape by omission.
  // Counted, not spot-checked: `/^\s*repo: /` passes when ANY block has it, so dropping
  // it from just the supported block — the only one that feeds prDetails — would sail
  // through. A mutation proved that; the assertion was nearly vacuous.
  const example = readFileSync(join(ROOT, "skills/rca-build/examples/sample-run.md"), "utf8");
  const blocks = (example.match(/^SUSPECT:$/gmu) ?? []).length;
  const repos = (example.match(/^\s+repo: /gmu) ?? []).length;
  assert.ok(blocks >= 2, `the example must show a supported AND a ruled-out suspect (found ${blocks})`);
  assert.equal(repos, blocks, `every SUSPECT block needs repo — ${repos} of ${blocks} have it`);
  assert.match(example, /^\s*tag: /mu, "and the supported suspect must show tag");
});

// ---- a supplied PR list replaces enumeration, not analysis -------------------
//
// `/rca-build <uuid> <pr_list>` hands over the superset of merged PRs — good and bad —
// and finding the bad ones stays ours. Before this, PR URLs in the invocation only
// skipped a gate question (`SKILL.md` Part B) and died there: `prefetch-prs.mjs` had no
// argv for them, the coordinator had no input for them, and `pre_seed` carries only the
// representative's own result. The window search ran regardless.
test("a supplied PR list is the candidate set and suppresses discovery", () => {
  // MUTATION: drop any of these statements -> fails.
  const flat = (rel) =>
    readFileSync(join(ROOT, rel), "utf8").replace(/^\s*>\s?/gmu, "").replace(/\s+/gu, " ");
  const skill = flat("skills/rca-build/SKILL.md");
  const evidence = flat("skills/rca-build/references/github-evidence.md");
  const coordinator = flat("agents/ai-tfa-coordinator.md");
  const template = flat("skills/rca-build/templates/gate-summary.md");

  assert.match(skill, /A PR list IS the candidate set/u,
    "Step 0 must say the list replaces enumeration, not merely pre-answers a question");
  assert.match(skill, /No window search runs anywhere in that case/u,
    "Step 4 must suppress the search for EVERY repo, not just the named ones");
  assert.match(skill, /--prs/u, "and name the argv form that does it");

  // The union, or a supplied PR in an unvalidated repo has no path into prsInWindow.
  assert.match(skill, /Repo scope with a supplied list is the UNION/u,
    "the pre-fetch loops repos_validated; a supplied repo outside it would vanish");

  // Hydration is what the list cannot provide, and path-overlap needs it.
  assert.match(skill, /Hydration still runs/u,
    "the list gives numbers; falsification needs each PR's files");

  // The three rules that would otherwise contradict this, each carved out.
  assert.match(skill, /a customer-supplied list, where per-PR is the only shape available/u,
    "the no-backfill rule forbids exactly the shape a supplied list needs");
  assert.match(skill, /The cap applies to a SEARCHED window only/u,
    "capping to ~30 by our relevance would silently drop PRs the customer named");

  // Elimination is the deliverable, and a rule-out still gets reported.
  assert.match(evidence, /Report every supplied PR, including the ones you rule out, with the reason/u,
    "dropping a supplied PR silently reads as ignoring the customer");
  assert.match(evidence, /No survivor across the whole set is a FINDING, not a weak hunt/u,
    "the superset being exhausted is an answer, not a reason to keep digging");

  // The coordinator definition carries it — the b3c9164 lesson: a briefing alone lost
  // 16 times out of 16.
  assert.match(coordinator, /`suppliedPrs`/u, "the agent definition needs the input, not just the briefing");
  assert.match(coordinator, /the hunt is the elimination, not the search/u, "and what to do with it");
  assert.match(coordinator, /`suppliedPrs` is the exception/u,
    "or INCOMPLETE sends it digging to the turn cap through an exhausted enumeration");

  // Both must be carried to siblings too, since pre_seed cannot.
  assert.match(skill, /Coordinator prompts MUST carry a customer-supplied PR list/u,
    "a sibling learns intake from the dispatch or from nowhere");

  // The screen, so an empty result for an unnamed repo reads correctly.
  assert.match(template, /culprit-PR discovery: DISABLED/u, "the gate must say discovery is off");
  assert.match(template, /have no supplied candidate/u,
    "and name the repos with none — 'we found nothing' and 'nothing was offered' differ");
});

test("an explicit invocation value outranks build metadata", () => {
  // MUTATION: restore metadata above invocation args, or drop the per-run rule -> fails.
  // The table ranked build metadata first, so a customer pinning a CI run lost to
  // `ci_build_url` naming a different one — the opposite of what pinning means.
  const skill = readFileSync(join(ROOT, "skills/rca-build/SKILL.md"), "utf8");
  const flat = skill.replace(/\s+/gu, " ");

  // Order asserted positionally, not by prose: the list is what an agent follows.
  const invocation = skill.search(/^1\. \*\*an explicit invocation value\*\*/mu);
  const metadata = skill.search(/^2\. build metadata from `fetchBuildInsights`/mu);
  assert.ok(invocation > 0 && metadata > 0, "the precedence list must name both sources");
  assert.ok(invocation < metadata, "an explicit invocation value outranks derived metadata");

  assert.match(flat, /an invocation value is not an assumption, it is a statement/u,
    "and why — metadata was ranked first because it beats an ASSUMPTION, which this is not");
  assert.match(flat, /An override lasts for this run and persists nothing/u,
    "a pasted one-off must not become the team's committed scope");
  assert.match(flat, /A credential value is never an override/u,
    "the one thing an invocation may never carry into the file or the transcript");

  // `given` and `detected` had one shared definition; they now have different precedence,
  // so the screen could not show which won.
  const tags = readFileSync(join(ROOT, "skills/rca-build/templates/gate-summary.md"), "utf8");
  assert.doesNotMatch(
    tags, /`given` \| supplied in the invocation, or read from build metadata/u,
    "one tag for two sources with different precedence cannot show which one won",
  );
  assert.match(tags, /`given` \| \*\*the customer said so\*\*/u, "given is the customer speaking");
  assert.match(tags, /build metadata included/u, "and metadata is detected");
});
