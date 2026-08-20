// Read repo files from a LOCAL clone when one is available, instead of paying
// a network round-trip per file.
//
// Measured: `gh api .../contents/<path>?ref=<sha>` ~1022ms; the same read as
// `git show <sha>:<path>` from a local clone ~37ms — 27x faster, and
// byte-identical. Across three real runs, file CONTENTS were 126 of 407 gh
// calls (31%) and commit history another 48 (12%), so this is the largest
// remaining slice of github traffic.
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
