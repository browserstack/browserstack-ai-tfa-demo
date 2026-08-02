#!/usr/bin/env node
// Read a repo file at a pinned commit, preferring a local clone over the
// network, and falling back to `gh` automatically.
//
//   node bin/repo-read.mjs <buildId> <writerId> <org/repo> <sha> <path> [--fetch]
//
// Measured on this workspace: local `git show` ~37ms vs `gh api` ~1022ms for
// the same file, byte-identical. One targeted `git fetch` (~5s) makes a stale
// clone usable, so the fetch pays for itself after ~6 reads of that repo.
//
// SHA-PINNED ONLY. A branch name is refused: local clones are routinely behind
// (12 commits, on this machine), and reading a branch locally returned
// different bytes than the real head — which for RCA means confidently
// reasoning about code that never shipped. Get the sha from the evidence
// file's `deployState` (branch tip at build start), which Step 4 records.
//
// Generic by construction: the workspace root and shipping branch are INPUTS
// (RCA_WORKSPACE_ROOT / RCA_SHIPPING_BRANCH) supplied by the gate and the
// product's connector skill. This file names no repo, no branch and no path.
//
// Remote results still go through the tool cache, so a repo with no local
// clone degrades to exactly the previous behaviour.

import { execFileSync } from "node:child_process";
import { readFileAt, discoverWorkspaceRoot } from "../lib/repo-source.mjs";
import { toolCacheDirFor, cacheKey, cacheGet, cachePut } from "../lib/tool-cache.mjs";

const [, , buildId, writerId, repo, sha, path, ...flags] = process.argv;
if (!buildId || !writerId || !repo || !sha || !path) {
  console.error("usage: repo-read.mjs <buildId> <writerId> <org/repo> <sha> <path> [--fetch]");
  console.error("  sha must be a COMMIT SHA (a branch name is refused — it can read stale code)");
  process.exit(2);
}

// NO HARDCODED WORKSPACE OR BRANCH. Which repos exist, where they are checked
// out, and what branch ships are facts the CONNECTOR SKILL owns and the gate
// resolves. Baking either in would make the plugin work for exactly one
// product on one machine — the coupling the capability-manifest design exists
// to avoid.
//
// Resolution order, cheapest and most authoritative first:
//   1. the evidence file's `localRepos` — resolved ONCE at the gate, so a
//      coordinator does no filesystem probing at all;
//   2. RCA_WORKSPACE_ROOT, if the caller set it;
//   3. a bounded structural guess (this dir, its parent, grandparent),
//      accepted only if it actually contains the repo being asked for.
// Anything else: give up and use the network. Guessing harder risks reading
// an unrelated checkout, which is silently wrong rather than merely slow.
let workspaceRoot = process.env.RCA_WORKSPACE_ROOT;
let rootSource = workspaceRoot ? "RCA_WORKSPACE_ROOT" : null;

// Derived from the buildId we already have, so there is no env var for a
// dispatch prompt to forget; an explicit override still wins.
if (!workspaceRoot) {
  try {
    const { readEvidenceFile, evidencePathFor } = await import("../lib/evidence-file.mjs");
    const evidencePath = process.env.RCA_EVIDENCE_FILE
      || evidencePathFor(buildId, process.env.RCA_STATE_DIR ?? "");
    const lr = readEvidenceFile(evidencePath)?.localRepos;
    if (lr?.workspaceRoot) { workspaceRoot = lr.workspaceRoot; rootSource = "evidence-file (resolved at gate)"; }
  } catch { /* evidence file optional */ }
}

if (!workspaceRoot) {
  const here = new URL("..", import.meta.url).pathname;
  const d = discoverWorkspaceRoot({ repos: [repo], from: here, maxTries: 3 });
  if (d.root) { workspaceRoot = d.root; rootSource = `auto-discovered (${d.tried.length} tr${d.tried.length === 1 ? "y" : "ies"})`; }
  else console.error(`[repo-read] no local workspace found — ${d.reason}`);
}
// Only needed to widen a fetch on a miss; a sha-only fetch is attempted when
// absent. Supplied by the connector skill, which knows the shipping branch.
const branch = process.env.RCA_SHIPPING_BRANCH || undefined;
const allowFetch = flags.includes("--fetch");

const local = workspaceRoot
  ? readFileAt({ repo, sha, path, workspaceRoot, branch, allowFetch })
  : { ok: false, source: "remote-needed", reason: "no local workspace resolved" };

if (local.ok) {
  console.error(`[repo-read LOCAL ${repo}@${sha.slice(0, 8)} ${local.content.length}B — no network, root via ${rootSource}]`);
  process.stdout.write(local.content);
  process.exit(0);
}

// A path genuinely absent at that commit is an answer; don't re-ask the network.
if (local.source === "local") {
  console.error(`[repo-read LOCAL ${repo}@${sha.slice(0, 8)}] ${local.reason}`);
  process.exit(1);
}

console.error(`[repo-read -> remote] ${local.reason}`);

const dir = toolCacheDirFor(buildId, process.env.RCA_STATE_DIR ?? "");
const cmd = `gh api repos/${repo}/contents/${path}?ref=${sha}`;
const key = cacheKey(cmd);
const hit = cacheGet(dir, key);
if (hit) {
  console.error(`[repo-read CACHE HIT ${key} — captured by ${hit.writerId ?? "?"}, ${hit.bytes}B]`);
  process.stdout.write(hit.stdout);
  process.exit(0);
}

let out;
try {
  const raw = execFileSync("gh", ["api", `repos/${repo}/contents/${path}?ref=${sha}`, "--jq", ".content"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  out = Buffer.from(raw.replace(/\s+/g, ""), "base64").toString("utf8");
} catch (err) {
  if (err.stderr) process.stderr.write(err.stderr.toString());
  console.error(`[repo-read REMOTE failed, NOT cached]`);
  process.exit(typeof err.status === "number" ? err.status : 1);
}

if (out.trim() !== "") {
  cachePut(dir, key, { command: cmd, writerId, stdout: out, exitCode: 0 }, Date.now());
  console.error(`[repo-read REMOTE ${out.length}B — cached]`);
}
process.stdout.write(out);
