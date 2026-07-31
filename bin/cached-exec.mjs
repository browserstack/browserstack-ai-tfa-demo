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
//   node bin/cached-exec.mjs <buildId> <writerId> -        # command on STDIN
//   node bin/cached-exec.mjs <buildId> --stats
//
// Wrap only the expensive fetch and leave filtering to the outer shell:
//   node bin/cached-exec.mjs "$B" 3895581484 'gh api repos/o/r/contents/f' | jq -r .content | head -40
// Two coordinators piping the same fetch through different greps then share
// one cache entry, instead of each paying for the fetch.
//
// TWO GOTCHAS, both hit in real use:
//
//  1. Hit/miss banners go to STDERR, so stdout stays byte-identical to the raw
//     command and `| jq` works. But `2>&1 | jq` merges the banner back into
//     the pipe and jq dies on it ("Invalid literal at line 1, column 12").
//     Don't redirect stderr into a pipe; if you must silence it, `2>/dev/null`
//     — though that also hides whether you got a hit.
//
//  2. Nested single quotes. A command containing its own `'…'` (typically
//     `--jq '.[] | "\(.number)"'`) cannot be passed inside a single-quoted
//     argument — the outer shell terminates the string early and the argument
//     arrives mangled. Use `-` and pipe the command in on stdin instead:
//       printf '%s' 'gh pr list -R o/r --json number --jq ".[].number"' \
//         | node bin/cached-exec.mjs "$B" 3895 -

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  toolCacheDirFor, cacheKey, cacheGet, cachePut, cacheStats, isRunnable, tokenize,
} from "../lib/tool-cache.mjs";

const [, , buildId, writerOrFlag, commandArg] = process.argv;

// `-` means the command arrives on stdin, which sidesteps the nested-quoting
// problem entirely (see gotcha 2 above).
let command = commandArg;
if (command === "-") {
  try {
    command = readFileSync(0, "utf8").trim();
  } catch {
    command = "";
  }
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
    // Capture stderr instead of letting it inherit. Default execFileSync
    // BOTH inherits stderr to the parent AND captures it on the error, so
    // relaying `err.stderr` ourselves printed everything three times.
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (err) {
  // Preserve the real behaviour of the wrapped command: emit whatever it
  // produced and exit non-zero. Deliberately NOT cached — a transient
  // failure (rate limit, expired token) must not become a permanent answer.
  stdout = (err.stdout ?? "").toString();
  exitCode = typeof err.status === "number" ? err.status : 1;
  if (err.stderr) process.stderr.write(err.stderr.toString()); // now the only copy
  console.error(`[tool-cache MISS ${key} — command exited ${exitCode}, NOT cached]`);
  process.stdout.write(stdout);
  process.exit(exitCode);
}

// An empty result is not stored. It is usually a wrong selector or a silently
// failed lookup, and caching it makes a sticky, invisible negative that every
// later reader inherits — the expensive kind of wrong.
if (stdout.trim() === "") {
  console.error(`[tool-cache MISS ${key} — empty result, NOT cached]`);
  process.stdout.write(stdout);
  process.exit(0);
}

// nowMs is read here, at the process edge, rather than inside lib/ — the
// library keeps its no-clock discipline so it stays sandbox-safe.
cachePut(dir, key, { command, writerId: writerOrFlag, stdout, exitCode }, Date.now());
console.error(`[tool-cache MISS ${key} — stored ${stdout.length}B]`);
process.stdout.write(stdout);
