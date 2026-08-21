#!/usr/bin/env node
// Run a command through the build's tool cache, in ONE tool call.
//
// Cached: IMMUTABLE reads (sha-pinned gh api, git show/cat-file/ls-tree/log with
// a sha) AND run-stable repo reads (gh pr view/diff/list, gh api repo reads, gh
// search, read-only git) — the latter don't change within a single minutes-long
// build RCA and are fetched identically by every sibling confirming the same
// suspect PRs. Live state (kubectl/curl/logs) passes through uncached. Mutations
// are refused.
//
// Usage:
//   node bin/cached-exec.mjs <buildId> <writerId> '<command>'
//   node bin/cached-exec.mjs <buildId> <writerId> -        # command on STDIN
//   node bin/cached-exec.mjs <buildId> --stats

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  toolCacheDirFor, cacheKey, cacheGet, cachePut, cacheStats,
  isCacheable, isImmutableRead, isRunStableRead, banner,
} from "../lib/tool-cache.mjs";

const [, , buildId, writerOrFlag, commandArg] = process.argv;

let command = commandArg;
if (command === "-") {
  try { command = readFileSync(0, "utf8").trim(); } catch { command = ""; }
  if (!command) {
    console.error("[tool-cache] '-' given but stdin was empty");
    process.exit(2);
  }
}

if (!buildId || (writerOrFlag !== "--stats" && !command)) {
  console.error("usage: cached-exec.mjs <buildId> <writerId> '<command>'");
  console.error("       cached-exec.mjs <buildId> --stats");
  process.exit(2);
}

const dir = toolCacheDirFor(buildId, process.env.RCA_STATE_DIR ?? "");
const logPath = process.env.TOOLCACHE_LOG ?? "";

if (writerOrFlag === "--stats") {
  console.log(JSON.stringify({ cacheDir: dir, ...cacheStats(dir) }, null, 2));
  process.exit(0);
}

// Refuse mutations.
if (!isCacheable(command)) {
  console.error(`[tool-cache REFUSED] command looks mutating`);
  console.error(`  command: ${command}`);
  process.exit(2);
}

// Run a command via the shell and return { stdout, exitCode }.
function run(cmd) {
  try {
    return {
      stdout: execSync(cmd, {
        encoding: "utf8",
        shell: true,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      exitCode: 0,
    };
  } catch (err) {
    if (err.stderr) process.stderr.write(err.stderr.toString());
    return {
      stdout: (err.stdout ?? "").toString(),
      exitCode: typeof err.status === "number" ? err.status : 1,
    };
  }
}

const shouldCache = isImmutableRead(command) || isRunStableRead(command);
const key = cacheKey(command);

// Try cache only for cacheable reads.
if (shouldCache) {
  const hit = cacheGet(dir, key);
  if (hit) {
    banner(`[tool-cache HIT ${key} — captured by ${hit.writerId ?? "?"}, ${hit.bytes}B]`, logPath);
    process.stdout.write(hit.stdout);
    process.exit(0);
  }
}

// Execute the command (cached or pass-through).
const res = run(command);

if (res.exitCode !== 0) {
  banner(`[tool-cache MISS ${key} — exited ${res.exitCode}, NOT cached]`, logPath);
  process.stdout.write(res.stdout);
  process.exit(res.exitCode);
}

if (shouldCache) {
  if (res.stdout.trim() === "") {
    banner(`[tool-cache MISS ${key} — empty result, NOT cached]`, logPath);
  } else {
    cachePut(dir, key, { command, writerId: writerOrFlag, stdout: res.stdout, exitCode: 0 }, Date.now());
    banner(`[tool-cache MISS ${key} — stored ${res.stdout.length}B]`, logPath);
  }
} else {
  banner(`[tool-cache PASS-THROUGH — not a cacheable read]`, logPath);
}

process.stdout.write(res.stdout);
process.exit(0);
