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
    // Definition line doesn't count as a call site.
    const uses = haystack.split(fn).length - 1;
    assert.ok(uses >= 2, `${fn} appears ${uses}x outside tests — defined but never driven`);
  }
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
  "coverage.mjs": ["rca-build"],
  "csv-state.mjs": ["rca-build"],
  "evidence-cache.mjs": ["rca-build"],
  "evidence-file.mjs": ["rca-build"],
  "glimpse.mjs": ["rca-build"],
  "loop.mjs": ["rca-build"],
  "repo-source.mjs": ["rca-build"],
  "routing.mjs": ["rca-build"],
  "signature.mjs": ["rca-build"],
  "state-dir.mjs": ["rca-build"],
  "theme-clustering.mjs": ["rca-build"],
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
  "replaySubmit", "replayRead", "normalize", "computeSignature",
  "selectRepresentative", "localCloneFor", "hasCommit", "ensureCommit",
  "classifyCoverage", "coverageStamp", "orderAsks", "routeAsk",
  "unavailableCapabilities", "renderGlimpse", "toolCacheDirFor", "cacheKey",
  "isCacheable", "splitPipeline",
  // tool-cache module internals — agents drive the cache through
  // bin/cached-exec.mjs / bin/cached-mcp.mjs, never by importing it.
  "isRunnable", "tokenize", "isCacheableMcp", "redact", "cacheGet",
  "cachePut", "cacheStats", "mcpCacheKey",
  // probe validation — imported by lib/capability-table.mjs, never by an agent.
  "isProbeRunnable", "isPermittedProbeLeader",
]);

/**
 * The set of files a skill's flow mandates loading: its own body, plus every
 * pluginRoot-qualified path listed under its `## Mandated reading` heading.
 *
 * The body counts as its own mandated reading because an agent always reads it.
 * That is what lets rca-build's inline API reference keep satisfying the guard
 * where it already sits, instead of forcing a mechanical relocation.
 */
function mandatedReading(skill) {
  const bodyPath = join(ROOT, "skills", skill, "SKILL.md");
  const body = readFileSync(bodyPath, "utf8");
  const texts = [body];

  const section = body.split(/^## Mandated reading\s*$/m)[1];
  assert.ok(
    section !== undefined,
    `skills/${skill}/SKILL.md has no "## Mandated reading" section — the guard ` +
      `cannot tell which files this skill's flow requires loading.`,
  );

  const declared = section.split(/^## /m)[0];
  for (const m of declared.matchAll(/`<pluginRoot>\/([^`]+)`/g)) {
    const p = join(ROOT, m[1]);
    if (p === bodyPath) continue; // already included
    if (existsSync(p)) texts.push(readFileSync(p, "utf8"));
  }
  return texts.join("\n");
}

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
