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
import { readFileAt } from "../lib/repo-source.mjs";
import { toolCacheDirFor, cacheKey, cacheGet, cachePut } from "../lib/tool-cache.mjs";

const [, , buildId, writerId, repo, sha, path, ...flags] = process.argv;
if (!buildId || !writerId || !repo || !sha || !path) {
  console.error("usage: repo-read.mjs <buildId> <writerId> <org/repo> <sha> <path> [--fetch]");
  console.error("  sha must be a COMMIT SHA (a branch name is refused — it can read stale code)");
  process.exit(2);
}

// NO DEFAULTS for either of these. The plugin is generic over product and
// infra: which repos exist, where they are checked out, and what branch ships
// are facts the CONNECTOR SKILL owns and the gate resolves — never something
// this plugin should assume. Baking in a workspace path or a branch name would
// silently make the plugin work for exactly one product on exactly one
// machine, which is the failure mode the whole capability-manifest design
// exists to avoid.
const workspaceRoot = process.env.RCA_WORKSPACE_ROOT;
if (!workspaceRoot) {
  console.error("[repo-read] RCA_WORKSPACE_ROOT is not set.");
  console.error("  It must come from the gate/connector skill — the plugin does not assume a workspace layout.");
  console.error("  Set it to the directory holding the local clones, e.g. RCA_WORKSPACE_ROOT=$(pwd)/..");
  process.exit(2);
}
// Only needed to widen a fetch on a miss; a sha-only fetch is attempted when
// absent. Supplied by the connector skill, which knows the shipping branch.
const branch = process.env.RCA_SHIPPING_BRANCH || undefined;
const allowFetch = flags.includes("--fetch");

const local = readFileAt({ repo, sha, path, workspaceRoot, branch, allowFetch });

if (local.ok) {
  console.error(`[repo-read LOCAL ${repo}@${sha.slice(0, 8)} ${local.content.length}B — no network]`);
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
