import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  toolCacheDirFor, cacheKey, mcpCacheKey, cacheGet, cachePut, cacheStats,
  isCacheable, isCacheableMcp, isImmutableRead, isRunStableRead, redact, banner,
} from "../lib/tool-cache.mjs";

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rca-toolcache-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("toolCacheDirFor: build id in the path, OS temp default, stateDir override", () => {
  assert.ok(toolCacheDirFor("b1").startsWith(join(tmpdir(), "bstack-rca")));
  assert.ok(toolCacheDirFor("b1").endsWith("rca-toolcache.b1"));
  assert.equal(toolCacheDirFor("b1", "/ci/art"), join("/ci/art", "rca-toolcache.b1"));
  assert.ok(toolCacheDirFor("../../etc").endsWith("rca-toolcache..._.._etc"));
});

test("cacheKey: whitespace-insensitive, but content-sensitive", () => {
  assert.equal(cacheKey("gh api  repos/a"), cacheKey("gh   api repos/a"));
  assert.notEqual(cacheKey("gh api repos/a | head -20"), cacheKey("gh api repos/a | head -200"));
});

test("put then get round-trips", () => {
  const k = cacheKey("gh api repos/a");
  cachePut(dir, k, { command: "gh api repos/a", writerId: "w1", stdout: "hello" }, 1000);
  const hit = cacheGet(dir, k);
  assert.equal(hit.stdout, "hello");
  assert.equal(hit.writerId, "w1");
  assert.equal(hit.capturedAtMs, 1000);
});

test("get on a miss returns null, never throws", () => {
  assert.equal(cacheGet(dir, cacheKey("never run")), null);
});

test("a corrupt entry reads as a miss rather than throwing", () => {
  const k = cacheKey("gh api repos/a");
  writeFileSync(join(dir, `${k}.json`), "{not json", "utf8");
  assert.equal(cacheGet(dir, k), null);
});

test("secrets are redacted before anything is written to disk", () => {
  const k = cacheKey("gh api repos/a");
  cachePut(dir, k, {
    command: "gh api repos/a",
    stdout: 'ok\nAuthorization: Bearer abc123SECRET\napi_key=zzz999\ndone',
  }, 1000);
  const raw = cacheGet(dir, k).stdout;
  assert.ok(!raw.includes("abc123SECRET"), "bearer token must not persist");
  assert.ok(!raw.includes("zzz999"), "api_key must not persist");
  assert.ok(raw.includes("<redacted>"));
});

test("redact leaves ordinary output untouched", () => {
  assert.equal(redact("just some log output"), "just some log output");
});

test("redact bounds the value and does NOT eat the rest of a single-line JSON", () => {
  const json = '{"name":"F.java","download_url":"https://raw.example/F.java?token=BRFIJBHPIG5IILHZ",'
    + '"type":"file","content":"' + "A".repeat(5000) + '"}';
  const out = redact(json);
  assert.ok(!out.includes("BRFIJBHPIG5IILHZ"), "the token itself must be redacted");
  assert.ok(out.includes('"type":"file"'), "structure after the token must survive");
  assert.ok(out.includes("A".repeat(5000)), "the content payload must survive");
  assert.ok(out.length > 5000, `expected full payload, got ${out.length} bytes`);
});

test("redact still catches a bare Bearer token and a key=value secret", () => {
  assert.equal(redact("Authorization: Bearer abc123SECRET"), "Authorization: <redacted>");
  assert.equal(redact("api_key=zzz999"), "api_key=<redacted>");
  assert.ok(!redact("Bearer eyJhbGciOiJIUzI1NiJ9").includes("eyJhbGciOiJIUzI1NiJ9"));
});

test("oversized payloads are truncated and flagged", () => {
  const k = cacheKey("gh api big");
  const rec = cachePut(dir, k, { command: "gh api big", stdout: "x".repeat(400 * 1024) }, 1000);
  assert.equal(rec.truncated, true);
  assert.ok(rec.stdout.includes("[truncated by tool-cache]"));
});

test("cacheStats counts entries", () => {
  cachePut(dir, "k1", { command: "a", stdout: "12345" }, 1);
  cachePut(dir, "k2", { command: "b", stdout: "123" }, 1);
  const s = cacheStats(dir);
  assert.equal(s.entries, 2);
  assert.equal(s.bytes, 8);
});

// ---- isCacheable: mutation denylist ----------------------------------------

test("isCacheable rejects mutating shell commands", () => {
  assert.equal(isCacheable("gh api repos/a"), true);
  assert.equal(isCacheable("kubectl get pods"), true);
  assert.equal(isCacheable("kubectl delete pod x"), false);
  assert.equal(isCacheable("kubectl exec pod -- sh"), false);
  assert.equal(isCacheable("gh pr create --title x"), false);
  assert.equal(isCacheable("gh api -X POST repos/a"), false);
  assert.equal(isCacheable("git push origin main"), false);
  assert.equal(isCacheable("rm -rf /tmp/x"), false);
});

// ---- isImmutableRead: the new cacheability predicate -----------------------

test("isImmutableRead: gh api with /git/ path is cacheable", () => {
  assert.equal(isImmutableRead("gh api repos/o/r/git/blobs/abc123"), true);
  assert.equal(isImmutableRead("gh api repos/o/r/git/trees/main"), true);
  assert.equal(isImmutableRead("gh api repos/o/r/git/commits/abc"), true);
});

test("isImmutableRead: gh api with ?ref=<40-hex-sha> is cacheable", () => {
  const sha = "a".repeat(40);
  assert.equal(isImmutableRead(`gh api repos/o/r/contents/f?ref=${sha}`), true);
  assert.equal(isImmutableRead(`gh api 'repos/o/r/contents/f?ref=${sha}&other=1'`), true);
});

test("isImmutableRead: unpinned gh api is NOT cacheable", () => {
  assert.equal(isImmutableRead("gh api repos/o/r/pulls/123"), false);
  assert.equal(isImmutableRead("gh api repos/o/r/contents/f"), false);
  assert.equal(isImmutableRead("gh api repos/o/r/contents/f?ref=main"), false);
});

test("isImmutableRead: git show/cat-file/ls-tree/log with sha is cacheable", () => {
  const sha = "b".repeat(40);
  assert.equal(isImmutableRead(`git show ${sha}:path/to/file`), true);
  assert.equal(isImmutableRead(`git cat-file -p ${sha}`), true);
  assert.equal(isImmutableRead(`git ls-tree ${sha}`), true);
  assert.equal(isImmutableRead(`git log ${sha} --oneline`), true);
});

test("isImmutableRead: git commands without sha are NOT cacheable", () => {
  assert.equal(isImmutableRead("git show HEAD:path/to/file"), false);
  assert.equal(isImmutableRead("git log main --oneline"), false);
  assert.equal(isImmutableRead("git diff"), false);
  assert.equal(isImmutableRead("git status"), false);
  assert.equal(isImmutableRead("git branch"), false);
});

test("isImmutableRead: kubectl and curl are never cacheable (live state)", () => {
  assert.equal(isImmutableRead("kubectl get pods -n regression"), false);
  assert.equal(isImmutableRead("curl https://example.com"), false);
});

// ---- isRunStableRead: repo reads that don't change within one build RCA -----

test("isRunStableRead: gh pr view/diff/list by number are cacheable", () => {
  assert.equal(isRunStableRead("gh pr view 53786 --repo browserstack/frontend --json files,title"), true);
  assert.equal(isRunStableRead("gh pr diff 53786 --repo browserstack/frontend"), true);
  assert.equal(isRunStableRead("gh pr list -R browserstack/frontend"), true);
});

test("isRunStableRead: gh search and gh api repo reads are cacheable", () => {
  assert.equal(isRunStableRead('gh search code "env.js" --repo browserstack/frontend'), true);
  assert.equal(isRunStableRead("gh api repos/o/r/contents/apps/o11y/index.html"), true);
  assert.equal(isRunStableRead("gh api repos/o/r/pulls/123"), true);
});

test("isRunStableRead: gh api writes are NOT run-stable", () => {
  assert.equal(isRunStableRead("gh api -X POST repos/o/r/pulls"), false);
  assert.equal(isRunStableRead("gh api --method PATCH repos/o/r/pulls/1"), false);
});

test("isRunStableRead: read-only git (no sha) is cacheable", () => {
  assert.equal(isRunStableRead("git show HEAD:path/to/file"), true);
  assert.equal(isRunStableRead("git log main --oneline"), true);
  assert.equal(isRunStableRead("git diff main...HEAD"), true);
});

test("isRunStableRead: live state and mutations are NOT run-stable", () => {
  assert.equal(isRunStableRead("kubectl get pods -n regression"), false);
  assert.equal(isRunStableRead("kubectl logs pod-x"), false);
  assert.equal(isRunStableRead("curl https://example.com"), false);
  assert.equal(isRunStableRead("gh pr create --title x"), false);
});

test("isImmutableRead: gh pr list/view are NOT cacheable (mutable state)", () => {
  assert.equal(isImmutableRead("gh pr list -R o/r"), false);
  assert.equal(isImmutableRead("gh pr view 123"), false);
});

// ---- MCP -------------------------------------------------------------------

test("MCP: stateful tools are never cacheable", () => {
  assert.equal(isCacheableMcp("mcp__grafana__query_loki_logs"), true);
  assert.equal(isCacheableMcp("mcp__browserstack__listTestIds"), true);
  assert.equal(isCacheableMcp("mcp__browserstack__tfaRcaTurn"), false);
  assert.equal(isCacheableMcp("mcp__browserstack__getTfaTurnResult"), false);
  assert.equal(isCacheableMcp("mcp__browserstack__triggerRcaReport"), false);
});

test("mcpCacheKey is argument-order independent but value sensitive", () => {
  const a = mcpCacheKey("t", { b: 2, a: 1 });
  const b = mcpCacheKey("t", { a: 1, b: 2 });
  assert.equal(a, b);
  assert.notEqual(a, mcpCacheKey("t", { a: 1, b: 3 }));
  assert.notEqual(a, mcpCacheKey("other", { a: 1, b: 2 }));
});

test("mcpCacheKey canonicalizes nested objects and arrays", () => {
  assert.equal(
    mcpCacheKey("t", { q: { z: 1, y: [{ n: 1, m: 2 }] } }),
    mcpCacheKey("t", { q: { y: [{ m: 2, n: 1 }], z: 1 } }),
  );
});

test("an MCP result round-trips through the shared store", () => {
  const k = mcpCacheKey("mcp__grafana__query_loki_logs", { ns: "regression", limit: 50 });
  cachePut(dir, k, { command: "grafana query", writerId: "3889074893", stdout: "0 rows, clean" }, 1000);
  assert.equal(cacheGet(dir, k).stdout, "0 rows, clean");
});

// ---- Permissions -----------------------------------------------------------

test("cache files are owner-only (0600) and the dir owner-only (0700)", () => {
  const sub = join(dir, "nested-cache");
  const k = cacheKey("gh api repos/a");
  cachePut(sub, k, { command: "gh api repos/a", stdout: "private repo source" }, 1000);
  assert.equal(statSync(join(sub, `${k}.json`)).mode & 0o777, 0o600);
  assert.equal(statSync(sub).mode & 0o777, 0o700);
});

test("no temp file is left behind after an atomic put", () => {
  const k = cacheKey("gh api repos/a");
  cachePut(dir, k, { command: "gh api repos/a", stdout: "x" }, 1000);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("CONCURRENCY: same key written twice stays readable and consistent", () => {
  const k = cacheKey("gh api repos/a");
  cachePut(dir, k, { command: "gh api repos/a", writerId: "w1", stdout: "same-bytes" }, 1000);
  cachePut(dir, k, { command: "gh api repos/a", writerId: "w2", stdout: "same-bytes" }, 2000);
  assert.equal(cacheGet(dir, k).stdout, "same-bytes");
});

// ---- banner ----------------------------------------------------------------

test("banner is exported and callable", () => {
  // Just verify it doesn't throw when called without a logPath
  assert.doesNotThrow(() => banner("[test]", ""));
});
