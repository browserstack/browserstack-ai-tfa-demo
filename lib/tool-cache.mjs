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

// ---- probe validation (capability table) -----------------------------------
//
// A capability row's `probe` is a command string that arrives from DATA, not
// from an agent composing a call. `isRunnable` is the wrong gate for it in both
// directions:
//
//   - Too permissive: it exists to decide CACHEABILITY, so it allows pipelines
//     into ALLOWED_FILTER, which includes `python3`, `awk` and `sed`. Verified —
//     `curl https://host/x | python3` returns ok. That is a cacheability
//     judgement, not a safety boundary.
//   - Too restrictive: ALLOWED_LEADER is /^(gh|kubectl|curl|git)/, so `docker
//     ps`, `aws ecs list-clusters`, `nomad status` and `pm2 ls` are all refused
//     — the exact infra probes the run skill's gate already treats as
//     legitimate. Requiring isRunnable would make every non-Kubernetes infra
//     row unseedable.
//
// So probes get their own gate, with a narrower shape and a wider leader set:
// one command, no pipeline, no operators, no redirects, no mutation, and a
// leader that appears BOTH in this closed catalog and in the row's own declared
// fingerprint executables. The row narrows the catalog; it can never widen it.

/** Leaders a capability probe may use. Closed by design — read-only,
 * data-fetching tools. Adding one is a one-line change plus a test. */
const PROBE_LEADER_CATALOG = new Set([
  "gh", "git", "kubectl", "helm", "docker", "aws", "nomad", "pm2",
  "curl", "logcli", "promtool",
]);

/** Leaders that execute arbitrary code given the right argument. Rejected by
 * name as well as by catalog absence: `bash -c '<script>'` has no unquoted
 * redirect, no operator token and no MUTATING verb, because the tokenizer
 * treats the quoted script as ONE opaque argument. The catalog already excludes
 * these; naming them produces an error a reader can act on. */
const INTERPRETER_LEADERS = new Set([
  "bash", "sh", "zsh", "ksh", "dash", "fish", "csh", "tcsh",
  "python", "python2", "python3", "node", "deno", "bun",
  "ruby", "perl", "php", "lua", "osascript",
  "env", "eval", "exec", "xargs", "find", "awk", "gawk", "sed",
  "nc", "ncat", "socat", "ssh", "telnet",
]);

/** Destructive verbs anywhere in a probe's argv. MUTATING covers gh/git/kubectl
 * and `curl -X POST`, but knows nothing about `docker rm`, `aws s3 rm` or
 * `pm2 delete` — leaders it was never written for. A probe is a status read, so
 * a verb denylist is proportionate and keeps every legitimate probe
 * (`docker ps`, `aws ecs list-clusters`, `nomad status`, `pm2 ls`) passing. */
const DESTRUCTIVE_VERBS = new Set([
  "rm", "remove", "delete", "destroy", "rmi", "prune", "purge",
  "stop", "start", "restart", "kill", "terminate", "reboot",
  "create", "apply", "update", "put", "post", "patch", "push", "set",
  "scale", "drain", "cordon", "uncordon", "rollout", "exec", "run",
  "cp", "mv", "write", "upload", "sync", "install", "uninstall",
]);

/** Shell metacharacters a probe may not carry unquoted.
 *
 * `OPERATOR_TOKENS` only catches an operator that tokenizes as its own word, and
 * tokenize() splits on whitespace — so `--base main; id` yields the token `main;`
 * and an operator check sails straight past it. Not exploitable on its own (the
 * contract is execFile with no shell, so `;` reaches the binary as a literal
 * argument), but it makes a probe silently wrong, and asserting "operators are
 * rejected" while accepting an attached one is a guarantee that is not true.
 *
 * No legitimate repo, branch, namespace or index value needs one of these.
 */
const PROBE_METACHARS = ";|&`$()\n\r";

/**
 * Is `name` allowed to lead a capability probe at all?
 *
 * Used twice: on a row's declared fingerprint executables at schema-validation
 * time, and on a probe's actual leader. Checking the DECLARATION is what stops
 * a row from legitimising an interpreter by naming it as its own fingerprint.
 */
export function isPermittedProbeLeader(name) {
  const n = String(name ?? "").trim();
  if (!n) return { ok: false, reason: "empty leader" };
  if (INTERPRETER_LEADERS.has(n)) {
    return {
      ok: false,
      reason: `'${n}' runs arbitrary code and may not lead a probe or be declared as a fingerprint executable`,
    };
  }
  if (!PROBE_LEADER_CATALOG.has(n)) {
    return {
      ok: false,
      reason: `'${n}' is not in the permitted probe-leader catalog (${[...PROBE_LEADER_CATALOG].join(", ")})`,
    };
  }
  return { ok: true };
}

/**
 * Validate one capability probe command against the row that declares it.
 *
 * `leaders` is the row's own declared fingerprint executables. A probe must be a
 * single pipeline-free command whose leader is in both that list and the global
 * catalog. Pass the raw template (brace placeholders intact) at schema time, and
 * pass the interpolated string again immediately before execution — a resolved
 * scope value can carry a redirect- or flag-shaped token the template never had.
 */
export function isProbeRunnable(command, { leaders = [] } = {}) {
  const c = String(command ?? "");
  if (!c.trim()) return { ok: false, reason: "empty probe" };

  if (!isCacheable(c)) return { ok: false, reason: "probe looks mutating" };

  const segments = splitPipeline(c).map(stripStderrPlumbing).filter((s) => s.length > 0);
  if (segments.length === 0) return { ok: false, reason: "empty probe" };
  if (segments.length > 1) {
    return {
      ok: false,
      reason: "a probe must be a single command — pipelines are not allowed, because a filter segment can execute arbitrary code",
    };
  }

  const seg = segments[0];
  if (hasUnquotedRedirect(seg)) {
    return { ok: false, reason: "file redirects (>, >>, <) are not allowed in a probe" };
  }
  const meta = firstUnquoted(seg, PROBE_METACHARS);
  if (meta) {
    return {
      ok: false,
      reason: `'${meta}' is a shell metacharacter and is not allowed unquoted in a probe — quote the value if it is genuinely part of an argument`,
    };
  }

  let argv;
  try {
    argv = tokenize(seg);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (argv.length === 0) return { ok: false, reason: "empty probe" };

  // No OPERATOR_TOKENS check here: every member of that set is built solely from
  // characters the redirect and metacharacter scans above already reject, so it
  // could never fire. Keeping a second, weaker guard alongside its replacement
  // invites someone to "fix" the metachar scan by trusting the operator one.
  const leader = argv[0];
  const permitted = isPermittedProbeLeader(leader);
  if (!permitted.ok) return { ok: false, reason: permitted.reason };

  const declared = new Set((leaders ?? []).map((l) => String(l).trim()));
  if (!declared.has(leader)) {
    return {
      ok: false,
      reason: `probe leader '${leader}' is not among this row's declared fingerprint executables (${[...declared].join(", ") || "none"}) — the row narrows the catalog, it cannot widen it`,
    };
  }

  // Each token is tested WHOLE and split on `=`, because a destructive verb can
  // arrive as an attached flag value: `--method=DELETE` hides `delete` inside one
  // token, so a whole-token comparison never sees it, while the space-separated
  // `--method DELETE` was caught. gh, aws and kubectl all accept the attached
  // form, so treating the two differently is a hole rather than a nuance.
  const verb = argv
    .slice(1)
    .flatMap((t) => [t, ...String(t).split("=")])
    .find((t) => DESTRUCTIVE_VERBS.has(t.toLowerCase()));
  if (verb) {
    return { ok: false, reason: `'${verb}' is a destructive verb — a probe must be a read-only status call` };
  }

  return { ok: true, argv };
}
