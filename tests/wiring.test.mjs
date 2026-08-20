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
    "hasTrustworthyPrList", "stalenessOf", "makeEvidenceCache",
    "replaySubmit", "replayRead",
    "selectRepresentative", "localCloneFor", "hasCommit", "ensureCommit",
    "classifyCoverage", "coverageStamp", "orderAsks", "routeAsk",
    "unavailableCapabilities", "toolCacheDirFor", "cacheKey",
    "isCacheable",
    // tool-cache module internals — agents drive the cache through
    // bin/cached-exec.mjs / bin/cached-mcp.mjs, never by importing it.
    "isImmutableRead", "isCacheableMcp", "redact", "cacheGet",
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
