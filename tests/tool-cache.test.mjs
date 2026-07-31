import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  toolCacheDirFor, cacheKey, mcpCacheKey, cacheGet, cachePut, cacheStats,
  isCacheable, isCacheableMcp, isRunnable, redact, tokenize,
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

test("isRunnable enforces an allowlisted read-only leader", () => {
  assert.equal(isRunnable("gh api repos/a").ok, true);
  assert.equal(isRunnable("kubectl get pods -n regression").ok, true);
  assert.equal(isRunnable("python3 -c 'print(1)'").ok, false);
  assert.equal(isRunnable("sh -c 'echo hi'").ok, false);
});

test("isRunnable rejects chaining, substitution and redirects", () => {
  assert.equal(isRunnable("gh api a; rm -rf /").ok, false);
  assert.equal(isRunnable("gh api a && kubectl delete pod x").ok, false);
  assert.equal(isRunnable("gh api $(whoami)").ok, false);
  assert.equal(isRunnable("gh api a > /etc/passwd").ok, false);
  assert.equal(isRunnable("gh api a `id`").ok, false);
});

test("tokenize splits like a shell for quoted args, without a shell", () => {
  assert.deepEqual(tokenize("gh api repos/a --jq '.items[].path'"),
    ["gh", "api", "repos/a", "--jq", ".items[].path"]);
  assert.deepEqual(tokenize('kubectl get pods -o "custom:.metadata.name"'),
    ["kubectl", "get", "pods", "-o", "custom:.metadata.name"]);
  assert.throws(() => tokenize("gh api 'unterminated"), /unterminated quote/);
});

test("tokenize keeps injection payloads as ONE literal argument", () => {
  // With execFile + these argv, no shell ever sees the metacharacters.
  const argv = tokenize(`gh api "repos/a;rm -rf /"`);
  assert.deepEqual(argv, ["gh", "api", "repos/a;rm -rf /"]);
});

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

test("CONCURRENCY: same key written twice stays readable and consistent", () => {
  const k = cacheKey("gh api repos/a");
  cachePut(dir, k, { command: "gh api repos/a", writerId: "w1", stdout: "same-bytes" }, 1000);
  cachePut(dir, k, { command: "gh api repos/a", writerId: "w2", stdout: "same-bytes" }, 2000);
  assert.equal(cacheGet(dir, k).stdout, "same-bytes");
});
