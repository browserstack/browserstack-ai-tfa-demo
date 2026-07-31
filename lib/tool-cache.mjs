// Build-scoped memo cache for READ-ONLY tool calls (`gh`, `kubectl`, curl, …).
//
// The evidence file (`evidence-file.mjs`) shares *digested findings* whose
// shape the schema knows about — deploy state, PRs, log sweeps. But a
// coordinator's real tool traffic is mostly raw lookups that fit no schema
// slot: fetching a spec file's contents at a ref, listing a git tree, running
// a code search. Measured on one real 10-test build: `gh` was 37% of all
// coordinator tool calls, and 46 of them were byte-identical commands re-run
// by different coordinators — the same BStackAutomation spec fetched 12
// times, a frontend component 5 times.
//
// This module memoizes at the CALL level instead, so duplication is caught
// regardless of what the call was for. Any coordinator about to run a
// read-only command checks here first; on a miss it runs the command and
// stores the result for everyone else.
//
// CONCURRENCY: one file per cache KEY (`<sha>.json`), not one per writer.
// Distinct calls write distinct files; two agents racing on the *same* call
// write byte-identical content, so the race is benign. Writes go through a
// temp file + `rename`, which is atomic on POSIX, so a reader never observes
// a half-written entry. No locking, no lost updates, no torn reads.
//
// WHAT IS NOT CACHED (deliberate):
//   - Any command that fails (non-zero exit). A transient `gh` rate-limit or
//     an expired kube token must never be memoized into a persistent "answer"
//     that poisons every later reader.
//   - Anything matching the mutation denylist below. The plugin is read-only
//     by contract, but caching is a correctness-sensitive place to trust that
//     contract blindly, so mutations are refused defensively.
//   - Secrets: values that look like tokens/passwords are redacted from the
//     stored payload before it ever touches disk.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

/** Per-build cache directory, sitting alongside the state CSV and evidence
 * file under the same OS-temp convention. */
export function toolCacheDirFor(buildId, stateDir = "") {
  const safe = String(buildId ?? "").replace(/[^A-Za-z0-9._-]/g, "_") || "unknown-build";
  const dir = stateDir && String(stateDir).trim() !== "" ? String(stateDir) : join(tmpdir(), "bstack-rca");
  return join(dir, `rca-toolcache.${safe}`);
}

/** Stable key for one call. Whitespace is normalized so trivially-different
 * formatting of the same command still hits, but nothing else is rewritten —
 * `| head -20` vs `| head -200` genuinely return different output and must
 * stay distinct keys. */
export function cacheKey(command) {
  const norm = String(command ?? "").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(norm).digest("hex").slice(0, 24);
}

// Commands that must never be memoized, even if someone wires this into a
// non-read-only context by mistake.
const MUTATING = /\b(rm|mv|cp|dd|truncate|tee)\b|>\s*\/|\bgit\s+(push|commit|merge|rebase|reset|checkout|clean)\b|\bgh\s+(pr\s+(create|merge|close|edit|comment|review)|issue\s+(create|close|edit|comment)|release\s+create|repo\s+(create|delete)|api\s+(-X\s*)?(POST|PUT|PATCH|DELETE))|\bkubectl\s+(apply|delete|edit|patch|scale|create|replace|annotate|label|cordon|drain|exec|cp|port-forward|rollout\s+(undo|restart|pause|resume))\b|\bcurl\b[^|]*\s-(X|-request)\s*(POST|PUT|PATCH|DELETE)/i;

export function isCacheable(command) {
  return !MUTATING.test(String(command ?? ""));
}

// Read-only data-fetching binaries this wrapper will run. Anything else is
// refused outright.
const ALLOWED_LEADER = /^\s*(gh|kubectl|curl|git)\s/;

// Shell constructs that chain a *second* command onto the one being cached:
// `;`, `&&`, `||`, background `&`, command substitution, and output redirects.
// Plain pipes are allowed on purpose — `| jq`, `| grep`, `| head` are how
// callers narrow a fetch, and they don't introduce a new root command.
const CHAINING = /[;&]|\|\||\$\(|`|>>?/;

/**
 * Gate for `bin/cached-exec.mjs`. Returns `{ ok, reason }`.
 *
 * Scope note, stated plainly: this is defense-in-depth, NOT a security
 * boundary. The only caller is a coordinator agent that already has direct
 * shell access via its Bash tool, so the wrapper grants no capability the
 * caller lacks and cannot meaningfully contain a caller that wants to misuse
 * it. What it does buy: a fat-fingered or model-hallucinated command can't
 * quietly run something mutating *through the cache path* and get memoized,
 * and refusing `;`-chained loops nudges callers toward one-fetch-per-call,
 * which caches far better anyway.
 */
export function isRunnable(command) {
  const c = String(command ?? "");
  if (!ALLOWED_LEADER.test(c)) {
    return { ok: false, reason: "command must start with gh, kubectl, curl, or git" };
  }
  if (CHAINING.test(c)) {
    return {
      ok: false,
      reason: "chaining/substitution/redirect not allowed — issue one fetch per call (pipes to jq/grep/head are fine outside the wrapper)",
    };
  }
  if (!isCacheable(c)) return { ok: false, reason: "command looks mutating" };
  return { ok: true };
}

/**
 * Split a command string into argv the way a shell would for the simple cases
 * we allow — honouring single/double quotes — WITHOUT invoking a shell. The
 * caller then runs `execFile(argv[0], argv.slice(1))`, so no shell ever
 * interprets metacharacters and command injection has no surface. Throws on
 * an unterminated quote rather than guessing.
 */
export function tokenize(command) {
  const out = [];
  let cur = "";
  let quote = null;
  let started = false;
  for (const ch of String(command ?? "")) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started) { out.push(cur); cur = ""; started = false; }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (quote) throw new Error("unterminated quote in command");
  if (started) out.push(cur);
  return out;
}

// ---- MCP calls ------------------------------------------------------------

// Stateful MCP tools that must NEVER be memoized. `tfaRcaTurn` advances a
// conversation and `getTfaTurnResult` reads a turn whose status is *expected*
// to change between reads — serving either from cache would be actively
// wrong, not merely stale.
const MCP_NEVER = /tfaRcaTurn|getTfaTurnResult|triggerRcaReport/i;

export function isCacheableMcp(toolName) {
  return !MCP_NEVER.test(String(toolName ?? ""));
}

/** Key an MCP call by tool name + canonicalized args (object keys sorted), so
 * the same query written with its arguments in a different order still hits. */
export function mcpCacheKey(toolName, args) {
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      return Object.keys(v).sort().reduce((a, k) => { a[k] = canon(v[k]); return a; }, {});
    }
    return v;
  };
  const payload = JSON.stringify({ tool: String(toolName ?? ""), args: canon(args ?? {}) });
  return createHash("sha256").update(payload).digest("hex").slice(0, 24);
}

// Redact the REST OF THE LINE after a secret-ish key, not just the next
// token: `Authorization: Bearer <tok>` puts the actual credential in the
// second word, so a `\S+` capture would leave it sitting on disk.
const SECRET_LINE =
  /((?:token|authorization|api[_-]?key|secret|password|passwd|bearer|access[_-]?key)\s*[=:]\s*)([^\r\n]*)/gi;

/** Redact anything token-shaped before it is persisted. The cache lives in
 * temp, but a cached `gh api` response or log line could still carry a
 * credential, and "it's only temp" is not a reason to write one to disk. */
export function redact(text) {
  return String(text ?? "").replace(SECRET_LINE, (_m, k) => `${k}<redacted>`);
}

const MAX_BYTES = 256 * 1024;

export function cacheGet(cacheDir, key) {
  const p = join(cacheDir, `${key}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null; // half-written or corrupt -> treat as a miss, never throw
  }
}

/** Atomic write: temp file + rename, so concurrent readers only ever see a
 * complete entry. `nowMs` is passed in (same clock discipline as the rest of
 * lib/). Returns the stored entry. */
export function cachePut(cacheDir, key, entry, nowMs) {
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const raw = redact(entry.stdout ?? "");
  const truncated = raw.length > MAX_BYTES;
  const rec = {
    key,
    command: entry.command,
    writerId: entry.writerId ?? null,
    capturedAtMs: nowMs,
    exitCode: entry.exitCode ?? 0,
    truncated,
    bytes: raw.length,
    stdout: truncated ? raw.slice(0, MAX_BYTES) + "\n… [truncated by tool-cache]" : raw,
  };
  const finalPath = join(cacheDir, `${key}.json`);
  const tmpPath = join(cacheDir, `.${key}.${process.pid}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(rec, null, 2), "utf8");
  renameSync(tmpPath, finalPath); // atomic on POSIX
  return rec;
}

/** Cache-wide counters for the run's summary — how much duplicate work this
 * actually saved, rather than assuming it saved any. */
export function cacheStats(cacheDir) {
  if (!existsSync(cacheDir)) return { entries: 0, bytes: 0 };
  let entries = 0;
  let bytes = 0;
  for (const f of readdirSync(cacheDir)) {
    if (!f.endsWith(".json") || f.startsWith(".")) continue;
    entries++;
    try {
      bytes += JSON.parse(readFileSync(join(cacheDir, f), "utf8")).bytes ?? 0;
    } catch {
      /* skip */
    }
  }
  return { entries, bytes };
}
