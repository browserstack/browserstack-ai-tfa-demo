// Verification's deliverable IS its failure taxonomy, so this suite is written
// first and the module is built to satisfy it.
//
// Two guarantees carry the weight, and both are asserted rather than described:
//   1. No record this module produces may contain a secret-shaped string. The
//      committed context has no file-permission backstop, so detection is the only
//      control — and `redact` provably cannot supply it for a bare token.
//   2. Every failure record names a next action. A diagnostic with no next step is
//      how a customer gets stuck at the one mandatory gate in the flow.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCESS_LEVEL,
  GAP_CLASS,
  PR_WINDOW_DAYS,
  classifyGap,
  looksLikeSecret,
  nearMatch,
  prWindowWarning,
  replayProbe,
  scrubFailure,
  verifyCapability,
  verifyGithub,
} from "../lib/verify.mjs";
import { redact } from "../lib/tool-cache.mjs";
import { loadCapabilityTable } from "../lib/capability-table.mjs";
import { FAKE } from "./helpers/fake-credentials.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const config = JSON.parse(readFileSync(join(ROOT, "config/rca.config.json"), "utf8"));
const { table } = loadCapabilityTable(config);


// ---- the P0: bare-token detection ------------------------------------------

test("redact cannot detect a bare token — the reason this module has its own detector", () => {
  // Verified, not assumed. redact's patterns need a key prefix (token=) or an auth
  // scheme (Bearer). A bare secret returns byte-identical, so any detector built on
  // `redact(v) !== v` reports "clean" for exactly the input that matters most.
  for (const bare of [FAKE.githubPat, FAKE.gitlabPat, FAKE.awsKeyId]) {
    assert.equal(redact(bare), bare, `redact must be shown to pass ${bare.slice(0, 8)}… unchanged`);
  }
  // And the same value inside a key=value IS redacted, which is the shape it covers.
  assert.notEqual(redact(`token=${FAKE.githubPat}`), `token=${FAKE.githubPat}`);
});

test("looksLikeSecret catches bare provider token shapes, each asserted individually", () => {
  const shapes = [
    [FAKE.githubPat, "github-pat"],
    [FAKE.githubFine, "github-pat"],
    [FAKE.gitlabPat, "gitlab-pat"],
    [FAKE.awsKeyId, "aws-access-key-id"],
    [FAKE.slackToken, "slack-token"],
    [FAKE.apiKey, "api-key"],
  ];
  for (const [value, kind] of shapes) {
    const r = looksLikeSecret(value);
    assert.equal(r.secret, true, `${value.slice(0, 10)}… must be detected`);
    assert.equal(r.kind, kind);
  }
});

test("looksLikeSecret catches a long high-entropy run with no recognisable prefix", () => {
  const r = looksLikeSecret(FAKE.highEntropy);
  assert.equal(r.secret, true);
  assert.equal(r.kind, "high-entropy");
});

test("looksLikeSecret does not flag the ordinary values a context legitimately holds", () => {
  // False positives here are expensive: they would refuse to persist a valid
  // context and there is no override.
  const benign = [
    "main", "release-42", "acme/api", "services/billing", "prod", "staging",
    "app-logs-2026", "billing-consumer", "gh", "kubectl", "GH_TOKEN",
    "browserstack-euc1-stag-001",
    // A git SHA is 40 chars of lowercase hex. Long, but not a secret, and the
    // entropy rule must not swallow it.
    FAKE.gitSha,
  ];
  for (const v of benign) {
    assert.equal(looksLikeSecret(v).secret, false, `${v} must NOT be flagged`);
  }
});

// ---- scrubbing -------------------------------------------------------------

test("scrubFailure reduces raw provider output to an error class, never passing the raw string", () => {
  const raw = `HTTP 401: Bad credentials (Authorization: Bearer ${FAKE.githubPat})`;
  const out = scrubFailure(raw);
  assert.equal(typeof out, "string");
  assert.ok(!out.includes(FAKE.githubPat), "the token must not survive");
  assert.ok(!out.includes("Bearer"), "nor the scheme that carried it");
  assert.match(out, /unauthorized|auth/i, "but the class must be recognisable");
});

test("scrubFailure classifies the failures the GitHub gate must distinguish", () => {
  const cases = [
    ["command not found: gh", "not-installed"],
    ["gh: To get started with GitHub CLI, please run: gh auth login", "not-authenticated"],
    ["HTTP 401: Bad credentials", "unauthorized"],
    ["HTTP 403: Resource not accessible by personal access token", "forbidden"],
    ["HTTP 404: Not Found", "not-found"],
    ["dial tcp: lookup api.github.com: no such host", "network"],
  ];
  for (const [raw, want] of cases) {
    assert.equal(scrubFailure(raw), want, JSON.stringify(raw));
  }
});

// ---- near-match suggestions -------------------------------------------------

test("nearMatch suggests the intended value for a plausible typo", () => {
  assert.equal(nearMatch("mian", ["main", "master", "develop"]), "main");
  assert.equal(nearMatch("acme/ap", ["acme/api", "acme/web"]), "acme/api");
});

test("nearMatch returns null rather than a misleading suggestion when nothing is close", () => {
  assert.equal(nearMatch("totally-different", ["main", "master"]), null);
  assert.equal(nearMatch("main", []), null);
});

// ---- per-target verification ------------------------------------------------

test("a capability valid for one target and 404 on another stays valid for the target that passed", () => {
  const row = table.github;
  const runProbe = replayProbe({
    "gh api repos/acme/api": { ok: true, stdout: "{}" },
    "gh api repos/acme/ghost": { ok: false, raw: "HTTP 404: Not Found" },
  });
  const r = verifyCapability({
    capability: "github",
    row,
    targets: [{ field: "repo", value: "acme/api" }, { field: "repo", value: "acme/ghost" }],
    scope: { branch: "main" },
    runProbe,
  });
  assert.equal(r.verified, true, "one passing target keeps the capability usable");
  assert.deepEqual(r.targets.filter((t) => t.ok).map((t) => t.value), ["acme/api"]);
  const failed = r.targets.find((t) => !t.ok);
  assert.equal(failed.value, "acme/ghost");
  assert.equal(failed.gap.errorClass, "not-found");
  assert.ok(failed.gap.nextAction, "a per-target gap still names a next action");
});

test("every failure record names a next action and carries no raw provider output", () => {
  const runProbe = replayProbe({
    "gh api repos/acme/api": {
      ok: false,
      raw: `HTTP 401: Bad credentials (Authorization: Bearer ${FAKE.githubPat})`,
    },
  });
  const r = verifyCapability({
    capability: "github",
    row: table.github,
    targets: [{ field: "repo", value: "acme/api" }],
    scope: { branch: "main" },
    runProbe,
    envVar: "GH_TOKEN",
  });
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes(FAKE.githubPat), "no record may carry a secret-shaped string");
  assert.ok(!serialized.includes("Bad credentials"), "nor raw provider text");
  for (const t of r.targets.filter((x) => !x.ok)) {
    assert.ok(t.gap.nextAction && t.gap.nextAction.trim().length > 0);
    assert.equal(t.gap.envVar, "GH_TOKEN", "the env-var NAME is safe to record; its value never is");
  }
});

// ---- GitHub is binary -------------------------------------------------------

test("gh absent and no GitHub MCP present refuses, naming the install (AE3)", () => {
  const r = verifyGithub({
    row: table.github,
    scope: { repo: "acme/api", branch: "main" },
    env: { executables: [], mcpServers: [] },
    runProbe: replayProbe({}),
  });
  assert.equal(r.verified, false);
  assert.equal(r.blocking, true, "GitHub is the one capability that stops setup");
  assert.match(r.message, /cannot move ahead/i);
  assert.match(r.nextAction, /gh|GitHub MCP/, "and it names the route to install");
});

test("gh absent but a GitHub MCP present verifies through the injected MCP probe result", () => {
  // Only the agent can invoke an MCP tool, so verify never calls one — the agent
  // hands the result in through the same executor shape as a CLI probe.
  const r = verifyGithub({
    row: table.github,
    scope: { repo: "acme/api", branch: "main", githubMcpTool: "github/get_repository" },
    env: { executables: [], mcpServers: ["github-mcp"] },
    runProbe: replayProbe({ "mcp:github/get_repository": { ok: true, stdout: "{}" } }),
    prList: { mergedCount: 4, windowDays: PR_WINDOW_DAYS },
  });
  assert.equal(r.verified, true);
  assert.equal(r.via, "mcp");
  assert.equal(r.blocking, false);
});

test("a repo read plus a PR list on the base branch verifies GitHub with both targets recorded", () => {
  const r = verifyGithub({
    row: table.github,
    scope: { repo: "acme/api", branch: "main" },
    env: { executables: ["gh"], mcpServers: [] },
    runProbe: replayProbe({
      "gh api repos/acme/api": { ok: true, stdout: "{}" },
      "gh pr list --base main --limit 1": { ok: true, stdout: "#1\n" },
    }),
    prList: { mergedCount: 7, windowDays: PR_WINDOW_DAYS },
  });
  assert.equal(r.verified, true);
  assert.equal(r.via, "cli");
  assert.deepEqual(r.targets.map((t) => t.field).sort(), ["baseBranch", "repo"]);
  assert.deepEqual(r.warnings, [], "a healthy window raises nothing");
});

// ---- PR window --------------------------------------------------------------

test("the PR window is a fixed 30-day lookback, independent of any build", () => {
  assert.equal(PR_WINDOW_DAYS, 30);
  const w = prWindowWarning({ mergedCount: 0, windowDays: PR_WINDOW_DAYS, branch: "main" });
  assert.ok(w, "an empty window warns");
  assert.match(w.message, /30/);
  assert.equal(w.code, "empty-pr-window");
});

test("an empty PR window completes setup and persists a warning rather than blocking (AE8)", () => {
  const r = verifyGithub({
    row: table.github,
    scope: { repo: "acme/api", branch: "release-42" },
    env: { executables: ["gh"], mcpServers: [] },
    runProbe: replayProbe({
      "gh api repos/acme/api": { ok: true, stdout: "{}" },
      "gh pr list --base release-42 --limit 1": { ok: true, stdout: "" },
    }),
    prList: { mergedCount: 0, windowDays: PR_WINDOW_DAYS },
  });
  assert.equal(r.verified, true, "the branch is reachable; the window is merely empty");
  assert.equal(r.blocking, false);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, "empty-pr-window");
  assert.equal(r.warnings[0].persist, true, "the warning must survive into the context, not just print");
});

test("merged PRs inside the window raise no warning", () => {
  assert.equal(prWindowWarning({ mergedCount: 3, windowDays: 30, branch: "main" }), null);
});

// ---- access level -----------------------------------------------------------

test("a broader-than-required scope warns alongside a successful verification, not instead of it", () => {
  const r = verifyGithub({
    row: table.github,
    scope: { repo: "acme/api", branch: "main" },
    env: { executables: ["gh"], mcpServers: [] },
    runProbe: replayProbe({
      "gh api repos/acme/api": { ok: true, stdout: "{}", scopes: ["repo", "admin:org", "delete_repo"] },
      "gh pr list --base main --limit 1": { ok: true, stdout: "#1\n" },
    }),
    prList: { mergedCount: 2, windowDays: PR_WINDOW_DAYS },
  });
  assert.equal(r.verified, true, "the warning must not replace the pass");
  assert.equal(r.accessLevel.state, ACCESS_LEVEL.REPORTED);
  const broad = r.warnings.find((w) => w.code === "over-broad-scope");
  assert.ok(broad, "an admin/delete scope on a read-only need is worth saying");
  assert.ok(!JSON.stringify(r).includes(FAKE.githubPat), "and says it without quoting a credential");
});

test("an auth method that reports no scopes yields the not-reportable state, not a false warning", () => {
  // gh via keyring or device flow returns no X-OAuth-Scopes header at all. Treating
  // absence as "narrow" or "broad" would both be inventions.
  const r = verifyGithub({
    row: table.github,
    scope: { repo: "acme/api", branch: "main" },
    env: { executables: ["gh"], mcpServers: [] },
    runProbe: replayProbe({
      "gh api repos/acme/api": { ok: true, stdout: "{}" }, // no `scopes` key
      "gh pr list --base main --limit 1": { ok: true, stdout: "#1\n" },
    }),
    prList: { mergedCount: 2, windowDays: PR_WINDOW_DAYS },
  });
  assert.equal(r.accessLevel.state, ACCESS_LEVEL.NOT_REPORTABLE);
  assert.equal(r.warnings.filter((w) => w.code === "over-broad-scope").length, 0);
});

// ---- typo suggestion in a real failure --------------------------------------

test("a mistyped branch produces a near-match suggestion in its next action", () => {
  const r = verifyGithub({
    row: table.github,
    scope: { repo: "acme/api", branch: "mian" },
    env: { executables: ["gh"], mcpServers: [] },
    runProbe: replayProbe({
      "gh api repos/acme/api": { ok: true, stdout: "{}" },
      "gh pr list --base mian --limit 1": { ok: false, raw: "HTTP 404: Not Found" },
    }),
    candidates: { baseBranch: ["main", "master", "develop"] },
  });
  assert.equal(r.verified, false);
  const failed = r.targets.find((t) => !t.ok);
  assert.match(failed.gap.nextAction, /main/, "the suggestion belongs in the next action");
  assert.equal(failed.gap.suggestion, "main");
});

// ---- gap classification (optional capabilities) -----------------------------

test("gap classification separates a missing tool from invalid team scope", () => {
  assert.equal(
    classifyGap({ errorClass: "not-installed", env: { executables: [] }, row: table.infra }),
    GAP_CLASS.ABSENT_ON_MACHINE,
  );
  assert.equal(
    classifyGap({ errorClass: "not-found", env: { executables: ["kubectl"] }, row: table.infra }),
    GAP_CLASS.SCOPE_INVALID,
  );
});

test("a credential present but under-scoped for the target is its own classification", () => {
  // A teammate with the tool installed and authenticated, but without rights on
  // this target, fits neither of the other two — and both of their prescribed
  // responses would be wrong for them.
  assert.equal(
    classifyGap({ errorClass: "forbidden", env: { executables: ["kubectl"] }, row: table.infra }),
    GAP_CLASS.CREDENTIAL_UNDER_SCOPED,
  );
  assert.equal(
    classifyGap({ errorClass: "unauthorized", env: { executables: ["kubectl"] }, row: table.infra }),
    GAP_CLASS.CREDENTIAL_UNDER_SCOPED,
  );
});

// ---- pasted credential refusal ----------------------------------------------

test("a pasted credential is refused with rotation guidance and never echoed", () => {
  for (const pasted of [
    FAKE.githubPat,
    FAKE.gitlabPat,
    FAKE.awsKeyId,
    FAKE.slackToken,
    FAKE.highEntropy,
  ]) {
    const r = looksLikeSecret(pasted);
    assert.equal(r.secret, true, `${pasted.slice(0, 8)}… must be refused`);
    assert.ok(r.rotationGuidance, "refusal must come with rotation guidance");
    assert.ok(
      !JSON.stringify(r).includes(pasted),
      "the detector must not echo the value it is refusing — it is already in the transcript once",
    );
  }
});

// ---- the two standing guarantees -------------------------------------------

test("no verification result in this suite serializes a secret-shaped string", () => {
  const scenarios = [
    () =>
      verifyGithub({
        row: table.github,
        scope: { repo: "acme/api", branch: "main" },
        env: { executables: ["gh"], mcpServers: [] },
        runProbe: replayProbe({
          "gh api repos/acme/api": {
            ok: false,
            raw: `401 Bad credentials Authorization: Bearer ${FAKE.githubPat}`,
          },
        }),
      }),
    () =>
      verifyCapability({
        capability: "infra",
        row: table.infra,
        targets: [{ field: "namespace", value: "prod" }],
        scope: { namespace: "prod" },
        runProbe: replayProbe({
          "kubectl get pods -n prod --request-timeout=5s": {
            ok: false,
            raw: `error: You must be logged in. token=${FAKE.awsKeyId}`,
          },
        }),
      }),
  ];
  for (const run of scenarios) {
    const serialized = JSON.stringify(run());
    for (const shape of [FAKE.githubPat, FAKE.awsKeyId, "Bearer", "Bad credentials"]) {
      assert.ok(!serialized.includes(shape), `${shape} must not survive into a record`);
    }
  }
});

test("every failure record produced anywhere in this suite has a non-empty next action", () => {
  const r = verifyCapability({
    capability: "logs",
    row: table.logs,
    targets: [{ field: "logIndex", value: "app-logs" }],
    scope: { logIndex: "app-logs", logsMcpTool: "loki/query" },
    runProbe: replayProbe({ "mcp:loki/query": { ok: false, raw: "HTTP 403: forbidden" } }),
  });
  const gaps = r.targets.filter((t) => !t.ok).map((t) => t.gap);
  assert.ok(gaps.length > 0, "fixture must produce a failure, else it proves nothing");
  for (const g of gaps) {
    assert.ok(g.nextAction && g.nextAction.trim().length > 0, `${g.errorClass} has no next action`);
    assert.ok(g.errorClass, "and every gap names its error class");
  }
});
