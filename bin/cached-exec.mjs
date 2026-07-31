#!/usr/bin/env node
// Run a READ-ONLY command through the build's tool cache, in ONE tool call.
//
// Why a wrapper: a "check cache / run / store" sequence done by hand costs
// three tool calls to save one, which is worse than not caching. This collapses
// it to a single call that behaves exactly like the underlying command —
// same stdout, same exit code — but only actually executes on a miss.
//
// Usage (command is ONE argument, so the caller's own quoting survives):
//   node bin/cached-exec.mjs <buildId> <writerId> '<command>'
//   node bin/cached-exec.mjs <buildId> --stats
//
// Wrap only the expensive fetch and leave filtering to the outer shell:
//   node bin/cached-exec.mjs "$B" 3895581484 'gh api repos/o/r/contents/f' | jq -r .content | head -40
// Two coordinators piping the same fetch through different greps then share
// one cache entry, instead of each paying for the fetch.
//
// Cache hits/misses are reported on STDERR so stdout stays byte-identical to
// the raw command — piping into `grep`/`head`/`jq` is unaffected.

import { execFileSync } from "node:child_process";
import {
  toolCacheDirFor, cacheKey, cacheGet, cachePut, cacheStats, isRunnable, tokenize,
} from "../lib/tool-cache.mjs";

const [, , buildId, writerOrFlag, command] = process.argv;

if (!buildId || (writerOrFlag !== "--stats" && !command)) {
  console.error("usage: cached-exec.mjs <buildId> <writerId> '<command>'");
  console.error("       cached-exec.mjs <buildId> --stats");
  process.exit(2);
}

const dir = toolCacheDirFor(buildId, process.env.RCA_STATE_DIR ?? "");

if (writerOrFlag === "--stats") {
  const s = cacheStats(dir);
  console.log(JSON.stringify({ cacheDir: dir, ...s }, null, 2));
  process.exit(0);
}

const key = cacheKey(command);
const hit = cacheGet(dir, key);

if (hit) {
  console.error(`[tool-cache HIT ${key} — captured by ${hit.writerId ?? "?"}, ${hit.bytes}B]`);
  process.stdout.write(hit.stdout);
  process.exit(0);
}

// Gate before running anything (allowlisted read-only leader, no chaining).
const gate = isRunnable(command);
if (!gate.ok) {
  console.error(`[tool-cache REFUSED] ${gate.reason}`);
  console.error(`  command: ${command}`);
  process.exit(2);
}

// No shell: tokenize ourselves and execFile the binary directly, so shell
// metacharacters inside arguments (a --jq expression, an XPath, a LogsQL
// filter) are passed through literally and cannot start a second command.
let argv;
try {
  argv = tokenize(command);
} catch (err) {
  console.error(`[tool-cache REFUSED] ${err.message}`);
  process.exit(2);
}

let stdout = "";
let exitCode = 0;
try {
  stdout = execFileSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (err) {
  // Preserve the real behaviour of the wrapped command: emit whatever it
  // produced and exit non-zero. Deliberately NOT cached — a transient
  // failure (rate limit, expired token) must not become a permanent answer.
  stdout = (err.stdout ?? "").toString();
  exitCode = typeof err.status === "number" ? err.status : 1;
  if (err.stderr) process.stderr.write(err.stderr.toString());
  console.error(`[tool-cache MISS ${key} — command exited ${exitCode}, NOT cached]`);
  process.stdout.write(stdout);
  process.exit(exitCode);
}

// nowMs is read here, at the process edge, rather than inside lib/ — the
// library keeps its no-clock discipline so it stays sandbox-safe.
cachePut(dir, key, { command, writerId: writerOrFlag, stdout, exitCode }, Date.now());
console.error(`[tool-cache MISS ${key} — stored ${stdout.length}B]`);
process.stdout.write(stdout);
