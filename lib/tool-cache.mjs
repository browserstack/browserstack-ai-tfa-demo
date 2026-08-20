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

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, chmodSync,
} from "node:fs";
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
// Owner-only, on create AND on an existing directory. `mkdirSync`'s `mode`
// applies only when it creates the dir, so one made before this hardening
// landed keeps its 0755 forever — and these artifacts hold root causes,
// culprit PRs and log excerpts in a shared OS temp dir. Found in practice:
// <tmpdir>/bstack-rca was drwxr-xr-x with 0600 files inside it.
function ensureOwnerOnlyDir(dir) {
  if (!existsSync(dir)) { mkdirSync(dir, { recursive: true, mode: 0o700 }); return; }
  try { chmodSync(dir, 0o700); } catch { /* not ours to tighten; leave it */ }
}

export function cacheKey(command) {
  const norm = String(command ?? "").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(norm).digest("hex").slice(0, 24);
}

// Commands that must never be memoized, even if someone wires this into a
// non-read-only context by mistake.
// Note: output redirection is deliberately NOT in this list. A `>/dev/null`
// is a redirect, not a mutation, and lumping the two together produced the
// misleading refusal "command looks mutating" for ordinary read-only calls.
// Redirects are handled separately, with an accurate message.
const MUTATING = /\b(rm|mv|cp|dd|truncate|tee)\b|\bgit\s+(push|commit|merge|rebase|reset|checkout|clean)\b|\bgh\s+(pr\s+(create|merge|close|edit|comment|review)|issue\s+(create|close|edit|comment)|release\s+create|repo\s+(create|delete)|api\s+(-X\s*)?(POST|PUT|PATCH|DELETE))|\bkubectl\s+(apply|delete|edit|patch|scale|create|replace|annotate|label|cordon|drain|exec|cp|port-forward|rollout\s+(undo|restart|pause|resume))\b|\bcurl\b[^|]*\s-(X|-request)\s*(POST|PUT|PATCH|DELETE)/i;

/**
 * Strip stderr-plumbing that the wrapper already handles.
 *
 * `2>&1` and `2>/dev/null` appear on the majority of real recorded calls —
 * agents add them reflexively because `gh` is chatty. They say nothing about
 * WHAT to fetch, only where stderr should go, and the wrapper captures stderr
 * separately regardless. Refusing them rejected 134 of 223 recorded calls and
 * drove the effective hit rate to zero, so they are normalized away instead.
 *
 * Genuine FILE redirects (`> out.json`, `>> log`, `< in`) are left in place so
 * the check below still refuses them: those change where data goes, which the
 * wrapper cannot honour while also returning stdout to the caller.
 */
function stripStderrPlumbing(seg) {
  return String(seg ?? "")
    .replace(/\s*2>&1\s*/g, " ")
    .replace(/\s*2>\s*\/dev\/null\s*/g, " ")
    .trim();
}

/** The first of `chars` appearing OUTSIDE quotes, or null.
 *
 * One scanner, two callers: the redirect check below and the probe gate's wider
 * metacharacter check. They were separate copies of this identical walk, which
 * meant a future fix to how "quoted" is decided would have had to be made twice
 * or the two would disagree. */
function firstUnquoted(seg, chars) {
  let quote = null;
  const s = String(seg ?? "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    // Backslash escape, POSIX-style and IDENTICAL to tokenize()'s rule: literal
    // everywhere except inside single quotes. Without this the scanner and the
    // tokenizer disagreed about `\"` — tokenize treats it as a literal quote,
    // leaving the following text OUTSIDE quotes, while this walk treated it as a
    // delimiter and considered that text quoted. So `gh api repos/x\";id;:\"`
    // was reported clean, and a shell handed that same string ran the `id`.
    // Two quoting models over one string is the bug; there is now one.
    if (ch === "\\" && i + 1 < s.length && quote !== "'") { i++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (chars.includes(ch)) return ch;
  }
  return null;
}

/** True if the segment still contains a real redirect outside quotes, after
 * stderr plumbing has been normalized away. */
function hasUnquotedRedirect(seg) {
  return firstUnquoted(seg, "><") !== null;
}

export function isCacheable(command) {
  return !MUTATING.test(String(command ?? ""));
}

// Read-only data-fetching binaries this wrapper will run. Anything else is
// refused outright.
const ALLOWED_LEADER = /^\s*(gh|kubectl|curl|git)\s/;

// Pure text filters allowed AFTER the fetch in a pipeline. They transform the
// fetch's output and never reach the network, so they are deliberately outside
// the cache key: `gh api X | jq .a` and `gh api X | jq .b` share ONE cached
// fetch. Measured motivation — replaying real recorded traffic, 89% of calls
// embedded the fetch in a pipeline, so refusing pipelines outright meant the
// cache applied to almost nothing in practice.
const ALLOWED_FILTER = new Set([
  "jq", "grep", "egrep", "head", "tail", "sort", "uniq", "wc",
  "cut", "tr", "sed", "awk", "base64", "python3", "rev", "column",
]);

/** Split on top-level `|` only — a pipe inside quotes (a jq expression) stays
 * part of its segment. Returns trimmed segment strings. */
export function splitPipeline(command) {
  const segs = [];
  let cur = "";
  let quote = null;
  const s = String(command ?? "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    // A backslash escapes the next character. Without this, `\"` inside a
    // double-quoted jq filter reads as "close quote", the parser thinks it is
    // back outside quotes, and a `|` in a regex alternation like
    // `test("vite|env";"i")` gets split as a shell pipe.
    if (ch === "\\" && i + 1 < s.length && quote !== "'") {
      cur += ch + s[i + 1];
      i++;
      continue;
    }
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "|") { segs.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  segs.push(cur.trim());
  return segs.filter((s2) => s2.length > 0);
}

// Shell operators, checked as whole ARGV TOKENS rather than by scanning the
// raw string. Scanning the string was too blunt and refused legitimate reads:
// `--jq 'test("rcaThree";"i")'` was rejected for the `;` inside a quoted jq
// expression, and `search/code?q=X&per_page=20` for the `&` inside a URL.
//
// Post-tokenization this distinction is exact: quoted metacharacters end up
// *inside* an argument (harmless — we execFile, so no shell ever interprets
// them), while a real operator survives as its own standalone token.
const OPERATOR_TOKENS = new Set([";", "|", "||", "&&", "&", ">", ">>", "<", "<<"]);

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
/**
 * Validate a command and return its execution plan.
 *
 * On success: `{ ok, fetch: string[], filters: string[][] }` — the fetch is
 * executed (or served from cache) and its output is piped through the filters,
 * each run via execFile with NO shell anywhere in the chain.
 *
 * Pipelines are accepted rather than refused because refusing them is what
 * made the cache useless on real traffic. Only the FETCH is keyed, so several
 * agents filtering one fetch differently all share a single cached result.
 */
export function isRunnable(command) {
  const c = String(command ?? "");
  if (!isCacheable(c)) return { ok: false, reason: "command looks mutating" };

  const segments = splitPipeline(c).map(stripStderrPlumbing).filter((s) => s.length > 0);
  if (segments.length === 0) return { ok: false, reason: "empty command" };

  if (!ALLOWED_LEADER.test(segments[0])) {
    return { ok: false, reason: "command must start with gh, kubectl, curl, or git" };
  }

  const parsed = [];
  for (const seg of segments) {
    if (hasUnquotedRedirect(seg)) {
      return {
        ok: false,
        reason: "file redirects (>, >>, <) are not supported — the wrapper returns stdout to you directly, so drop the redirect. (`2>&1` and `2>/dev/null` are fine; they're stripped automatically.)",
      };
    }
    let argv;
    try {
      argv = tokenize(seg);
    } catch (err) {
      return { ok: false, reason: err.message };
    }
    if (argv.length === 0) return { ok: false, reason: "empty pipeline segment" };
    const op = argv.find((t) => OPERATOR_TOKENS.has(t));
    if (op) {
      return {
        ok: false,
        reason: `'${op}' is a shell operator. Pipes are supported, but ';', '&&', redirects and substitution are not — issue one fetch per call.`,
      };
    }
    parsed.push(argv);
  }

  for (const argv of parsed.slice(1)) {
    if (!ALLOWED_FILTER.has(argv[0])) {
      return {
        ok: false,
        reason: `'${argv[0]}' is not an allowed filter after the fetch (allowed: ${[...ALLOWED_FILTER].join(", ")})`,
      };
    }
  }

  return { ok: true, fetch: parsed[0], filters: parsed.slice(1), fetchText: segments[0] };
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
  const s = String(command ?? "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    // Backslash escape, POSIX-style: literal everywhere except inside single
    // quotes. Missing this mangled jq's most common idiom — `\"` was treated
    // as a quote delimiter, so `select(.filename==\"x\")` reached the binary
    // as `select(.filename==\x\)` with the quotes eaten.
    if (ch === "\\" && i + 1 < s.length && quote !== "'") {
      cur += s[i + 1];
      i++;
      started = true;
      continue;
    }
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
/**
 * Tools whose answer is EXPECTED to change, so reusing one hides a transition.
 *
 * This was three names — the turn-submission trio — and everything else was
 * cacheable by omission. That let a result be reused across a state change the run
 * depends on seeing: a themes computation whose status goes not-ready → ready would
 * be pinned at not-ready forever, permanently forcing a fallback path; a mid-run
 * test list would be reused after more tests finished. `listTestIds` has a recorded
 * production failure from exactly that reuse, in-process; the cache reintroduced it
 * across processes.
 *
 * Named by what they DO rather than by product: anything that submits, anything
 * that reports the status of work still in progress, anything that enumerates a set
 * still being added to.
 */
const NEVER_CACHE = [
  /tfaRcaTurn|getTfaTurnResult|triggerRcaReport/i,   // submit + poll a turn
  /FailureThemes|ThemeWorkflow/i,                     // computed server-side, has a ready flag
  /listTestIds|listTestsInFailureTheme/i,             // a set still being added to mid-run
  // NOT \b: these names are underscore-separated (`mcp__acme__submit_job`), and
  // `_` is a word character, so \b never fires beside it.
  /(?:^|[^a-z])(submit|trigger|create|update|delete|dispatch|write)(?:[^a-z]|$)/i,
];

export function isCacheableMcp(toolName) {
  const name = String(toolName ?? "");
  return !NEVER_CACHE.some((p) => p.test(name));
}

/**
 * How long a cached answer may be reused.
 *
 * `stable` means the answer cannot change for this key — file content at a commit
 * sha, a merged PR's diff. Those are reusable indefinitely, which is the whole
 * value of the cache.
 *
 * `snapshot` means it was true at a moment: live workload state, a log query, an
 * instant metrics read, a PR list. There was no TTL at all before this, and
 * `capturedAtMs` was written by cachePut and read by NOTHING — so a resume hours
 * later silently reused the original run's pod state and PR window. The evidence
 * file learned this same lesson and flags its own staleness at 6h; the tool cache
 * holding the same class of data had no equivalent signal.
 */
export const SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;

export const VOLATILITY = { STABLE: "stable", SNAPSHOT: "snapshot" };

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

// Redact the secret VALUE, bounded by the first structural delimiter — never
// "the rest of the line".
//
// The rest-of-line version silently destroyed data. GitHub's file API returns
// SINGLE-LINE JSON whose `download_url` always carries `?token=…`, so matching
// `token=` and consuming `[^\r\n]*` swallowed the entire remaining payload:
// a 214KB response cached as 816 bytes, content field gone, no warning. Every
// private-repo file fetch was affected.
//
// A value therefore stops at whitespace, quote, comma, semicolon, brace,
// bracket or `&` — enough to cover a real credential, never enough to eat the
// surrounding document.
const SECRET_KV =
  /((?:token|authorization|api[_-]?key|secret|password|passwd|access[_-]?key)"?\s*[=:]\s*"?)((?:bearer|basic|token)\s+)?([^\s"'`,;}\]&\r\n]{4,})/gi;

// A bare `Bearer <token>` / `Basic <token>` with no key= in front of it.
const SECRET_SCHEME = /\b(bearer|basic)\s+([A-Za-z0-9._~+/=-]{8,})/gi;

/** Redact anything token-shaped before it is persisted. The cache lives in
 * temp, but a cached `gh api` response or log line could still carry a
 * credential, and "it's only temp" is not a reason to write one to disk. */
export function redact(text) {
  return String(text ?? "")
    .replace(SECRET_KV, (_m, key) => `${key}<redacted>`)
    .replace(SECRET_SCHEME, (_m, scheme) => `${scheme} <redacted>`);
}

const MAX_BYTES = 256 * 1024;

let tmpSeq = 0;

/**
 * Read an entry, or null.
 *
 * `nowMs` makes `capturedAtMs` load-bearing instead of decorative. A `snapshot`
 * entry past SNAPSHOT_MAX_AGE_MS is reported as a MISS: reusing it would assert
 * something about the past as though it were current, and the caller has no way to
 * know. A hit carries `ageMs` so the caller can say how old its evidence is —
 * `truncated` travels with it for the same reason, because a truncated payload
 * turns "grep found nothing" into a false negative.
 *
 * Omitting `nowMs` reads without an age check. That is for cacheStats and
 * inspection only; a caller about to USE the bytes passes the clock.
 */
export function cacheGet(cacheDir, key, nowMs = null) {
  const p = join(cacheDir, `${key}.json`);
  if (!existsSync(p)) return null;
  let rec;
  try {
    rec = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null; // half-written or corrupt -> treat as a miss, never throw
  }
  if (nowMs === null) return rec;

  const ageMs = Math.max(0, nowMs - (rec.capturedAtMs ?? 0));
  // An entry written before volatility was recorded is treated as a snapshot: the
  // conservative direction, since a wrongly-expired stable entry costs one refetch
  // and a wrongly-reused snapshot costs a wrong conclusion.
  const volatility = rec.volatility ?? VOLATILITY.SNAPSHOT;
  if (volatility === VOLATILITY.SNAPSHOT && ageMs > SNAPSHOT_MAX_AGE_MS) {
    return null;
  }
  return { ...rec, ageMs, volatility };
}

/** Atomic write: temp file + rename, so concurrent readers only ever see a
 * complete entry. `nowMs` is passed in (same clock discipline as the rest of
 * lib/). Returns the stored entry. */
export function cachePut(cacheDir, key, entry, nowMs) {
  // Owner-only (0700 dir / 0600 files). The cache lives under a world-readable
  // OS temp dir and holds raw `gh`/`kubectl` output — private repo source,
  // internal hostnames, log bodies. `redact()` below is best-effort pattern
  // matching and will not catch everything, so the filesystem permission is
  // the actual control, not a backstop.
  //
  // The FILE mode is the load-bearing part: a pre-existing directory (e.g. a
  // `stateDir` the user already created, or one left by an earlier run) keeps
  // its own permissions, since silently chmod'ing a path we were handed would
  // be presumptuous. Entries stay 0600 regardless, and a traversable directory
  // only exposes opaque hash filenames, not their contents.
  ensureOwnerOnlyDir(cacheDir);
  const raw = redact(entry.stdout ?? "");
  const truncated = raw.length > MAX_BYTES;
  const rec = {
    key,
    command: entry.command,
    writerId: entry.writerId ?? null,
    capturedAtMs: nowMs,
    // Declared by the caller, defaulting to the safe side. `stable` is a claim that
    // this key's answer cannot change — only a commit-pinned read can honestly make it.
    volatility: entry.volatility === VOLATILITY.STABLE ? VOLATILITY.STABLE : VOLATILITY.SNAPSHOT,
    exitCode: entry.exitCode ?? 0,
    truncated,
    bytes: raw.length,
    stdout: truncated ? raw.slice(0, MAX_BYTES) + "\n… [truncated by tool-cache]" : raw,
  };
  const finalPath = join(cacheDir, `${key}.json`);
  // pid + counter keeps the temp name unique per writer, so `mode` genuinely
  // applies (it is honoured on create, not on truncate of an existing file).
  const tmpPath = join(cacheDir, `.${key}.${process.pid}.${tmpSeq++}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(rec, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmpPath, finalPath); // atomic on POSIX; preserves the 0600 mode
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
