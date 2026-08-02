import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localCloneFor, hasCommit, readFileAt, discoverWorkspaceRoot, resolveLocalRepos } from "../lib/repo-source.mjs";

let ws, repoDir, sha1, sha2;

// Build a real throwaway git repo with two commits, so the staleness scenario
// is exercised for real rather than mocked.
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "rca-ws-"));
  repoDir = join(ws, "testrepo");
  mkdirSync(repoDir);
  const g = (...a) => execFileSync("git", ["-C", repoDir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  writeFileSync(join(repoDir, "app.js"), "VERSION_ONE\n");
  g("add", "."); g("commit", "-qm", "one");
  sha1 = g("rev-parse", "HEAD").trim();
  writeFileSync(join(repoDir, "app.js"), "VERSION_TWO\n");
  g("add", "."); g("commit", "-qm", "two");
  sha2 = g("rev-parse", "HEAD").trim();
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

test("localCloneFor finds a clone by bare repo name", () => {
  assert.equal(localCloneFor("browserstack/testrepo", ws), repoDir);
  assert.equal(localCloneFor("browserstack/not-cloned", ws), null);
});

test("hasCommit distinguishes present from absent commits", () => {
  assert.equal(hasCommit(repoDir, sha1), true);
  assert.equal(hasCommit(repoDir, "0".repeat(40)), false);
});

// The core safety property. A branch name resolves to whatever the clone
// happens to have, which on a real machine was 12 commits stale and returned
// different bytes than the true head — a silently wrong RCA input.
test("a branch name is REFUSED; only a commit sha is accepted", () => {
  const r = readFileAt({ repo: "browserstack/testrepo", sha: "main", path: "app.js", workspaceRoot: ws });
  assert.equal(r.ok, false);
  assert.equal(r.source, "remote-needed");
  assert.match(r.reason, /must be a commit sha/);
});

test("a pinned sha reads the content AT THAT COMMIT, not the tip", () => {
  const older = readFileAt({ repo: "browserstack/testrepo", sha: sha1, path: "app.js", workspaceRoot: ws });
  assert.equal(older.ok, true);
  assert.equal(older.source, "local");
  assert.equal(older.content.trim(), "VERSION_ONE", "must read the old commit, not HEAD");

  const newer = readFileAt({ repo: "browserstack/testrepo", sha: sha2, path: "app.js", workspaceRoot: ws });
  assert.equal(newer.content.trim(), "VERSION_TWO");
});

test("no local clone -> defers to the caller for a remote read", () => {
  const r = readFileAt({ repo: "browserstack/absent", sha: sha1, path: "app.js", workspaceRoot: ws });
  assert.equal(r.ok, false);
  assert.equal(r.source, "remote-needed");
  assert.match(r.reason, /no local clone/);
});

test("commit absent locally -> remote-needed, and does NOT fetch unless asked", () => {
  const r = readFileAt({ repo: "browserstack/testrepo", sha: "0".repeat(40), path: "app.js", workspaceRoot: ws });
  assert.equal(r.ok, false);
  assert.equal(r.source, "remote-needed");
  assert.match(r.reason, /not present|allowFetch/);
});

// A path that genuinely didn't exist at that commit is an ANSWER. Treating it
// as a fallback trigger would send the caller to the network to be told the
// same thing, and risks a tip-of-branch read papering over the real history.
// The real shape: the plugin lives one level inside the workspace, alongside
// the clones, so the root is found on the second try.
test("discoverWorkspaceRoot walks up to the dir holding the clones", () => {
  const pluginDir = join(ws, "some-plugin");
  mkdirSync(pluginDir, { recursive: true });
  const d = discoverWorkspaceRoot({ repos: ["browserstack/testrepo"], from: pluginDir });
  assert.equal(d.root, ws);
  assert.equal(d.matched, "browserstack/testrepo");
  assert.equal(d.tried.length, 2, "found on the second candidate");
});

// The bound is a feature: from deep inside a repo the root is out of reach,
// and the correct answer is to stop rather than climb toward `/` and risk
// matching an unrelated checkout.
test("discoverWorkspaceRoot stops at maxTries instead of climbing far", () => {
  const deep = join(repoDir, "a", "b", "c");
  mkdirSync(deep, { recursive: true });
  const d = discoverWorkspaceRoot({ repos: ["browserstack/testrepo"], from: deep, maxTries: 3 });
  assert.equal(d.root, null, "workspace is 4 levels up — out of the bounded range");
  assert.equal(d.tried.length, 3);
});

// Genericity: a candidate wins only if it holds a repo THIS run validated.
// Nothing about the product or layout is assumed.
test("discoverWorkspaceRoot verifies against the run's own repo list", () => {
  const d = discoverWorkspaceRoot({ repos: ["browserstack/some-other-product"], from: repoDir });
  assert.equal(d.root, null, "must not accept a dir that lacks the requested repo");
  assert.match(d.reason, /some-other-product/);
});

test("discoverWorkspaceRoot is bounded — it gives up rather than hunting", () => {
  const d = discoverWorkspaceRoot({ repos: ["browserstack/nope"], from: repoDir, maxTries: 3 });
  assert.equal(d.root, null);
  assert.ok(d.tried.length <= 3, `tried ${d.tried.length}, expected <= 3`);
});

test("an explicit root is still VERIFIED, so a stale override fails loudly", () => {
  const ok = discoverWorkspaceRoot({ repos: ["browserstack/testrepo"], explicit: ws });
  assert.equal(ok.root, ws);
  const bad = discoverWorkspaceRoot({ repos: ["browserstack/testrepo"], explicit: join(ws, "nowhere") });
  assert.equal(bad.root, null, "a wrong explicit path must not be trusted blindly");
});

// This is the context-saving payload: resolved once, read by every coordinator.
test("resolveLocalRepos reports per-repo usability at the pinned sha", () => {
  const r = resolveLocalRepos({
    repos: ["browserstack/testrepo", "browserstack/absent"],
    pins: { "browserstack/testrepo": sha1 },
    workspaceRoot: ws,
  });
  assert.equal(r["browserstack/testrepo"].usable, true);
  assert.equal(r["browserstack/testrepo"].sha, sha1);
  assert.equal(r["browserstack/absent"].usable, false);
  assert.match(r["browserstack/absent"].reason, /no local clone/);
});

test("resolveLocalRepos marks a repo unusable when its sha is absent", () => {
  const r = resolveLocalRepos({
    repos: ["browserstack/testrepo"],
    pins: { "browserstack/testrepo": "0".repeat(40) },
    workspaceRoot: ws,
  });
  assert.equal(r["browserstack/testrepo"].usable, false);
  assert.match(r["browserstack/testrepo"].reason, /not present locally/);
});

test("path missing at that commit is a local answer, not a remote fallback", () => {
  const r = readFileAt({ repo: "browserstack/testrepo", sha: sha1, path: "nope.js", workspaceRoot: ws });
  assert.equal(r.ok, false);
  assert.equal(r.source, "local");
  assert.match(r.reason, /path not present/);
});
