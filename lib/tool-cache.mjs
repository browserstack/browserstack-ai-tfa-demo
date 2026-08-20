// Build-scoped memo cache for READ-ONLY tool calls.
//
// Only IMMUTABLE reads are cached: gh api calls pinned to a sha or addressing
// git objects (/git/ path), and git commands that reference a 40-hex sha
// (git show, git cat-file, git ls-tree, git log). Everything else passes
// through uncached — the wrapper still runs it and returns its real output.
//
// CONCURRENCY: one file per cache KEY (`<sha>.json`), not one per writer.
// Distinct calls write distinct files; two agents racing on the *same* call
// write byte-identical content, so the race is benign. Writes go through a
// temp file + `rename`, which is atomic on POSIX, so a reader never observes
// a half-written entry. No locking, no lost updates, no torn reads.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

/** Per-build cache directory. */
export function toolCacheDirFor(buildId, stateDir = "") {
  const safe = String(buildId ?? "").replace(/[^A-Za-z0-9._-]/g, "_") || "unknown-build";
  const dir = stateDir && String(stateDir).trim() !== "" ? String(stateDir) : join(tmpdir(), "bstack-rca");
  return join(dir, `rca-toolcache.${safe}`);
}

function ensureOwnerOnlyDir(dir) {
  if (!existsSync(dir)) { mkdirSync(dir, { recursive: true, mode: 0o700 }); return; }
  try { chmodSync(dir, 0o700); } catch { /* not ours to tighten; leave it */ }
}

/** Stable key for one call. Whitespace is normalized. */
export function cacheKey(command) {
  const norm = String(command ?? "").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(norm).digest("hex").slice(0, 24);
}

// Commands that must never run through the wrapper at all.
const MUTATING = /\b(rm|mv|cp|dd|truncate|tee)\b|\bgit\s+(push|commit|merge|rebase|reset|checkout|clean)\b|\bgh\s+(pr\s+(create|merge|close|edit|comment|review)|issue\s+(create|close|edit|comment)|release\s+create|repo\s+(create|delete)|api\s+(-X\s*)?(POST|PUT|PATCH|DELETE))|\bkubectl\s+(apply|delete|edit|patch|scale|create|replace|annotate|label|cordon|drain|exec|cp|port-forward|rollout\s+(undo|restart|pause|resume))\b|\bcurl\b[^|]*\s-(X|-request)\s*(POST|PUT|PATCH|DELETE)/i;

/** True if the command is NOT a known mutation. */
export function isCacheable(command) {
  return !MUTATING.test(String(command ?? ""));
}

// 40-hex-char SHA pattern
const SHA40 = /\b[0-9a-f]{40}\b/i;

/**
 * True if the command's output is provably immutable and should be memoized.
 *
 * Cacheable commands:
 *   - `gh api` with `?ref=<40-hex-sha>` OR a `/git/` path (blobs/trees/commits)
 *   - `git show <sha>:...`, `git cat-file ... <sha>`, `git ls-tree <sha>`,
 *     `git log <sha>` — i.e. a 40-hex sha present in the command
 */
export function isImmutableRead(command) {
  const c = String(command ?? "");

  // gh api calls pinned to immutable git objects
  if (/^\s*gh\s+api\s/i.test(c)) {
    // Contains /git/ path (blobs, trees, commits)
    if (/\/git\//.test(c)) return true;
    // Contains ?ref=<40-hex-sha> or &ref=<40-hex-sha>
    if (/[?&]ref=[0-9a-f]{40}\b/i.test(c)) return true;
    return false;
  }

  // git commands with a 40-hex sha present
  if (/^\s*git\s+(show|cat-file|ls-tree|log)\s/i.test(c) && SHA40.test(c)) {
    return true;
  }

  return false;
}

/**
 * True if the command is a repo read that is stable for the lifetime of ONE
 * build-RCA run (minutes) though not provably immutable. These are the reads the
 * cross-coordinator cache exists to collapse: a build's suspect PRs don't change
 * mid-run, and every sibling confirms the SAME representative's suspect PRs — so
 * `gh pr view/diff <n>`, repo content reads, and read-only git are fetched
 * identically by many coordinators. Caching them per-build removes that N-fold
 * duplication.
 *
 * Deliberately NOT included: `kubectl get/logs`, `curl`, `aws`, `docker`, log
 * queries — live state that changes second-to-second and must always pass
 * through. Mutations are refused upstream by `isCacheable`.
 */
export function isRunStableRead(command) {
  const c = String(command ?? "");
  // read-only gh PR/repo subcommands (by number or path)
  if (/^\s*gh\s+pr\s+(view|diff|list|checks|status)\b/i.test(c)) return true;
  if (/^\s*gh\s+search\s+(code|prs|issues|commits|repos)\b/i.test(c)) return true;
  // gh api GET on repo/pull/content/commit/compare paths (writes already refused)
  if (
    /^\s*gh\s+api\s/i.test(c) &&
    !/(^|\s)(-X|--method)\b/i.test(c) &&
    /\brepos\/[^\s]+\/(contents|pulls|commits|compare|git)\b/i.test(c)
  ) {
    return true;
  }
  // read-only git history/blob inspection (sha optional — run-stable)
  if (/^\s*git\s+(show|log|diff|cat-file|ls-tree|blame|rev-parse)\b/i.test(c)) return true;
  return false;
}

// ---- MCP calls ------------------------------------------------------------

const MCP_NEVER = /tfaRcaTurn|getTfaTurnResult|triggerRcaReport/i;

export function isCacheableMcp(toolName) {
  return !MCP_NEVER.test(String(toolName ?? ""));
}

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

// Redact secrets before persisting.
const SECRET_KV =
  /((?:token|authorization|api[_-]?key|secret|password|passwd|access[_-]?key)"?\s*[=:]\s*"?)((?:bearer|basic|token)\s+)?([^\s"'`,;}\]&\r\n]{4,})/gi;
const SECRET_SCHEME = /\b(bearer|basic)\s+([A-Za-z0-9._~+/=-]{8,})/gi;

export function redact(text) {
  return String(text ?? "")
    .replace(SECRET_KV, (_m, key) => `${key}<redacted>`)
    .replace(SECRET_SCHEME, (_m, scheme) => `${scheme} <redacted>`);
}

const MAX_BYTES = 256 * 1024;
let tmpSeq = 0;

export function cacheGet(cacheDir, key) {
  const p = join(cacheDir, `${key}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function cachePut(cacheDir, key, entry, nowMs) {
  ensureOwnerOnlyDir(cacheDir);
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
  const tmpPath = join(cacheDir, `.${key}.${process.pid}.${tmpSeq++}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(rec, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmpPath, finalPath);
  return rec;
}

export function cacheStats(cacheDir) {
  if (!existsSync(cacheDir)) return { entries: 0, bytes: 0 };
  let entries = 0;
  let bytes = 0;
  for (const f of readdirSync(cacheDir)) {
    if (!f.endsWith(".json") || f.startsWith(".")) continue;
    entries++;
    try {
      bytes += JSON.parse(readFileSync(join(cacheDir, f), "utf8")).bytes ?? 0;
    } catch { /* skip */ }
  }
  return { entries, bytes };
}

// ---- Shared banner utility ------------------------------------------------

export function banner(line, logPath) {
  console.error(line);
  if (logPath) {
    try {
      appendFileSync(logPath, line + "\n", { encoding: "utf8", mode: 0o600 });
    } catch { /* logging must never break the fetch */ }
  }
}
