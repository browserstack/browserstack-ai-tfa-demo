import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  toolCacheDirFor, cacheKey, mcpCacheKey, cacheGet, cachePut, cacheStats,
  isCacheable, isCacheableMcp, isRunnable, redact, tokenize, splitPipeline,
  isProbeRunnable, isPermittedProbeLeader,
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

// Regression, found by a live coordinator. Redaction used to consume the REST
// OF THE LINE after a secret-ish key. GitHub's file API returns SINGLE-LINE
// JSON whose download_url always carries `?token=…`, so a 214KB response was
// silently cached as 816 bytes with the content field gone — every
// private-repo file fetch was corrupted, with no warning.
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

// Regression, found by two live coordinators. Neither tokenize nor
// splitPipeline handled backslash escapes, so `\"` read as a closing quote.
// That mangled jq's two most common idioms: string equality and, because the
// parser then believed it was outside quotes, regex alternation got split as
// a shell pipe.
test("escaped double quotes survive tokenization for jq", () => {
  const argv = tokenize(String.raw`gh api x --jq .[]|select(.filename==\"a/b.json\")`);
  assert.equal(argv[argv.length - 1], '.[]|select(.filename=="a/b.json")');
});

test("a pipe inside an escaped-quote jq regex is NOT a shell pipe", () => {
  const cmd = String.raw`gh pr view 51044 --json files | jq -c "select(test(\"vite|env|s3\";\"i\"))"`;
  assert.deepEqual(splitPipeline(cmd).length, 2, "must split into fetch + one filter only");
  const g = isRunnable(cmd);
  assert.equal(g.ok, true, g.reason);
  assert.deepEqual(g.fetch, ["gh", "pr", "view", "51044", "--json", "files"]);
  assert.equal(g.filters[0][2], 'select(test("vite|env|s3";"i"))');
});

test("single quotes suppress escape processing, POSIX-style", () => {
  assert.deepEqual(tokenize(String.raw`gh api 'a\nb'`), ["gh", "api", String.raw`a\nb`]);
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

test("isRunnable rejects chaining and redirects, but ACCEPTS pipelines", () => {
  assert.equal(isRunnable("gh api a ; rm -rf /").ok, false);
  assert.equal(isRunnable("gh api a && kubectl delete pod x").ok, false);
  assert.equal(isRunnable("gh api a > /etc/passwd").ok, false);
  // `2>&1` is stderr plumbing the wrapper already owns — stripped, not refused.
  // Refusing it rejected 134 of 223 real recorded calls and zeroed the hit rate.
  assert.equal(isRunnable("gh api a 2>&1").ok, true, "stderr plumbing is normalized away");
  assert.equal(isRunnable("gh api a 2>/dev/null | jq .x").ok, true);
  // Pipelines are supported now: refusing them meant the cache applied to
  // almost no real traffic, since most fetches are written inline with a filter.
  assert.equal(isRunnable("gh api a | jq .x").ok, true);
});

test("a FILE redirect is reported as a redirect, not as a mutation", () => {
  const r = isRunnable("gh api repos/x > out.json");
  assert.equal(r.ok, false);
  assert.match(r.reason, /redirect/i);
  assert.doesNotMatch(r.reason, /mutating/i);
});

test("stderr plumbing does not change the cache key", () => {
  const a = isRunnable("gh api repos/x | jq .a");
  const b = isRunnable("gh api repos/x 2>&1 | jq .b");
  assert.equal(cacheKey(a.fetchText), cacheKey(b.fetchText));
});

test("pipeline plan: only the FETCH is keyed, filters are separate", () => {
  const a = isRunnable("gh api repos/x | jq -r .name");
  const b = isRunnable("gh api repos/x | jq -r .branch | tr a-z A-Z");
  assert.equal(a.ok && b.ok, true);
  // Same underlying fetch -> same cache key -> one network call serves both.
  assert.equal(cacheKey(a.fetchText), cacheKey(b.fetchText));
  assert.deepEqual(a.fetch, ["gh", "api", "repos/x"]);
  assert.equal(a.filters.length, 1);
  assert.equal(b.filters.length, 2);
});

test("only pure text filters may follow the fetch", () => {
  assert.equal(isRunnable("gh api repos/x | jq .a").ok, true);
  assert.equal(isRunnable("gh api repos/x | grep foo").ok, true);
  assert.equal(isRunnable("gh api repos/x | sh").ok, false);
  assert.equal(isRunnable("gh api repos/x | bash -c 'x'").ok, false);
  assert.equal(isRunnable("gh api repos/x | kubectl delete pod y").ok, false);
});

test("splitPipeline ignores a pipe inside quotes", () => {
  assert.deepEqual(splitPipeline(`gh pr list --jq '.[] | .number' | head -5`),
    ["gh pr list --jq '.[] | .number'", "head -5"]);
});

// Regression: the old raw-string guard refused these legitimate read-only
// calls, which is what pushed a coordinator into slower workarounds.
test("isRunnable ALLOWS metacharacters inside quoted arguments", () => {
  const jqSemicolon = `gh api repos/o/r/git/trees/main --jq '[.tree[].path|select(test("rcaThree";"i"))]'`;
  assert.equal(isRunnable(jqSemicolon).ok, true, "; inside a jq expression is not a shell operator");

  const urlAmp = "gh api 'search/code?q=foo&per_page=20'";
  assert.equal(isRunnable(urlAmp).ok, true, "& inside a quoted URL is not a shell operator");

  const jqPipe = `gh pr list -R o/r --json number --jq '.[] | .number'`;
  assert.equal(isRunnable(jqPipe).ok, true, "| inside a quoted jq expression is not a shell pipe");
});

test("a quoted metacharacter survives tokenization as ONE literal argument", () => {
  const argv = tokenize(`gh api repos/o/r --jq '[.tree[]|select(test("x";"i"))]'`);
  assert.equal(argv.length, 5);
  assert.equal(argv[4], '[.tree[]|select(test("x";"i"))]');
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

test("cache files are owner-only (0600) and the dir owner-only (0700)", () => {
  const sub = join(dir, "nested-cache");
  const k = cacheKey("gh api repos/a");
  cachePut(sub, k, { command: "gh api repos/a", stdout: "private repo source" }, 1000);
  // The cache sits in a world-readable OS temp dir and holds raw gh/kubectl
  // output; redaction is best-effort, so the mode is the real control.
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

// ---- the probe gate ---------------------------------------------------------
//
// This is the boundary between a command string that arrived as DATA — from
// config/rca.config.json, from a customer-supplied overlay, or from a connector
// skill under ~/.claude/skills — and execFile. It shipped with no direct tests at
// all: its only coverage was incidental, through validateTable fixtures, so the
// reject paths below had never once executed.

test("a destructive verb is refused however it is attached", () => {
  // The verb scan compared whole argv tokens, so the space-separated form was
  // caught and the attached form was not — on a read-only path holding the
  // customer's real credentials.
  // Refusal is the contract; WHICH guard fires is not. Some of these trip the
  // pre-existing MUTATING scan first, which is an equally correct refusal.
  const refused = [
    ["gh api repos/x --method=DELETE", ["gh"]],
    ["gh api repos/x --method DELETE", ["gh"]],
    ["docker rm container", ["docker"]],
    ["aws s3 rm s3://bucket/key", ["aws"]],
    ["kubectl delete pod x", ["kubectl"]],
    ["nomad job run x.nomad", ["nomad"]],
    ["pm2 delete all", ["pm2"]],
  ];
  for (const [cmd, leaders] of refused) {
    assert.equal(isProbeRunnable(cmd, { leaders }).ok, false, `${cmd} must be refused`);
  }

  // The attached form specifically, which is the hole this closed: no shell
  // metacharacter, nothing the MUTATING scan matches, and the verb rides in as a
  // flag VALUE where a whole-token comparison cannot see it.
  const attached = isProbeRunnable("gh api repos/x --method=DELETE", { leaders: ["gh"] });
  assert.match(attached.reason, /destructive verb/, "the attached form must be caught by the verb scan");
});

test("the read-only status probes each runtime actually ships are accepted", () => {
  // The mirror of the test above: a denylist that also refuses the real probes
  // would have been caught here rather than by every customer at once.
  const cases = [
    ["kubectl version --request-timeout=5s", ["kubectl"]],
    ["docker version", ["docker"]],
    ["aws sts get-caller-identity", ["aws"]],
    ["nomad status", ["nomad"]],
    ["pm2 jlist", ["pm2"]],
    ["logcli labels", ["logcli"]],
    ["promtool --version", ["promtool"]],
    ["gh api repos/acme/api", ["gh"]],
  ];
  for (const [cmd, leaders] of cases) {
    const r = isProbeRunnable(cmd, { leaders });
    assert.equal(r.ok, true, `${cmd} must be accepted: ${r.reason ?? ""}`);
  }
});

test("a backslash-escaped quote cannot hide a shell operator", () => {
  // firstUnquoted had no escape rule while tokenize did, so the two disagreed
  // about where quotes ended: `\"` left the text OUTSIDE quotes for the tokenizer
  // and INSIDE them for the scanner, and the `;` between went unseen.
  const hidden = String.raw`gh api repos/x\";id;:\"`;
  const r = isProbeRunnable(hidden, { leaders: ["gh"] });
  assert.equal(r.ok, false, "an escaped-quote operator must be refused");
  assert.match(r.reason, /metacharacter/);

  // And the idiom the escape rule exists for still works: a quoted jq filter.
  const jq = isProbeRunnable(`gh api repos/x --jq ".[] | \\"x\\""`, { leaders: ["gh"] });
  assert.equal(jq.ok, true, `a quoted jq filter must still be accepted: ${jq.reason ?? ""}`);
});

test("a probe leader must be in the catalog, not merely non-interpreter", () => {
  // Every previous rejection case used an interpreter name, so the "not in the
  // permitted catalog" branch had never run.
  for (const leader of ["npm", "terraform", "ansible", "psql", "mysql"]) {
    const r = isPermittedProbeLeader(leader);
    assert.equal(r.ok, false, `${leader} is not a probe leader`);
  }
  for (const leader of ["gh", "kubectl", "docker", "aws", "nomad", "pm2", "logcli", "promtool"]) {
    assert.equal(isPermittedProbeLeader(leader).ok, true, leader);
  }
});

test("an interpreter is refused as a probe leader whatever else the row says", () => {
  for (const leader of ["bash", "sh", "zsh", "python3", "node", "ruby", "perl", "xargs", "ssh", "nc"]) {
    const r = isPermittedProbeLeader(leader);
    assert.equal(r.ok, false, leader);
  }
});

test("looksLikeSecret is never weaker than redact", async () => {
  // redact() protects a file in temp; looksLikeSecret protects a file that gets
  // COMMITTED. The committed-artifact guard was measurably the weaker of the two:
  // it missed `token=<hex>` and `Basic <base64>`, both of which redact catches.
  // Asserting the relationship rather than a case list keeps it that way.
  const { looksLikeSecret } = await import("../lib/verify.mjs");
  const { EMBEDDED, BENIGN } = await import("./helpers/fake-credentials.mjs");

  // Direction 1 — never weaker. Anything redact flags, looksLikeSecret must flag.
  // This is the relationship that was broken: `token=<hex>` and `Basic <base64>`
  // were redacted out of a temp file and written verbatim into a committed one.
  for (const c of Object.values(EMBEDDED)) {
    if (redact(c) === c) continue; // redact misses it too — direction 2 covers that
    assert.equal(
      looksLikeSecret(c).secret,
      true,
      `looksLikeSecret must flag anything redact flags — missed ${JSON.stringify(c)}`,
    );
  }

  // Direction 2 — strictly stronger where it must be. A URL with userinfo is the
  // shape of an answer to "which log endpoint?", and redact does not catch it.
  assert.equal(redact(EMBEDDED.urlUserinfo), EMBEDDED.urlUserinfo, "precondition: redact misses this");
  assert.equal(looksLikeSecret(EMBEDDED.urlUserinfo).secret, true, "the committed-file guard must not");

  // And neither direction may swallow a real answer.
  for (const b of BENIGN) {
    assert.equal(looksLikeSecret(b).secret, false, `must not flag a legitimate value: ${b}`);
  }
});
