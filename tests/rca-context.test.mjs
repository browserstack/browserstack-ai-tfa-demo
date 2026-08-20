// Real throwaway git repos, following tests/repo-source.test.mjs — the git
// behaviour here (worktree resolution, check-ignore) is the point, so mocking it
// would prove nothing.
//
// The load-bearing assertions:
//   - the artifact is NOT owner-only. Every other persisted file in lib/ is 0600;
//     this one is git-tracked, where that mode is both wrong and not preserved.
//   - a credential-shaped value is refused ANYWHERE, including the field meant to
//     hold a credential reference.
//   - parse / version / missing-field are three distinct named errors, never a
//     silent fall-through to "no context".

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_FILENAME,
  CREDENTIAL_KIND,
  SCHEMA_VERSION,
  contextHomeDir,
  findContextFile,
  findSecretFields,
  readRcaContext,
  resolveIntake,
  startOfRunRefusal,
  writeRcaContext,
} from "../lib/rca-context.mjs";

let ws, productRepo, automationRepo, pluginDir;

const g = (dir, ...a) =>
  execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  g(dir, "init", "-q");
  g(dir, "config", "user.email", "t@t.t");
  g(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "x\n");
  g(dir, "add", ".");
  g(dir, "commit", "-qm", "init");
  return dir;
}

// A realistic workspace: two sibling clones plus the plugin checked out beside
// them. That sibling shape is exactly what a parent-only walk cannot see.
beforeEach(() => {
  // realpath because git reports realpaths and the module canonicalizes to match:
  // on macOS /var is a symlink to /private/var, so an un-resolved fixture path
  // would compare unequal to a correct result.
  ws = realpathSync(mkdtempSync(join(tmpdir(), "rca-ctx-")));
  productRepo = initRepo(join(ws, "api"));
  automationRepo = initRepo(join(ws, "e2e-tests"));
  pluginDir = initRepo(join(ws, "browserstack-ai-tfa-demo"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const validContext = (over = {}) => ({
  schemaVersion: SCHEMA_VERSION,
  homeRepo: "acme/api",
  complete: true,
  repos: ["acme/api", "acme/e2e-tests"],
  subpaths: ["services/billing"],
  baseBranch: "main",
  namespaces: ["prod"],
  workloads: ["billing-consumer"],
  logIndexes: ["app-logs-2026"],
  credentials: { github: { kind: CREDENTIAL_KIND.ENV_VAR, name: "GH_TOKEN" } },
  verified: { github: { ok: true } },
  gaps: [],
  warnings: [],
  ...over,
});

// ---- round trip -------------------------------------------------------------

test("write then read round-trips every portable field, including the overlay", () => {
  const context = validContext({
    capabilities: { logs: { scopeFields: { logIndex: { consumer: "log sweep target" } } } },
  });
  const w = writeRcaContext({ context, verifiedRepos: ["acme/api"], from: productRepo });
  assert.equal(w.ok, true, w.message);
  assert.equal(w.path, join(productRepo, CONTEXT_FILENAME));

  const r = readRcaContext({ from: productRepo });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.context, context);
  assert.equal(r.complete, true);
});

test("a provider-managed credential round-trips and emits no environment-variable name", () => {
  const context = validContext({
    credentials: { github: { kind: CREDENTIAL_KIND.PROVIDER_MANAGED } },
  });
  writeRcaContext({ context, verifiedRepos: ["acme/api"], from: productRepo });
  const r = readRcaContext({ from: productRepo });
  assert.equal(r.context.credentials.github.kind, "provider-managed");
  assert.equal(r.context.credentials.github.name, undefined, "there is no variable to name");
});

test("a partial context reads back with its verified capabilities intact", () => {
  const context = validContext({
    complete: false,
    verified: { github: { ok: true } },
    gaps: [{ capability: "logs", classification: "absent-on-this-machine" }],
  });
  writeRcaContext({ context, verifiedRepos: ["acme/api"], from: productRepo });
  const r = readRcaContext({ from: productRepo });
  assert.equal(r.ok, true);
  assert.equal(r.complete, false, "the caller must be able to tell a partial from a complete one");
  assert.deepEqual(r.context.verified, { github: { ok: true } });
  assert.equal(r.context.gaps.length, 1);
});

// ---- the not-hardened guarantee --------------------------------------------

test("the artifact is NOT owner-only, unlike every other persisted file in lib/", () => {
  writeRcaContext({ context: validContext(), verifiedRepos: ["acme/api"], from: productRepo });
  const mode = statSync(join(productRepo, CONTEXT_FILENAME)).mode & 0o777;
  assert.notEqual(mode, 0o600, "0600 on a git-tracked path is wrong and git will not preserve it");
  assert.ok(mode & 0o044, "it must be readable by the group/world the repo is shared with");
});

test("the module contains no hardening call — the guard is the absence, so assert it", () => {
  const src = readFileSync(new URL("../lib/rca-context.mjs", import.meta.url), "utf8");
  // Look for a CALL, not a mention: the header comment names hardenStateDir
  // precisely to say it must never be used here.
  assert.ok(!/hardenStateDir\s*\(/.test(src), "hardenStateDir must never be pointed at a repo path");
  assert.ok(!/chmodSync\s*\(/.test(src), "no chmod on a tracked file");
  assert.ok(!/mode:\s*0o[67]00/.test(src), "no owner-only mode on write");
});

test("a written context is actually tracked by git after add", () => {
  writeRcaContext({ context: validContext(), verifiedRepos: ["acme/api"], from: productRepo });
  g(productRepo, "add", CONTEXT_FILENAME);
  const shown = g(productRepo, "show", `:${CONTEXT_FILENAME}`);
  assert.match(shown, /"homeRepo": "acme\/api"/, "committing it must actually carry the content");
});

// ---- read resolution --------------------------------------------------------

test("read resolution finds a context in a SIBLING repo, which a parent-only walk cannot", () => {
  // The failure this prevents: a context committed to the product repo, a run
  // started from the automation repo, and a no-context refusal on a machine that
  // is fully set up.
  writeRcaContext({ context: validContext(), verifiedRepos: ["acme/api"], from: productRepo });
  const found = findContextFile({ from: automationRepo });
  assert.equal(found, join(productRepo, CONTEXT_FILENAME));
});

test("the plugin's own directory is never selected, even when it holds a candidate", () => {
  // The documented install flow is `git clone <plugin> && cd <plugin>`, so cwd IS
  // the plugin on a first run. A context there is inherited by nobody.
  writeFileSync(
    join(pluginDir, CONTEXT_FILENAME),
    JSON.stringify(validContext({ homeRepo: "acme/browserstack-ai-tfa-demo" })),
  );
  writeRcaContext({ context: validContext(), verifiedRepos: ["acme/api"], from: productRepo });
  const found = findContextFile({ from: pluginDir, pluginRoot: pluginDir });
  assert.equal(found, join(productRepo, CONTEXT_FILENAME), "it must skip the plugin and find the real one");
});

test("a candidate whose declared home repo does not match its directory is skipped", () => {
  writeFileSync(
    join(automationRepo, CONTEXT_FILENAME),
    JSON.stringify(validContext({ homeRepo: "acme/some-other-repo" })),
  );
  writeRcaContext({ context: validContext(), verifiedRepos: ["acme/api"], from: productRepo });
  assert.equal(findContextFile({ from: automationRepo }), join(productRepo, CONTEXT_FILENAME));
});

// ---- write resolution -------------------------------------------------------

test("write resolution targets the declared home repo's worktree root, not cwd", () => {
  const nested = join(productRepo, "services", "billing");
  mkdirSync(nested, { recursive: true });
  const w = writeRcaContext({ context: validContext(), verifiedRepos: ["acme/api"], from: nested });
  assert.equal(w.path, join(productRepo, CONTEXT_FILENAME), "the toplevel, not the subdirectory");
});

test("a home repo that is not a git working tree refuses with a named fix", () => {
  const plain = join(ws, "not-a-repo");
  mkdirSync(plain);
  const w = writeRcaContext({
    context: validContext({ homeRepo: "acme/not-a-repo" }),
    verifiedRepos: ["acme/not-a-repo"],
    from: plain,
  });
  assert.equal(w.ok, false);
  assert.equal(w.code, "no-git-worktree");
  assert.match(w.message, /run setup from inside the repository/i);
});

test("a home repo outside the verified set is refused", () => {
  const w = writeRcaContext({
    context: validContext({ homeRepo: "acme/unverified" }),
    verifiedRepos: ["acme/api"],
    from: productRepo,
  });
  assert.equal(w.ok, false);
  assert.equal(w.code, "home-repo-unverified");
});

test("a destination matched by a gitignore rule is refused, naming the rule", () => {
  writeFileSync(join(productRepo, ".gitignore"), `${CONTEXT_FILENAME}\n`);
  const w = writeRcaContext({ context: validContext(), verifiedRepos: ["acme/api"], from: productRepo });
  assert.equal(w.ok, false);
  assert.equal(w.code, "ignored-destination");
  assert.match(w.rule, /gitignore/);
  assert.match(w.message, /never be committed/);
});

// ---- fail loud on drift -----------------------------------------------------

test("an unparseable context is a parse error, never a silent missing context", () => {
  // A hand-resolved merge conflict is the realistic source. Degrading to "no
  // context" would trigger a full re-interview and look like the feature
  // forgetting the customer.
  writeFileSync(join(productRepo, CONTEXT_FILENAME), '{"homeRepo": "acme/api",\n<<<<<<< HEAD\n');
  const r = readRcaContext({ from: productRepo });
  assert.equal(r.ok, false);
  assert.equal(r.code, "parse-error");
  assert.match(r.message, /merge conflict/i);
  assert.notEqual(r.code, "no-context");
});

test("an older schemaVersion is a version error naming both versions", () => {
  writeFileSync(join(productRepo, CONTEXT_FILENAME), JSON.stringify(validContext({ schemaVersion: 0 })));
  const r = readRcaContext({ from: productRepo });
  assert.equal(r.ok, false);
  assert.equal(r.code, "schema-version");
  assert.equal(r.found, 0);
  assert.equal(r.expected, SCHEMA_VERSION);
});

test("a missing required field is reported by name", () => {
  const bad = validContext();
  delete bad.homeRepo;
  delete bad.complete;
  writeFileSync(join(productRepo, CONTEXT_FILENAME), JSON.stringify(bad));
  const r = readRcaContext({ from: productRepo, path: join(productRepo, CONTEXT_FILENAME) });
  assert.equal(r.ok, false);
  assert.equal(r.code, "missing-field");
  assert.deepEqual(r.fields.sort(), ["complete", "homeRepo"]);
});

test("no context at all is its own distinct code", () => {
  const r = readRcaContext({ from: automationRepo });
  assert.equal(r.ok, false);
  assert.equal(r.code, "no-context");
});

// ---- the write-time secret guard -------------------------------------------

// Assembled at runtime, never written as literals: a test file full of
// token-shaped strings trips every secret scanner in CI, and this repo's
// pre-commit guard rejects it outright.
const mixedBody = (n) => {
  let s = "";
  for (let i = 0; s.length < n; i++) s += "aB3"[i % 3];
  return s.slice(0, n);
};
const FAKE_PAT = "gh" + "p_" + mixedBody(36);
const FAKE_HIGH_ENTROPY = mixedBody(40);

test("a credential-shaped value is refused ANYWHERE, including the credential field itself", () => {
  // No field is exempt. The credential-reference field is exactly where a pasted
  // secret most plausibly lands, so exempting it would leave the likeliest leak
  // unguarded.
  const placements = [
    ["credentials.github.name", validContext({ credentials: { github: { kind: "env-var", name: FAKE_PAT } } })],
    ["baseBranch", validContext({ baseBranch: FAKE_PAT })],
    ["repos[0]", validContext({ repos: [FAKE_HIGH_ENTROPY] })],
    ["nested overlay", validContext({ capabilities: { logs: { note: FAKE_PAT } } })],
  ];
  for (const [where, context] of placements) {
    const w = writeRcaContext({ context, verifiedRepos: ["acme/api"], from: productRepo });
    assert.equal(w.ok, false, `${where} must be refused`);
    assert.equal(w.code, "secret-in-field");
    assert.ok(w.fields.length > 0, "and must name where it was");
    assert.ok(!JSON.stringify(w).includes(FAKE_PAT), "without echoing the value it refused");
    assert.match(w.message, /rotate/i, "and must say to rotate it");
  }
});

test("the refused write leaves no file behind", () => {
  const w = writeRcaContext({
    context: validContext({ baseBranch: FAKE_PAT }),
    verifiedRepos: ["acme/api"],
    from: productRepo,
  });
  assert.equal(w.ok, false);
  assert.equal(readRcaContext({ from: productRepo }).code, "no-context", "nothing may be persisted");
});

test("findSecretFields names the path but never the value", () => {
  const hits = findSecretFields(validContext({ baseBranch: FAKE_PAT }));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "baseBranch");
  assert.equal(hits[0].kind, "github-pat");
  assert.ok(!JSON.stringify(hits).includes(FAKE_PAT));
});

test("the ordinary values a real context holds are not refused", () => {
  const w = writeRcaContext({ context: validContext(), verifiedRepos: ["acme/api"], from: productRepo });
  assert.equal(w.ok, true, `a legitimate context must persist: ${w.message ?? ""}`);
});

test("a complete context whose GitHub is unverified is refused — write a partial instead", () => {
  // The skill body says "GitHub never persists as unverified". A sentence an agent
  // has to obey is exactly the enforcement this milestone exists to replace, so the
  // rule is a guard: the state it forbids is one every run would refuse, with no
  // signal to the customer which rule applied.
  for (const verified of [{}, { github: { ok: false } }, { infra: { ok: true } }]) {
    const w = writeRcaContext({
      context: validContext({ complete: true, verified }),
      verifiedRepos: ["acme/api"],
      from: productRepo,
    });
    assert.equal(w.ok, false, `verified=${JSON.stringify(verified)} must be refused`);
    assert.equal(w.code, "incomplete-github");
    assert.match(w.message, /complete: false/, "and must name the alternative");
  }
});

test("the same context as a partial is accepted", () => {
  const w = writeRcaContext({
    context: validContext({ complete: false, verified: { infra: { ok: true } } }),
    verifiedRepos: ["acme/api"],
    from: productRepo,
  });
  assert.equal(w.ok, true, w.message);
  assert.equal(readRcaContext({ from: productRepo }).complete, false);
});

// ---- start-of-run refusals --------------------------------------------------

test("no context refuses and points at setup", () => {
  const r = startOfRunRefusal({ ok: false, code: "no-context" });
  assert.equal(r.refuse, true);
  assert.equal(r.code, "no-context");
  assert.match(r.nextAction, /rca-setup/);
});

test("a present-but-unreadable context is a DIFFERENT refusal from an absent one", () => {
  // Telling someone to run setup when their context is merely conflict-marked
  // throws away every answer they already gave. This is the case a prose list of
  // refusals forgets, because it looks like "no context" until you look closely.
  for (const code of ["parse-error", "schema-version", "missing-field", "unreadable"]) {
    const r = startOfRunRefusal({ ok: false, code, path: "/w/api/.rca-context.json", message: "detail" });
    assert.equal(r.refuse, true, code);
    assert.equal(r.code, "unreadable-context", code);
    assert.notEqual(r.code, "no-context");
    assert.equal(r.path, "/w/api/.rca-context.json", "and it names the file");
    assert.ok(r.nextAction.trim().length > 0);
  }
});

test("a context whose GitHub is unverified refuses, naming the credential path", () => {
  const r = startOfRunRefusal({
    ok: true,
    path: "/w/api/.rca-context.json",
    context: { complete: false, verified: { infra: { ok: true } } },
  });
  assert.equal(r.refuse, true);
  assert.equal(r.code, "github-unverified");
  assert.match(r.nextAction, /credential/i);
});

test("a PARTIAL context with verified GitHub proceeds, and says it is partial", () => {
  // The one rule: a partial runs iff GitHub is verified in it. Refusing every
  // partial would brick the resume path the partial exists to enable.
  const r = startOfRunRefusal({
    ok: true,
    path: "/w/api/.rca-context.json",
    context: { complete: false, verified: { github: { ok: true } } },
  });
  assert.equal(r.refuse, false);
  assert.equal(r.partial, true, "the caller must know to declare the unanswered capabilities as gaps");
});

test("a complete context with verified GitHub proceeds and is not partial", () => {
  const r = startOfRunRefusal({ ok: true, context: { complete: true, verified: { github: { ok: true } } } });
  assert.deepEqual({ refuse: r.refuse, partial: r.partial }, { refuse: false, partial: false });
});

// ---- intake precedence ------------------------------------------------------

test("resolveIntake ranks the four sources and names the winner per field", () => {
  const r = resolveIntake({
    buildMeta: { branch: "release-42" },
    invocationArgs: { repo: "acme/api-from-args" },
    context: { repo: "acme/api", branch: "main", subpaths: ["services/billing"] },
    connectorDefaults: { repo: "acme/legacy", namespace: "default" },
  });
  assert.deepEqual(r.branch, { value: "release-42", source: "buildMeta" });
  assert.deepEqual(r.repo, { value: "acme/api-from-args", source: "invocationArgs" });
  assert.deepEqual(r.subpaths, { value: ["services/billing"], source: "context" });
  assert.deepEqual(r.namespace, { value: "default", source: "connectorDefaults" });
});

test("verified context outranks a connector's intake defaults", () => {
  // The adapter's load-bearing rule. Today a declaring connector skill supersedes
  // the raw tool and the gate checks intake defaults first, so an adapter landing
  // underneath both would be invisible — and the proving run would pass while
  // proving nothing.
  const r = resolveIntake({
    context: { baseBranch: "main" },
    connectorDefaults: { baseBranch: "develop" },
  });
  assert.deepEqual(r.baseBranch, { value: "main", source: "context" });
});

test("a field no source supplies comes back unresolved rather than guessed", () => {
  // Inference is the gate's job, and only on these fields. A function given four
  // sources cannot rank a five-tier chain, and pretending otherwise would either
  // invent a parameter or silently drop the tier.
  const r = resolveIntake({ context: { repo: "acme/api" }, fields: ["repo", "namespace"] });
  assert.deepEqual(r.repo, { value: "acme/api", source: "context" });
  assert.deepEqual(r.namespace, { value: null, source: "unresolved" });
});

test("empty strings and nulls do not win a field", () => {
  const r = resolveIntake({
    buildMeta: { branch: "" },
    invocationArgs: { branch: null },
    context: { branch: "main" },
  });
  assert.deepEqual(r.branch, { value: "main", source: "context" });
});

test("contextHomeDir is reusable on its own for the digest", () => {
  const h = contextHomeDir({ homeRepo: "acme/api", verifiedRepos: ["acme/api"], from: automationRepo });
  assert.equal(h.ok, true);
  assert.equal(h.dir, productRepo);
});
