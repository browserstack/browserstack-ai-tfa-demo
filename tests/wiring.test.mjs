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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT, mandatedReading } from "./helpers/mandated-reading.mjs";

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
//
// Each entry names the module it lives in, so an export whose module has not been
// built yet is skipped rather than failing. Same rule as the ownership map below:
// the guard is armed ahead of the code it guards, deliberately.
const GATE_CRITICAL = [
  { fn: "discoverWorkspaceRoot", module: "repo-source.mjs" },
  { fn: "resolveLocalRepos", module: "repo-source.mjs" },
  { fn: "setLocalRepos", module: "evidence-file.mjs" },
  { fn: "recomputeCoverage", module: "evidence-file.mjs" },
  // The adapter's precedence rule is only real if the gate actually calls it.
  // A prose reimplementation of precedence in Gate Part B would satisfy a
  // string-presence check; it will not satisfy this one.
  { fn: "resolveIntake", module: "rca-context.mjs" },
  { fn: "readRcaContext", module: "rca-context.mjs" },
  // Shipped, documented and unit-tested while NOTHING drove it — the exact bug
  // class this test exists to catch, which it missed because the old check counted
  // mentions rather than call sites.
  { fn: "reportableUnavailable", module: "capability-table.mjs" },
  { fn: "intakeFromContext", module: "rca-context.mjs" },
  // Made load-bearing by this milestone: the agent's assignment, the verification
  // policy and the mandatory-capability gate. Documented from the start; adding
  // them here is what requires a DRIVER.
  { fn: "planInterview", module: "discovery.mjs" },
  { fn: "validateVerification", module: "verify.mjs" },
  { fn: "githubGate", module: "verify.mjs" },
  { fn: "persistClusters", module: "signature.mjs" },
];

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
  for (const { fn, module } of GATE_CRITICAL) {
    if (!existsSync(join(ROOT, "lib", module))) continue; // not built yet

    // Count CALL SITES, not mentions. `haystack.split(fn).length - 1` counted every
    // occurrence including the `export function` definition, so a threshold of 2 was
    // satisfied by the definition plus a single prose mention — zero invocations —
    // while the comment above it claimed the definition did not count. The guard
    // named a property it was not checking, which is worse than not checking it.
    //
    // A call site is `fn(` minus the declarations. Prose counts: for the adapter
    // exports the CALLER is an agent following a fenced snippet, so a `resolveIntake({`
    // in SKILL.md is a real driver — that is what test 3 below pins in place.
    // Count only drivers: a call in lib/ or bin/ source, or one inside a fenced
    // code block an agent is meant to execute. An api-reference SIGNATURE line
    // matches `fn(` exactly as well as a real call — and test 4 below REQUIRES
    // that line to exist for every documented export, so counting prose made the
    // two guards cancel out and every export passed automatically. That is how
    // reportableUnavailable sat here, shipped and driven by nothing, while a
    // comment on this very list called it "the exact bug class this test catches".
    const decls = (haystack.match(new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${fn}\\b`, "g")) ?? []).length;
    const inSource = (src.join("\n").match(new RegExp(`\\b${fn}\\s*\\(`, "g")) ?? []).length - decls;
    const fenced = fencedBlocks(prompts).join("\n");
    const inFence = (fenced.match(new RegExp(`\\b${fn}\\s*\\(`, "g")) ?? []).length;
    assert.ok(
      inSource + inFence >= 1,
      `${fn} has no driver: ${inSource} call(s) in lib/bin and ${inFence} in an executable ` +
        `fenced block. A signature line in a reference does not drive anything.`,
    );
  }
});

/**
 * Text inside ```js / ```javascript fences ONLY — a snippet an agent executes.
 *
 * A bare ``` fence is a signature index, and both api references are written that
 * way. Counting them made this guard vacuous twice: `reportableUnavailable` scored
 * inSource=0, inFence=2 with both hits coming from signature lines, so it passed
 * for exactly the reason the comment below claimed was fixed. A planted
 * documented-but-uncalled export also passed the whole suite.
 */
function fencedBlocks(text) {
  return [...String(text).matchAll(/```(?:js|javascript)\n([\s\S]*?)```/g)].map((m) => m[1]);
}

// The adapter that feeds the setup context into the run skill's gate is PROSE — a
// markdown edit, not a function call the module system can verify. So the prompt
// layer gets asserted the same way the call graph does above.
//
// Ordering is the load-bearing part. A declaring connector skill supersedes the raw
// tool, and Part B has historically consulted intake defaults before anything else,
// so an adapter block placed BELOW them is invisible at runtime — the context loses
// every contested field and a proving run passes while proving nothing.
//
// Note what this test deliberately cannot prove: that the gate actually CALLS
// resolveIntake rather than reimplementing precedence in prose. String presence and
// block ordering are both satisfied by a hand-rolled reimplementation. Test 2
// above is what catches that, which is why resolveIntake is on its list.
test("the run skill's gate wires the setup context in, and carves out its refusals", () => {
  const skill = readFileSync(join(ROOT, "skills/rca-build/SKILL.md"), "utf8");

  assert.match(
    skill,
    // whitespace-tolerant: the chain is line-wrapped in the markdown, and where it
    // wraps is not what this asserts.
    /build metadata\s*→\s*invocation args\s*→\s*persisted context\s*→\s*connector intake defaults\s*→\s*inference/,
    "the full precedence chain must be stated, not summarised — a partial chain leaves the " +
      "position of invocation args and inference to whoever reads it",
  );

  // The ADAPTER is gone — this rewrite was the milestone that deleted it, so there
  // is no "intake-defaults paragraph" left to sit above. What survives, and what
  // actually mattered, is that the context is translated BEFORE it is resolved:
  // resolveIntake matches keys exactly, so handing it the raw artifact leaves the
  // repo fields unresolved and the gate re-asks for answers setup already proved.
  const translate = skill.indexOf("intakeFromContext(");
  const resolve = skill.indexOf("resolveIntake(");
  assert.ok(translate > 0, "Part B must translate the context through intakeFromContext");
  assert.ok(resolve > 0, "Part B must call resolveIntake");
  assert.ok(
    translate < resolve || skill.includes("intakeFromContext(read.context)"),
    "the translation must reach resolveIntake, not sit beside it",
  );

  // A JS fence naming the function, following the discoverWorkspaceRoot snippet
  // precedent in Part A. Prose alone reads as advice; a snippet reads as a call.
  const fences = [...skill.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(
    fences.some((f) => f.includes("resolveIntake(")),
    "Part B must name resolveIntake in an inline JS snippet",
  );
  assert.ok(
    fences.some((f) => f.includes("startOfRunRefusal(")),
    "Part A must name startOfRunRefusal in an inline JS snippet",
  );

  // The adapter's refusals contradict a Hard rule. An unamended contradiction is
  // not a tie: this repo's own gate history records agents following the emphatic
  // rule they encountered rather than the intended one.
  // The carve-out must be stated where the "never a blocker" rule is stated, not
  // merely somewhere in the file. Bold markers are not the property — this repo's
  // gate history records agents following the most emphatic rule they encountered
  // rather than the intended one, so an unamended contradiction is not a tie.
  // Asserted twice because the rule appears twice: at Gate close and in Hard rules.
  const carveOuts = [...skill.matchAll(/never a blocker[^.\n]*(?:\n[^.\n]*)?/gi)]
    .filter((m) => /except/i.test(m[0]) && /start-of-run context refusals/i.test(m[0]));
  assert.ok(
    carveOuts.length >= 2,
    `both "never a blocker" statements must carve out the start-of-run refusals; ` +
      `found ${carveOuts.length}`,
  );
});

// The root cause of the 23% discovery tax was DRIFT: helpers were added faster
// than the docs described them, so agents grepped lib/ at runtime to learn the
// API. Documenting it once fixes today; this test keeps it fixed.
//
// The guard is PER SKILL. A single-target version could not survive a second
// skill: a setup-only helper has no business in the run skill's API reference,
// and hiding it in INTERNAL defeats the point. So each lib module declares which
// skills drive it, and each skill declares what its flow mandates reading.
//
// Ownership is deliberately not 1:1. `rca-context.mjs` is written by the setup
// flow and read by the run skill's gate, so BOTH need its signatures. An
// at-least-one-owner rule would let `resolveIntake` be documented for setup only
// while the adapter's agent greps lib/ at runtime — the exact cost this test
// exists to prevent. Hence: every owner, not any owner.
const OWNERS = {
  "build-cleanup.mjs": ["rca-build"],
  "csv-state.mjs": ["rca-build"],
  "evidence-file.mjs": ["rca-build"],
  "repo-source.mjs": ["rca-build"],
  "routing.mjs": ["rca-build"],
  "signature.mjs": ["rca-build"],
  "state-dir.mjs": ["rca-build"],
  "tool-cache.mjs": ["rca-build"],
  "turn1-registry.mjs": ["rca-build"],
  // Built by U1-U4 of the setup milestone. Mapped ahead of existing so the
  // guard is armed the moment each module lands.
  "capability-table.mjs": ["rca-setup"],
  "discovery.mjs": ["rca-setup"],
  "verify.mjs": ["rca-setup"],
  "rca-context.mjs": ["rca-build", "rca-setup"],
};

// Internal-by-convention: replay/test seams and trivial helpers a coordinator
// never calls. Anything NOT listed here must be documented.
const INTERNAL = new Set([
  "emptyEvidenceFile", "writeEvidenceFile", "contribDirFor", "contribPathFor",
  "hasTrustworthyPrList", "stalenessOf", "makeEvidenceCache",
  "normalize",
  "selectRepresentative", "localCloneFor", "hasCommit", "ensureCommit",
  "classifyCoverage", "coverageStamp", "orderAsks", "routeAsk",
  "unavailableCapabilities", "toolCacheDirFor", "cacheKey",
  "isCacheable", "splitPipeline",
  // tool-cache module internals — agents drive the cache through
  // bin/cached-exec.mjs / bin/cached-mcp.mjs, never by importing it.
  "isRunnable", "tokenize", "isCacheableMcp", "redact", "cacheGet",
  "cachePut", "cacheStats", "mcpCacheKey",
  // replay seam
  "replayProbe",
]);

// `mandatedReading` is shared with tests/prose-budget.test.mjs — see
// tests/helpers/mandated-reading.mjs. Two copies of that parse would drift,
// which is the bug class this file exists to catch.

test("every exported lib helper is documented in every owning skill's mandated reading", () => {
  const reading = new Map();
  const readingFor = (skill) => {
    if (!reading.has(skill)) reading.set(skill, mandatedReading(skill));
    return reading.get(skill);
  };

  const modules = readdirSync(join(ROOT, "lib")).filter((f) => f.endsWith(".mjs"));

  const unmapped = modules.filter((f) => !OWNERS[f]);
  assert.deepEqual(
    unmapped,
    [],
    `unmapped lib module(s): ${unmapped.join(", ")}. Add each to OWNERS naming ` +
      `the skill(s) whose flow drives it, so the guard knows whose API reference ` +
      `must document its exports.`,
  );

  const undocumented = [];
  for (const f of modules) {
    const src = readFileSync(join(ROOT, "lib", f), "utf8");
    for (const m of src.matchAll(/^export (?:function|const) ([A-Za-z0-9_]+)/gm)) {
      const name = m[1];
      if (INTERNAL.has(name)) continue;
      for (const skill of OWNERS[f]) {
        if (!readingFor(skill).includes(name)) undocumented.push(`${f}:${name} (${skill})`);
      }
    }
  }

  assert.deepEqual(
    undocumented,
    [],
    `undocumented helper(s): ${undocumented.join(", ")}. Each must appear in the ` +
      `mandated reading of EVERY skill that owns its module — an agent that can't ` +
      `find a signature there greps lib/ at runtime, which cost 92 of 407 tool ` +
      `calls on one measured run.`,
  );
});

// The REVERSE direction, and the one this repo kept needing.
//
// Test 4 above proves every lib/ export is documented. Nothing proved the
// converse: that every symbol the prose NAMES still exists. So a rename or a
// deletion left the instructions pointing at nothing, silently, and the suite
// stayed green — because the guard only ever looked one way.
//
// This diff alone left the setup skill's Step 4 instructing an agent to call
// `verifyCapability`, `verifyGithub` and `runProbe` (all deleted) and never
// naming `validateVerification` (the function that replaced them); three files
// pointing at `loadConfig`; a config comment describing `isProbeRunnable`; and
// README/INTEGRATION offering `runRcaLoop` as a supported execution path. Every
// one of those is a symbol in prose with no referent, and every one would have
// failed this test.
test("every lib/ symbol named in prose still exists", () => {
  const exported = new Set();
  for (const f of readdirSync(join(ROOT, "lib")).filter((n) => n.endsWith(".mjs"))) {
    const src = readFileSync(join(ROOT, "lib", f), "utf8");
    for (const m of src.matchAll(/^export (?:function|const) ([A-Za-z0-9_]+)/gm)) exported.add(m[1]);
    // Internal helpers are legitimately named in rationale prose.
    for (const m of src.matchAll(/^(?:async )?function ([A-Za-z0-9_]+)/gm)) exported.add(m[1]);
  }

  // Module filenames, so `lib/loop.mjs` in prose is caught the same way.
  const modules = new Set(readdirSync(join(ROOT, "lib")).filter((n) => n.endsWith(".mjs")));

  // Words that look like calls but are not lib/ symbols: MCP tools, shell and git
  // subcommands, JS builtins, and the vocabulary of the domain.
  const NOT_LIB = new Set([
    "tfaRcaTurn", "getTfaTurnResult", "triggerRcaReport", "listTestIds", "getFailureLogs",
    "getBuildId", "getBuildFailureThemes", "listTestsInFailureTheme", "fetchBuildInsights",
    "viewRca", "AskUserQuestion", "ToolSearch", "Promise", "JSON", "Object", "Array", "Map",
    "Set", "String", "Number", "Boolean", "Date", "Math", "RegExp", "Error", "if", "for",
    "while", "switch", "catch", "function", "return", "await", "const", "let", "typeof",
    "require", "import", "export", "ls", "grep", "cat", "node", "npm", "git", "gh", "jq",
    // Node builtins and the agent's OWN helpers in illustrative snippets — named
    // here so the list of real dangling symbols stays readable.
    "execFileSync", "readFileSync", "writeFileSync", "existsSync", "execFile",
    "mcpResultFor", "execProbe", "buildMeta", "invocationArgs", "connectorDefaults",
    // domain vocabulary that happens to be camelCase
    "testRunId", "buildId", "threadId", "turnId", "clusterId", "writerId", "rcaDone",
    "baseBranch", "homeRepo", "logIndex", "metricsNamespace", "runtimeKind",
    "serviceNames", "automationRepo", "prsInWindow", "prsSearched", "deployState",
    "clusterIds", "localRepos", "suspectWindow", "schemaVersion", "capturedAtMs",
    "turnMessageMaxChars", "softPendingDrain", "reaperHeartbeatTtlSec", "stateDir",
    "evidenceRouting", "seedHints", "scopeFields", "mcpServers", "repoFiles",
    "exemptFromDiscoveryReport", "customCapabilities", "checkedBy", "nextAction",
    "errorClass", "gapClass", "accessLevel", "resolvedScope", "unresolvedFields",
    "failureCategory", "errorSummary", "filePath", "isFlaky", "rootCause",
    "relatedPrs", "failureType", "nextCursor", "buildThemeWorkflow", "buildThemeId",
    "buildFailureThemeId", "buildUuid", "includeFailureDetail", "viewReport",
    "lastGreenRef", "fallbackRef", "isFallback", "maxAgeMs", "dryRun", "nowMs",
    "preSeed", "workloadsCovered", "reposCovered", "reposGapped", "mergedCount",
    "windowDays", "rotationGuidance", "connectorSkills", "scopeProbes",
    // placeholders and wire vocabulary, not lib symbols
    "pluginRoot", "evidenceFile", "turnCap", "evidenceType", "claude_ai_Slack",
    // Removed FIELD names that prose legitimately still names in order to explain
    // what changed. This check cannot tell "naming a deleted thing to explain it"
    // from "instructing a call to a deleted thing", so the difference is an
    // explicit allowlist rather than a guess.
    "logIndexes", "kubectlSweep", "victorialogs", "probesByExecutable", "mcpProbe",
    "runRcaLoop",
    "scopeProbe", "isProbeRunnable", "isPermittedProbeLeader", "clusterAndPersist",
    "clusterRows", "computeSignature", "clustersFromThemes", "renderGlimpse",
    "makeEvidenceCache", "resolveBaseline", "discoveryHints", "exemptFrom",
  ]);

  const prose = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith(".md")) prose.push([p, readFileSync(p, "utf8")]);
    }
  };
  walk(join(ROOT, "skills"));
  walk(join(ROOT, "agents"));
  for (const f of ["README.md", "INTEGRATION.md"]) {
    prose.push([join(ROOT, f), readFileSync(join(ROOT, f), "utf8")]);
  }

  const dangling = [];
  for (const [path, text] of prose) {
    // Backticked camelCase — this codebase's function-naming convention, so a
    // backticked `verifyGithub` is prose presenting a lib symbol whether or not a
    // paren follows it. Requiring the paren is what let Step 4 keep naming six
    // deleted functions: they were written as `verifyCapability`, bare.
    for (const m of text.matchAll(/`([a-z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*)`/g)) {
      const name = m[1];
      if (NOT_LIB.has(name) || exported.has(name)) continue;
      dangling.push(`${path.replace(ROOT, "")}: ${name}`);
    }
    // And calls inside fenced blocks, which is where an agent reads its snippets.
    for (const fence of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
      for (const m of fence[1].matchAll(/\b([a-z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*)\s*\(/g)) {
        const name = m[1];
        if (NOT_LIB.has(name) || exported.has(name)) continue;
        dangling.push(`${path.replace(ROOT, "")}: ${name}() [fenced]`);
      }
    }
    // A named lib module that no longer exists.
    for (const m of text.matchAll(/lib\/([a-z0-9-]+\.mjs)/g)) {
      if (modules.has(m[1])) continue;
      // A sentence that says the module WAS DELETED is documentation, not a
      // dangling instruction. Narrow on purpose: the words have to be right there.
      const around = text.slice(Math.max(0, m.index - 200), m.index + 200);
      if (/\bdeleted\b|\bremoved\b|\bused to\b/i.test(around)) continue;
      dangling.push(`${path.replace(ROOT, "")}: lib/${m[1]}`);
    }
  }

  assert.deepEqual(
    [...new Set(dangling)].sort(),
    [],
    `prose names ${new Set(dangling).size} lib/ symbol(s) that do not exist. An agent ` +
      `following an instruction to call a deleted function has no way to recover — and ` +
      `the forward guard above cannot see this, because it only checks that real exports ` +
      `are documented, never that documented symbols are real.`,
  );
});
