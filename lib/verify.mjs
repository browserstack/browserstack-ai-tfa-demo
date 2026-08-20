// Verification (R12-R18, R24) — prove each capability with a live read against its
// RESOLVED scope, and produce failure records a customer can act on.
//
// Two guarantees carry the weight here:
//
//   1. No record this module produces may contain a secret-shaped string. Raw
//      provider output is reduced to an error CLASS and the raw text is dropped —
//      never merely redacted-then-kept, because the committed context has no
//      file-permission backstop and a leak there is effectively permanent.
//   2. Every failure record names a next action. GitHub is the one gate that can
//      stop setup outright, so a diagnostic with no next step is how a customer
//      gets stuck at it.
//
// PURE. Probes are dispatched through an injected executor: only the agent can
// invoke an MCP tool, so `verify` never calls one — it receives the result through
// the same shape a CLI probe returns. That is also what makes every case in
// tests/verify.test.mjs replayable.

import { fillPlaceholders, interpolate, matchRow } from "./discovery.mjs";

/** Fixed, build-independent lookback for the base-branch PR sanity check.
 *  Distinct from the run's per-build suspect window, which is derived from
 *  baseline resolution and has nothing to do with setup. */
export const PR_WINDOW_DAYS = 30;

/** The one capability a run cannot proceed without.
 *
 * The table validates that exactly ONE row carries `mandatory: true`, but the
 * identity of that row was hard-coded in three places (a function name here, and
 * two `verified.github` literals in rca-context). Naming it once means flipping it
 * is one edit rather than a hunt. */
export const MANDATORY_CAPABILITY = "github";

export const ACCESS_LEVEL = {
  /** The provider told us the granted scopes. */
  REPORTED: "reported",
  /** The auth method returns no scope information at all — keyring, device flow,
   *  or an MCP server that does not surface it. Treating absence as "narrow" or
   *  "broad" would both be inventions, so it gets its own state. */
  NOT_REPORTABLE: "not-reportable",
};

export const GAP_CLASS = {
  /** The tool or server is not on this machine. A local-setup instruction fixes
   *  it; re-asking the team's scope would be wrong. */
  ABSENT_ON_MACHINE: "absent-on-this-machine",
  /** The tool is here and authorised, but the scope the team recorded does not
   *  resolve — a targeted re-ask of that scope is the fix. */
  SCOPE_INVALID: "scope-invalid-for-team",
  /** The tool is here and authenticated, but this credential lacks rights on this
   *  target. Neither of the other two responses is correct: re-asking team scope
   *  invites one person to rewrite it to fit their credential, and a
   *  local-setup instruction names a tool they already have. */
  CREDENTIAL_UNDER_SCOPED: "credential-under-scoped-for-target",
};

// ---- secret detection -------------------------------------------------------
//
// `redact` in lib/tool-cache.mjs is the wrong tool for this and it is worth being
// precise about why. Its patterns require a key prefix (`token=`) or an auth scheme
// (`Bearer `), and it returns redacted TEXT rather than a verdict. A bare pasted
// PAT matches neither pattern, so it comes back byte-identical and any detector
// built on `redact(v) !== v` reports "clean" for exactly the input that matters
// most. Verified in tests/verify.test.mjs rather than asserted here.

const SECRET_PREFIXES = [
  [/^gh[pousr]_[A-Za-z0-9]{16,}$/, "github-pat"],
  [/^github_pat_[A-Za-z0-9_]{20,}$/, "github-pat"],
  [/^glpat-[A-Za-z0-9\-_]{16,}$/, "gitlab-pat"],
  [/^AKIA[0-9A-Z]{12,}$/, "aws-access-key-id"],
  [/^ASIA[0-9A-Z]{12,}$/, "aws-access-key-id"],
  [/^xox[baprs]-[A-Za-z0-9\-]{10,}$/, "slack-token"],
  [/^sk-[A-Za-z0-9\-_]{20,}$/, "api-key"],
  [/^AIza[A-Za-z0-9\-_]{30,}$/, "api-key"],
];

const ROTATION_GUIDANCE =
  "This value was refused and not stored, but it is already in this session's transcript — " +
  "revoke and reissue it, then re-run setup and reference it by environment-variable NAME instead.";

/**
 * Does `value` look like a credential?
 *
 * Deliberately never echoes the value it is refusing — it is already in the
 * transcript once, and repeating it into a record or a log doubles the exposure.
 */
/**
 * Credential shapes that carry no provider prefix and clear no entropy bar.
 *
 * These exist because this guard was measurably WEAKER than `redact` in
 * lib/tool-cache.mjs, which protects a temp file — while this one protects a
 * git-committed artifact. `redact` caught `token=<hex>` and `Basic <base64>`;
 * looksLikeSecret returned {secret:false} for both, because neither carries a
 * recognised prefix and neither satisfies the three-character-class entropy
 * fallback. A URL with userinfo (`https://user:pass@host`) was missed by both,
 * and it is the exact shape of a logs- or metrics-endpoint answer.
 *
 * Deliberately restated here rather than imported: the property that matters is
 * "never weaker than redact", and tests/verify.test.mjs asserts THAT directly
 * against redact's real output. A shared regex would couple two guards with
 * different jobs while proving less.
 */
const SECRET_SHAPES = [
  [/^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/i, "url-embedded-password"],
  [/(?:token|api[_-]?key|secret|password|passwd|access[_-]?key|authorization)"?\s*[=:]\s*"?\S{4,}/i, "embedded-credential"],
  [/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i, "auth-scheme-credential"],
];

export function looksLikeSecret(value) {
  const v = String(value ?? "").trim();
  if (!v) return { secret: false };

  for (const [pattern, kind] of SECRET_PREFIXES) {
    if (pattern.test(v)) return { secret: true, kind, rotationGuidance: ROTATION_GUIDANCE };
  }

  for (const [pattern, kind] of SECRET_SHAPES) {
    if (pattern.test(v)) return { secret: true, kind, rotationGuidance: ROTATION_GUIDANCE };
  }

  // No recognisable prefix: fall back to shape. Requiring all three character
  // classes is what keeps a 40-character lowercase-hex git SHA out of the net —
  // long, high-entropy-looking, and completely legitimate in this context.
  if (v.length >= 32 && /[a-z]/.test(v) && /[A-Z]/.test(v) && /[0-9]/.test(v)) {
    return { secret: true, kind: "high-entropy", rotationGuidance: ROTATION_GUIDANCE };
  }

  return { secret: false };
}

// ---- failure classification -------------------------------------------------

const ERROR_CLASSES = [
  [/command not found|not found: |no such file or directory/i, "not-installed"],
  [/auth login|not logged in|must be logged in|authentication required/i, "not-authenticated"],
  [/\b401\b|bad credentials|invalid token/i, "unauthorized"],
  [/\b403\b|forbidden|not accessible by|insufficient|permission denied/i, "forbidden"],
  [/\b404\b|not found/i, "not-found"],
  [/dial tcp|no such host|timeout|timed out|connection refused|network is unreachable/i, "network"],
];

/**
 * Reduce raw provider output to an error class, dropping the raw text.
 *
 * The output is not redacted-and-kept — it is replaced. A redacted string still
 * carries whatever the redactor's patterns missed, and this value is bound for a
 * record that may be committed.
 */
export function scrubFailure(raw) {
  const text = String(raw ?? "");
  for (const [pattern, cls] of ERROR_CLASSES) {
    if (pattern.test(text)) return cls;
  }
  return "unknown";
}

const NEXT_ACTIONS = {
  "not-installed": (ctx) => `Install ${ctx.tool ?? "the required tool"} on this machine, then re-run setup.`,
  "not-authenticated": (ctx) =>
    `Authenticate ${ctx.tool ?? "the tool"}${ctx.envVar ? ` (or export ${ctx.envVar})` : ""}, then re-run setup.`,
  unauthorized: (ctx) =>
    `The credential${ctx.envVar ? ` in ${ctx.envVar}` : ""} was rejected — reissue it and re-run setup.`,
  forbidden: (ctx) =>
    `The credential${ctx.envVar ? ` in ${ctx.envVar}` : ""} is valid but lacks read access to ` +
    `'${ctx.value}'. Grant read access, or correct the value if it belongs to another team.`,
  "not-found": (ctx) =>
    `'${ctx.value}' was not found.` + (ctx.suggestion ? ` Did you mean '${ctx.suggestion}'?` : " Check the value and re-run setup."),
  network: () => "The host was unreachable — check connectivity or proxy configuration, then re-run setup.",
  unknown: (ctx) => `Could not verify '${ctx.value}'. Re-run setup with the value corrected.`,
};

/** Every entry is a template literal with mandatory literal text, so this cannot
 *  return empty — the "every failure names a next action" guarantee is structural
 *  rather than guarded. tests/verify.test.mjs asserts it on real records. */
function nextActionFor(errorClass, ctx) {
  return (NEXT_ACTIONS[errorClass] ?? NEXT_ACTIONS.unknown)(ctx);
}

// ---- near-match suggestions -------------------------------------------------

/** Optimal string alignment distance — Levenshtein plus adjacent transposition,
 *  because `mian` for `main` is the single most common real typo and plain
 *  Levenshtein scores it 2, far enough to be rejected as "not close". */
function distance(a, b) {
  const s = String(a ?? "");
  const t = String(b ?? "");
  // The accept threshold is 2, so a length gap above it cannot win — skip the
  // matrix allocation entirely.
  if (Math.abs(s.length - t.length) > 2) return Infinity;
  const d = Array.from({ length: s.length + 1 }, (_, i) =>
    Array.from({ length: t.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[s.length][t.length];
}

/**
 * The closest candidate to `value`, or null when nothing is close enough.
 *
 * Returning null matters as much as returning a match: a confidently wrong
 * suggestion sends a customer to correct a value that was already right.
 */
export function nearMatch(value, candidates = []) {
  const v = String(value ?? "");
  if (!v || candidates.length === 0) return null;
  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const dist = distance(v, c);
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  if (bestDist === 0) return null; // identical: nothing to suggest
  if (bestDist > 2 || bestDist >= v.length) return null;
  return best;
}

// ---- PR window --------------------------------------------------------------

/**
 * Warn when the base branch has no merged PRs in the lookback.
 *
 * Non-blocking on purpose: the branch is reachable, the window is merely empty.
 * But it predicts a dead culprit hunt, so it persists into the context rather
 * than printing once at the gate and vanishing.
 */
export function prWindowWarning({ mergedCount, windowDays = PR_WINDOW_DAYS, branch } = {}) {
  if (Number(mergedCount) > 0) return null;
  return {
    code: "empty-pr-window",
    persist: true,
    windowDays,
    message:
      `No pull requests merged into '${branch}' in the last ${windowDays} days — culprit-PR ` +
      `attribution has nothing to search. Expected on a quiet or long-cadence branch; ` +
      `worth checking if this branch should be busy.`,
  };
}

// ---- gap classification -----------------------------------------------------

/** Route this env offers for this row, or null. Delegates to discovery's matchRow
 *  so detection and verification cannot disagree about the same machine — they
 *  previously used different containment directions, so an MCP server could be
 *  "discovered" and then refused as absent. */
function routeFor(row, env) {
  const m = matchRow(row, {
    executables: env?.executables ?? [],
    mcpServers: env?.mcpServers ?? [],
    repoFiles: [],
  });
  if (!m) return null;
  return { kind: m.evidence.kind === "mcp" ? "mcp" : "cli", via: m.via };
}

const toolPresent = (row, env) => routeFor(row, env) !== null;

/**
 * Which of the three gap kinds this failure is.
 *
 * The distinction exists because the three need opposite responses, and collapsing
 * them is what makes degradation silent: a team-level data problem and a
 * five-second local install look identical in a report otherwise.
 */
export function classifyGap({ errorClass, env, row } = {}) {
  if (errorClass === "not-installed") return GAP_CLASS.ABSENT_ON_MACHINE;
  if (!toolPresent(row, env)) return GAP_CLASS.ABSENT_ON_MACHINE;
  if (["forbidden", "unauthorized", "not-authenticated"].includes(errorClass)) {
    return GAP_CLASS.CREDENTIAL_UNDER_SCOPED;
  }
  return GAP_CLASS.SCOPE_INVALID;
}

// ---- probe dispatch ---------------------------------------------------------

/** Replay seam: probe results keyed by command, or by `mcp:<tool>`. The library
 *  owns it (rather than the test file) so every caller shares one contract. */
export function replayProbe(results = {}) {
  return (request) => {
    const key = request?.kind === "mcp" ? `mcp:${request.tool}` : request?.command;
    if (!(key in results)) {
      return { ok: false, raw: `no recorded probe result for ${key}`, missing: true };
    }
    return results[key];
  };
}

/** The `{placeholder}` names a template mentions. */
function placeholdersIn(template) {
  return [...String(template ?? "").matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
}

/**
 * Pick the template that actually mentions this field, so a scope target probes
 * its own scope rather than re-running the capability's base probe.
 *
 * `probesByExecutable` is consulted first, keyed by the executable the route
 * matched. Without it `infra` — which fingerprints kubectl, docker, aws, nomad and
 * pm2 — ran `kubectl get pods` on every one of them, so a Nomad or ECS machine got
 * a kubectl command, failed, and had the failure recorded as ITS scope being
 * invalid. One probe cannot serve five runtimes.
 */
function templateFor(row, field, route = null) {
  const byExe = row?.probesByExecutable;
  const via = route?.kind === "cli" ? route.via : null;
  if (byExe && via && typeof byExe[via] === "object" && byExe[via] !== null) {
    const scoped = byExe[via].scopeProbe;
    if (typeof scoped === "string" && scoped.includes(`{${field}}`)) return scoped;
    if (typeof byExe[via].probe === "string") return byExe[via].probe;
  }
  const scoped = row?.scopeProbe;
  if (typeof scoped === "string" && scoped.includes(`{${field}}`)) return scoped;
  return typeof row?.probe === "string" ? row.probe : null;
}

function runOne({ row, field, value, scope, runProbe, envVar, env, candidates, route = null }) {
  const merged = { ...scope, [field]: value };
  const leaders = row?.fingerprints?.executables ?? [];

  // One builder for every failure exit. Four hand-written copies had already
  // drifted — `suggestion` existed on one of them only — and the "every failure
  // names a next action" guarantee was enforced along two different paths.
  const fail = (errorClass, extra = {}) => ({
    field,
    value,
    ok: false,
    gap: {
      errorClass,
      envVar: envVar ?? null,
      gapClass: classifyGap({ errorClass, env, row }),
      nextAction: nextActionFor(errorClass, { value, envVar, tool: leaders[0], ...extra }),
      ...extra,
    },
  });

  // The route decides the probe FORM. Picking a CLI template on the MCP route was
  // a real bug: a customer with no `gh` had a `gh` command built for them and was
  // refused for the wrong reason. `route` is the {kind, via} object routeFor()
  // returns — passing only its `kind` threw away the `via` the MCP form needs.
  // No route at all means nothing on this machine can answer. Defaulting to "cli"
  // here built a command for a tool that is not installed and ran it, then reported
  // gapClass absent-on-this-machine while the next action told the customer to
  // correct their value — two halves of one record disagreeing about whose problem
  // it is.
  if (route === null) return fail("not-installed");

  const kind = route.kind;
  const template = kind === "mcp" && row?.mcpProbe ? null : templateFor(row, field, route);

  let request;
  if (template) {
    const filled = interpolate(template, merged, { leaders });
    if (!filled.ok) return fail("unknown", { reason: filled.reason });
    request = { kind: "cli", command: filled.command };
  } else if (row?.mcpProbe) {
    // The MCP tool name comes from the ROUTE, not from a question. `mcpProbe.tool`
    // is a template like `{githubMcpTool}`, and that placeholder is not a declared
    // scopeField in any row — so discovery could never ask for it, no skill file
    // mentioned it, and the only honest answer the verifier could give was "answer
    // it during setup", a question the interview is forbidden to ask. The result
    // was a hard block on a machine that HAD a GitHub MCP server. Discovery
    // already matched that server and reported it as `via`; that is the answer.
    const mcpScope = { ...merged };
    for (const ph of placeholdersIn(row.mcpProbe.tool)) {
      if (mcpScope[ph] === undefined && route?.via) mcpScope[ph] = route.via;
    }

    // A tool NAME is not a shell command, so only placeholder resolution applies —
    // `interpolate` would also run it through the probe gate and always refuse it.
    const { text: toolName, missing } = fillPlaceholders(String(row.mcpProbe.tool ?? ""), mcpScope);
    if (missing.length > 0) {
      return fail("unknown", {
        nextAction:
          `No MCP server was matched for this capability, so its tool name (${missing.join(", ")}) ` +
          `cannot be resolved. Connect the MCP server, or install the CLI, then re-run setup.`,
      });
    }

    // args were dispatched with their placeholders INTACT: `{"repo": "{repo}"}`
    // reached the provider literally, which either 404s (and blames the customer's
    // correct value) or is ignored by the tool and returns success — verifying
    // nothing while reporting verified:true.
    const args = {};
    const argMissing = [];
    for (const [k, v] of Object.entries(row.mcpProbe.args ?? {})) {
      if (typeof v !== "string") { args[k] = v; continue; }
      const filled = fillPlaceholders(v, mcpScope);
      if (filled.missing.length > 0) argMissing.push(...filled.missing);
      args[k] = filled.text;
    }
    if (argMissing.length > 0) {
      return fail("unknown", {
        nextAction:
          `The MCP probe for this capability needs ${[...new Set(argMissing)].join(", ")}, ` +
          `which setup has not resolved yet.`,
      });
    }
    request = { kind: "mcp", tool: toolName, args };
  } else {
    return fail("not-installed");
  }

  const result = runProbe(request);
  if (result?.ok) {
    return { field, value, ok: true, via: request.kind, scopes: result.scopes ?? null };
  }

  // The raw text stops here. Only the class travels.
  const errorClass = scrubFailure(result?.raw);
  const suggestion = nearMatch(value, candidates?.[field] ?? []);
  return {
    ...fail(errorClass, suggestion ? { suggestion } : {}),
    via: request.kind,
  };
}

/** Scopes that exceed a read-only need badly enough to be worth saying out loud. */
const OVER_BROAD = [/^admin(:|$)/i, /^delete/i, /^write:org$/i, /(^|:)write$/i];

/** accessLevel plus any warnings derived from it. Was duplicated verbatim between
 *  verifyCapability and verifyGithub, so a second warning kind would have had to be
 *  added in two places. */
function summarize(results) {
  const accessLevel = accessLevelFrom(results);
  const broad = overBroadWarning(accessLevel);
  return { accessLevel, warnings: broad ? [broad] : [] };
}

function accessLevelFrom(targets) {
  const withScopes = targets.find((t) => Array.isArray(t.scopes) && t.scopes.length > 0);
  if (!withScopes) return { state: ACCESS_LEVEL.NOT_REPORTABLE };
  return { state: ACCESS_LEVEL.REPORTED, scopes: withScopes.scopes };
}

function overBroadWarning(accessLevel) {
  if (accessLevel.state !== ACCESS_LEVEL.REPORTED) return null;
  const broad = (accessLevel.scopes ?? []).filter((s) => OVER_BROAD.some((p) => p.test(s)));
  if (broad.length === 0) return null;
  return {
    code: "over-broad-scope",
    persist: true,
    scopes: broad,
    message:
      `The credential grants ${broad.join(", ")} where only read access is needed. ` +
      `Narrowing it reduces blast radius if the variable is ever compromised.`,
  };
}

/**
 * Verify one capability against its resolved targets.
 *
 * Per-target, not per-tool: a capability valid for one repo and 404 on another
 * stays valid for the target that passed, and the failure is a scoped gap. The
 * alternative — one failure disabling the whole capability — is what makes a
 * coordinator degrade to "unavailable" over a single bad value.
 */
export function verifyCapability({
  capability,
  row,
  targets = [],
  scope = {},
  runProbe,
  envVar = null,
  env = {},
  candidates = {},
} = {}) {
  // routeFor() was computed nowhere on this path, so `route` defaulted to "cli"
  // for every capability and runOne's route-aware form selection was dead code —
  // an MCP-only machine had a CLI command built for it.
  const route = routeFor(row, env);
  const results = targets.map((t) =>
    runOne({ row, field: t.field, value: t.value, scope, runProbe, envVar, env, candidates, route }),
  );
  const { accessLevel, warnings } = summarize(results);

  return {
    capability,
    verified: results.some((r) => r.ok),
    via: results.find((r) => r.ok)?.via ?? results[0]?.via ?? null,
    targets: results,
    accessLevel,
    warnings,
  };
}

/**
 * Verify GitHub, which is binary: `gh` or a GitHub MCP server, or setup stops.
 *
 * There is no degraded-completion class here. Every other capability may end as a
 * recorded gap; this one cannot, because the culprit-PR link is the product and a
 * run without it is not worth shipping.
 */
export function verifyGithub({
  row,
  scope = {},
  env = {},
  runProbe,
  prList = null,
  candidates = {},
  envVar = "GH_TOKEN",
} = {}) {
  const resolved = routeFor(row, env);

  if (!resolved) {
    return {
      verified: false,
      blocking: true,
      via: null,
      targets: [],
      warnings: [],
      accessLevel: { state: ACCESS_LEVEL.NOT_REPORTABLE },
      message:
        "GitHub is mandatory and I cannot move ahead without it. Without the code changes and " +
        "the PRs merged into the branch under test, there is no culprit PR to name.",
      nextAction:
        `Install and authenticate the \`gh\` CLI, or connect a GitHub MCP server, then re-run setup. ` +
        `(A credential may also be supplied as ${envVar}.)`,
    };
  }

  // The repo read is the capability probe; the base-branch PR list is its scope
  // probe. Both must pass — a reachable repo whose branch has no PR list cannot
  // support the merge-window search the culprit hunt depends on.
  // Accept BOTH vocabularies. The capability table declares `repos` (a list) and
  // `baseBranch`; the persisted context stores those same names. Reading only
  // `scope.repo`/`scope.branch` meant a caller handing over the real table or
  // context shape produced ZERO targets — and an empty target list made `verified`
  // false with `failed` undefined, so the customer-facing refusal read literally
  // "undefined 'undefined' failed as undefined".
  const repo = scope.repo ?? (Array.isArray(scope.repos) ? scope.repos[0] : scope.repos);
  const branch = scope.branch ?? scope.baseBranch;

  const targets = [];
  if (repo !== undefined && repo !== null) targets.push({ field: "repo", value: repo });
  if (branch !== undefined && branch !== null) targets.push({ field: "baseBranch", value: branch });

  if (targets.length === 0) {
    return {
      verified: false,
      blocking: true,
      via: resolved.kind,
      targets: [],
      warnings: [],
      accessLevel: { state: ACCESS_LEVEL.NOT_REPORTABLE },
      message:
        "GitHub is mandatory and I cannot move ahead without it: its scope is unresolved — " +
        "I have neither a repository nor a base branch to verify.",
      nextAction: "Answer the GitHub repository and base branch, then re-run setup.",
    };
  }

  const route = resolved;
  const hasSuppliedPrList = prList !== null && Number.isFinite(Number(prList?.mergedCount));

  const results = targets.map((t) => {
    // On the MCP route there is no command string for a branch PR list, and only
    // the agent can invoke an MCP tool — so the agent runs it and hands the count
    // in. `prList` IS the base-branch evidence there, not an optional extra.
    if (route.kind === "mcp" && t.field === "baseBranch") {
      if (hasSuppliedPrList) return { field: t.field, value: t.value, ok: true, via: "mcp" };
      const errorClass = "unknown";
      return {
        field: t.field,
        value: t.value,
        ok: false,
        via: "mcp",
        gap: {
          errorClass,
          envVar,
          gapClass: classifyGap({ errorClass, env, row }),
          nextAction:
            `On the MCP route the base-branch PR list must be supplied by the caller — ` +
            `run the PR-list tool for '${t.value}' and pass the merged count.`,
        },
      };
    }
    // The table declares its scope probe against {branch}; the target field is
    // named baseBranch for the digest, so map it back for interpolation.
    const field = t.field === "baseBranch" ? "branch" : t.field;
    const r = runOne({
      row,
      field,
      value: t.value,
      scope,
      runProbe,
      envVar,
      env,
      route,
      candidates: { ...candidates, branch: candidates.baseBranch ?? candidates.branch ?? [] },
    });
    return { ...r, field: t.field };
  });

  const { accessLevel, warnings } = summarize(results);

  const verified = results.length > 0 && results.every((r) => r.ok);

  if (verified && prList) {
    const w = prWindowWarning({
      mergedCount: prList.mergedCount,
      windowDays: prList.windowDays ?? PR_WINDOW_DAYS,
      branch: scope.branch,
    });
    if (w) warnings.push(w);
  }

  const failed = results.find((r) => !r.ok);
  return {
    verified,
    blocking: !verified,
    via: route.kind,
    targets: results,
    accessLevel,
    warnings,
    ...(verified
      ? {}
      : {
          message:
            `GitHub is mandatory and I cannot move ahead without it: ` +
            `${failed?.field} '${failed?.value}' failed as ${failed?.gap?.errorClass}.`,
          nextAction: failed?.gap?.nextAction ?? "Correct the GitHub scope and re-run setup.",
        }),
  };
}
