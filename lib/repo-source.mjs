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
