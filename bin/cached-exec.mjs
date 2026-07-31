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

// Parse into a fetch + filter chain before anything runs.
const gate = isRunnable(command);
if (!gate.ok) {
  console.error(`[tool-cache REFUSED] ${gate.reason}`);
  console.error(`  command: ${command}`);
  process.exit(2);
}

// Key on the FETCH ONLY. Downstream filters are pure text transforms, so two
// agents filtering the same fetch differently share one cached network call.
const key = cacheKey(gate.fetchText);

// Run one argv with `input` on stdin, no shell. Returns { stdout, exitCode }.
function run(argv, input) {
  try {
    return {
      stdout: execFileSync(argv[0], argv.slice(1), {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        // Capture stderr rather than let it inherit: execFileSync otherwise
        // BOTH inherits and captures, so relaying it ourselves printed
        // failures three times.
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        ...(input === undefined ? {} : { input }),
      }),
      exitCode: 0,
    };
  } catch (err) {
    if (err.stderr) process.stderr.write(err.stderr.toString()); // the only copy
    return {
      stdout: (err.stdout ?? "").toString(),
      exitCode: typeof err.status === "number" ? err.status : 1,
    };
  }
}

let fetched;
const hit = cacheGet(dir, key);
if (hit) {
  console.error(`[tool-cache HIT ${key} — captured by ${hit.writerId ?? "?"}, ${hit.bytes}B]`);
  fetched = hit.stdout;
} else {
  const res = run(gate.fetch, undefined);
  fetched = res.stdout;
  if (res.exitCode !== 0) {
    // Preserve the real behaviour. Deliberately NOT cached — a transient
    // failure (rate limit, expired token) must not become a permanent answer.
    console.error(`[tool-cache MISS ${key} — fetch exited ${res.exitCode}, NOT cached]`);
    process.stdout.write(fetched);
    process.exit(res.exitCode);
  }
  if (fetched.trim() === "") {
    // An empty result is usually a wrong selector or a silently failed lookup;
    // caching it creates a sticky, invisible negative for every later reader.
    console.error(`[tool-cache MISS ${key} — empty result, NOT cached]`);
  } else {
    // nowMs is read here, at the process edge — lib/ keeps its no-clock
    // discipline so it stays sandbox-safe.
    cachePut(dir, key, { command: gate.fetchText, writerId: writerOrFlag, stdout: fetched, exitCode: 0 }, Date.now());
    console.error(`[tool-cache MISS ${key} — stored ${fetched.length}B]`);
  }
}

// Apply the filter chain to whatever the fetch produced (cached or fresh).
let out = fetched;
let finalExit = 0;
for (const f of gate.filters) {
  const res = run(f, out);
  out = res.stdout;
  if (res.exitCode !== 0) { finalExit = res.exitCode; break; }
}

process.stdout.write(out);
process.exit(finalExit);
