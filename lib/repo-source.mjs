// Read repo files from a LOCAL clone when one is available, instead of paying
// a network round-trip per file.
//
// Measured: `gh api .../contents/<path>?ref=<sha>` ~1022ms; the same read as
// `git show <sha>:<path>` from a local clone ~37ms — 27x faster, and
// byte-identical. Across three real runs, file CONTENTS were 126 of 407 gh
// calls (31%) and commit history another 48 (12%) — `commitHistoryAt` below
// closes that second slice the same way. `blameAt` has no `gh` equivalent to
// measure against at all: blame requires no GitHub dependency once the
// commit is present, not just a faster path to the same answer.
//
// THE CORRECTNESS RULE: ALWAYS PIN TO A COMMIT SHA, NEVER A BRANCH NAME.
//
// This is not pedantry — it is the whole reason this module needs care. A
// developer's clone is usually stale: measured on this workspace,
// the shipping branch's remote-tracking ref was 12 commits behind, and reading
// `testPlan.js` from the local branch returned 281,061 bytes where the real
// branch head had 282,315. For RCA that is catastrophic in a quiet way: we
// reason about *what changed in a window*, so silently reading different code
// yields a confident wrong answer. Pinned to the build-time SHA the content is
// byte-identical to GitHub, and staleness stops mattering — a commit either
// exists locally or it does not, and we can tell which.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SHA = /^[0-9a-f]{7,40}$/i;

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Local clone path for `org/repo`, if one exists under `workspaceRoot`.
 * Matches on the bare repo name, which is how these workspaces are laid out. */
export function localCloneFor(repo, workspaceRoot) {
  const name = String(repo).split("/").pop();
  const dir = join(workspaceRoot, name);
  return existsSync(join(dir, ".git")) ? dir : null;
}

/**
 * Find the directory holding the local clones, WITHOUT hardcoding a path.
 *
 * `repos` is the gate's validated repo list, and it is what makes this
 * generic: a candidate only wins if it actually contains one of the repos
 * THIS run cares about. No repo name, product or path is baked in — a
 * different product with a different checkout layout resolves by the same
 * rule.
 *
 * Bounded on purpose: an explicit override, then at most `maxTries`
 * structural guesses. Searching the filesystem for a plausible-looking
 * directory would risk picking a stale or unrelated checkout, and a wrong
 * workspace silently yields the wrong source code — the same class of failure
 * as reading a stale branch. Finding nothing is a fine answer; the caller
 * falls back to the network.
 *
 * Returns `{ root, matched, tried }`, or `{ root: null, tried }`.
 */
export function discoverWorkspaceRoot({ repos = [], explicit, from, maxTries = 3 } = {}) {
  const verify = (dir) => {
    if (!dir || !existsSync(dir)) return null;
    const hit = repos.find((r) => localCloneFor(r, dir));
    return hit ? { root: dir, matched: hit } : null;
  };

  // An explicit value is authoritative and not counted as a guess — but it is
  // still verified, so a stale env var fails loudly instead of quietly.
  if (explicit) {
    const ok = verify(explicit);
    return ok ? { ...ok, tried: [explicit] } : { root: null, tried: [explicit], reason: `RCA_WORKSPACE_ROOT=${explicit} contains none of the validated repos` };
  }

  // Structural guesses only, in decreasing confidence. `from` is typically the
  // plugin's own directory, which usually sits inside the workspace.
  const base = from ?? process.cwd();
  const candidates = [base, join(base, ".."), join(base, "..", "..")].slice(0, maxTries);

  const tried = [];
  for (const c of candidates) {
    tried.push(c);
    const ok = verify(c);
    if (ok) return { ...ok, tried };
  }
  return { root: null, tried, reason: `none of ${tried.length} candidate(s) contained any of: ${repos.join(", ") || "(no repos given)"}` };
}

/**
 * Resolve, once, which of `repos` are readable locally at their pinned shas.
 * The result is meant to be persisted (evidence file) so that every later
 * coordinator reads a map instead of re-probing the filesystem.
 *
 * `pins` is `{ "org/repo": "<sha>" }` — normally the deployState shas Step 4
 * already computed.
 */
export function resolveLocalRepos({ repos, pins = {}, workspaceRoot, branch, allowFetch = false }) {
  const out = {};
  for (const repo of repos) {
    const dir = localCloneFor(repo, workspaceRoot);
    if (!dir) { out[repo] = { dir: null, usable: false, reason: "no local clone" }; continue; }
    const sha = pins[repo];
    if (!sha) { out[repo] = { dir, usable: false, reason: "no pinned sha for this repo" }; continue; }
    let present = hasCommit(dir, sha);
    let fetched = false;
    if (!present && allowFetch) { fetched = ensureCommit(dir, sha, branch); present = fetched; }
    out[repo] = present
      ? { dir, sha, usable: true, fetched }
      : { dir, sha, usable: false, reason: `commit ${sha} not present locally${allowFetch ? " even after fetch" : ""}` };
  }
  return out;
}

/** Is this exact commit present locally? The only question that matters —
 * a present commit is immutable, so its content cannot be stale. */
export function hasCommit(dir, sha) {
  try {
    git(dir, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Make `sha` available locally with one targeted fetch. Returns true if the
 * commit is present afterwards. Fetch touches only remote-tracking refs — it
 * never moves a branch or the working tree, so it is safe to run against a
 * repo someone is working in. */
export function ensureCommit(dir, sha, branch) {
  if (hasCommit(dir, sha)) return true;
  try {
    git(dir, ["fetch", "--quiet", "origin", branch ?? sha]);
  } catch {
    return false;
  }
  return hasCommit(dir, sha);
}

/**
 * Read one file at one commit. Returns
 * `{ ok, content, source: "local"|"remote-needed", reason }`.
 *
 * Deliberately does NOT fall back to the network itself — it reports that the
 * caller should. Keeping the decision at the edge means a wrong-looking local
 * answer can never be silently substituted for the real one.
 */
export function readFileAt({ repo, sha, path, workspaceRoot, branch, allowFetch = false }) {
  if (!SHA.test(String(sha ?? ""))) {
    // Refusing a branch name is the point — see the header.
    return { ok: false, source: "remote-needed", reason: `ref must be a commit sha, got ${JSON.stringify(sha)} (a branch name can silently read stale code)` };
  }
  const dir = localCloneFor(repo, workspaceRoot);
  if (!dir) return { ok: false, source: "remote-needed", reason: `no local clone of ${repo} under ${workspaceRoot}` };

  if (!hasCommit(dir, sha)) {
    if (!allowFetch) return { ok: false, source: "remote-needed", reason: `commit ${sha} not present in ${dir} (pass allowFetch to fetch it once)` };
    if (!ensureCommit(dir, sha, branch)) {
      return { ok: false, source: "remote-needed", reason: `commit ${sha} still absent after fetch` };
    }
  }
  try {
    return { ok: true, source: "local", content: git(dir, ["show", `${sha}:${path}`]), dir };
  } catch (err) {
    // A missing path at that commit is a real answer, not a fallback trigger:
    // the file genuinely did not exist there.
    const msg = String(err.stderr ?? err.message ?? "");
    if (/does not exist|exists on disk, but not in/i.test(msg)) {
      return { ok: false, source: "local", reason: `path not present at ${sha}: ${path}` };
    }
    return { ok: false, source: "remote-needed", reason: msg.slice(0, 200) };
  }
}

/** Ensure `sha` is present locally, respecting `allowFetch` exactly like
 * `readFileAt`. Returns `null` on success (nothing to report) or a
 * `remote-needed` envelope on failure — shared by every helper below so the
 * "not present, and don't fetch unless asked" contract stays in one place. */
function ensurePresent(dir, sha, branch, allowFetch) {
  if (hasCommit(dir, sha)) return null;
  if (!allowFetch) return { ok: false, source: "remote-needed", reason: `commit ${sha} not present in ${dir} (pass allowFetch to fetch it once)` };
  if (!ensureCommit(dir, sha, branch)) return { ok: false, source: "remote-needed", reason: `commit ${sha} still absent after fetch` };
  return null;
}

/**
 * Commit history touching `path` in the range `fromSha..toSha` (exclusive of
 * `fromSha`, inclusive of `toSha` — same semantics as `git log A..B`). Local
 * equivalent of `gh api "repos/.../commits?sha=<branch>"`, the second-largest
 * slice of `gh` traffic per this module's header (12% across three real
 * runs) with no local-clone path until now.
 *
 * Returns `{ ok, source: "local"|"remote-needed", commits: [{sha, date,
 * subject}], reason }`. Omit `path` to get the repo-wide history for the
 * range. Both `fromSha` and `toSha` must be commit shas — same "never a
 * branch name" rule as `readFileAt`, for the same reason: a branch-scoped
 * range silently drifts as the branch moves.
 */
export function commitHistoryAt({ repo, fromSha, toSha, path, workspaceRoot, branch, allowFetch = false }) {
  if (!SHA.test(String(fromSha ?? "")) || !SHA.test(String(toSha ?? ""))) {
    return { ok: false, source: "remote-needed", reason: `fromSha and toSha must both be commit shas, got ${JSON.stringify(fromSha)}..${JSON.stringify(toSha)}` };
  }
  const dir = localCloneFor(repo, workspaceRoot);
  if (!dir) return { ok: false, source: "remote-needed", reason: `no local clone of ${repo} under ${workspaceRoot}` };

  for (const sha of [fromSha, toSha]) {
    const missing = ensurePresent(dir, sha, branch, allowFetch);
    if (missing) return missing;
  }

  try {
    // \x1f (unit separator) can't appear in a commit subject, so it is a safe
    // field delimiter without needing to escape/parse quoted output.
    const args = ["log", "--pretty=format:%H\x1f%cI\x1f%s", `${fromSha}..${toSha}`];
    if (path) args.push("--", path);
    const raw = git(dir, args);
    const commits = raw
      ? raw.split("\n").filter(Boolean).map((line) => {
          const [sha, date, subject] = line.split("\x1f");
          return { sha, date, subject };
        })
      : [];
    return { ok: true, source: "local", commits, dir };
  } catch (err) {
    return { ok: false, source: "remote-needed", reason: String(err.stderr ?? err.message ?? "").slice(0, 200) };
  }
}

function parseLinePorcelainBlame(raw) {
  const out = [];
  let cur = null;
  for (const line of raw.split("\n")) {
    const header = line.match(/^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/);
    if (header) {
      if (cur) out.push(cur);
      cur = { sha: header[1], line: Number(header[2]), author: null, date: null, content: "" };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("author ")) cur.author = line.slice("author ".length);
    else if (line.startsWith("author-time ")) cur.date = new Date(Number(line.slice("author-time ".length)) * 1000).toISOString();
    else if (line.startsWith("\t")) cur.content = line.slice(1);
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Blame `path` at a pinned commit — "who/what last changed the failing
 * line," the first ask in `references/github-evidence.md`'s evidence table.
 * Pure local git plumbing: unlike every other helper here this isn't just
 * faster than the network, there IS no equivalent single `gh` call — blame
 * requires no GitHub dependency at all once the commit is present.
 *
 * `lineRange` is 1-indexed and inclusive, e.g. `{start: 40, end: 55}` from a
 * stack frame; omit it to blame the whole file (expensive on a large file —
 * always scope to the failing lines when you have them).
 *
 * Returns `{ ok, source: "local"|"remote-needed", lines: [{sha, author,
 * date, line, content}], reason }`.
 */
export function blameAt({ repo, sha, path, lineRange, workspaceRoot, branch, allowFetch = false }) {
  if (!SHA.test(String(sha ?? ""))) {
    return { ok: false, source: "remote-needed", reason: `ref must be a commit sha, got ${JSON.stringify(sha)} (a branch name can silently blame stale code)` };
  }
  const dir = localCloneFor(repo, workspaceRoot);
  if (!dir) return { ok: false, source: "remote-needed", reason: `no local clone of ${repo} under ${workspaceRoot}` };

  const missing = ensurePresent(dir, sha, branch, allowFetch);
  if (missing) return missing;

  const args = ["blame", "--line-porcelain"];
  if (lineRange?.start && lineRange?.end) args.push("-L", `${lineRange.start},${lineRange.end}`);
  args.push(sha, "--", path);

  try {
    return { ok: true, source: "local", lines: parseLinePorcelainBlame(git(dir, args)), dir };
  } catch (err) {
    const msg = String(err.stderr ?? err.message ?? "");
    if (/no such path|does not exist|is outside repository/i.test(msg)) {
      return { ok: false, source: "local", reason: `path not present at ${sha}: ${path}` };
    }
    return { ok: false, source: "remote-needed", reason: msg.slice(0, 200) };
  }
}
