// Verification policy — validate what the AGENT reports, never decide how to probe.
//
// This module used to build probe commands from templates in
// config/rca.config.json, interpolate customer scope into them, classify provider
// errors with a regex table, and measure edit distance for typo suggestions. All of
// that is gone, for two reasons that turned out to be the same reason:
//
//   * It was not generic. A fingerprint list only knows the vendors someone wrote
//     down, so a New Relic customer was told "Install promtool on this machine".
//   * It was not safe. Because a command string arrived as DATA and had a customer
//     value interpolated into it, the design REQUIRED a command-execution gate, an
//     interpolation guard, an overlay probe restriction and a per-executable probe
//     table — and produced a shell-injection escape, an attached-flag bypass, a
//     write-tool dispatch on the MCP route, and a runtime-bias defect anyway.
//
// The agent knows what `newrelic-cli` is. It knows a Nomad box is not a Kubernetes
// box. It reads a provider error better than seven ordered regexes. So it decides
// HOW to verify, and this module holds the part that must not vary:
//
//   1. A claim needs evidence. A target reported `ok` must name what was checked
//      (`checkedBy`). A claim with no check is recorded `unverified` — NOT verified.
//      This is the structural fix for the defect where `promtool --version`
//      "verified" a metrics namespace it never read.
//   2. Every failure names a next action, because GitHub is the one gate that can
//      stop setup and a diagnostic with no next step is how a customer gets stuck.
//   3. Nothing credential-shaped and no raw provider output reaches the artifact.
//      The committed context has no file-permission backstop, so a leak is
//      effectively permanent.
//   4. GitHub is binary. It is the mandatory capability; "partly verified" is not a
//      state the run can act on.
//
// PURE, and with no probe executor: the agent runs the check and hands back a
// result, which is what makes every case here replayable from a literal.

/** Fixed, build-independent lookback for the base-branch PR sanity check.
 *  Distinct from the run's per-build suspect window, which is derived from
 *  baseline resolution and has nothing to do with setup. */
export const PR_WINDOW_DAYS = 30;

/** The one capability a run cannot proceed without. The table validates that
 *  exactly ONE row carries `mandatory: true`; this names which. */
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
  /** No route on this machine. A local-setup instruction fixes it; re-asking the
   *  team's scope would be wrong. */
  ABSENT_ON_MACHINE: "absent-on-this-machine",
  /** A route exists and is authorised, but the scope the team recorded does not
   *  resolve — a targeted re-ask of that scope is the fix. */
  SCOPE_INVALID: "scope-invalid-for-team",
  /** A route exists and is authenticated, but this credential lacks rights on this
   *  target. Neither other response is correct: re-asking team scope invites one
   *  person to rewrite it to fit their credential, and a local-setup instruction
   *  names a tool they already have. */
  CREDENTIAL_UNDER_SCOPED: "credential-under-scoped-for-target",
};

/** A target the agent could reach but could not prove. Distinct from a failure:
 *  nothing is wrong, we simply have no evidence, and saying "verified" would be a
 *  claim we cannot support. The gate prints it; the run treats it as unproven. */
export const UNVERIFIED = "unverified";

const GAP_CLASSES = new Set(Object.values(GAP_CLASS));

// ---- secret detection -------------------------------------------------------
//
// `redact` in lib/tool-cache.mjs is the wrong tool for this and it is worth being
// precise about why. Its patterns require a key prefix (`token=`) or an auth scheme
// (`Bearer `), and it returns redacted TEXT rather than a verdict. A bare pasted
// PAT matches neither, so it comes back byte-identical and any detector built on
// `redact(v) !== v` reports "clean" for exactly the input that matters most.
//
// The property that matters is "never weaker than redact", asserted directly
// against redact's real output in tests/tool-cache.test.mjs. A 2160-case fuzz found
// no counterexample, and deleting any one SECRET_SHAPES entry fails that test.

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

/** Credential shapes with no provider prefix that clear no entropy bar. Each is
 *  unanchored: a credential is no less a credential for having text in front of it.
 *  The url-userinfo pattern was `^`-anchored and therefore missed
 *  `LOKI_URL=https://u:p@host` — an inconsistency, not a decision. */
const SECRET_SHAPES = [
  [/(?:^|[\s"'(<=,])[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/i, "url-embedded-password"],
  [/(?:token|api[_-]?key|secret|password|passwd|access[_-]?key|authorization)"?\s*[=:]\s*"?\S{4,}/i, "embedded-credential"],
  [/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i, "auth-scheme-credential"],
];

const ROTATION_GUIDANCE =
  "This value was refused and not stored, but it is already in this session's transcript — " +
  "revoke and reissue it, then re-run setup and reference it by environment-variable NAME instead.";

/**
 * Does `value` look like a credential?
 *
 * Never echoes what it refuses — the value is in the transcript once already, and
 * repeating it into a record doubles the exposure.
 *
 * The entropy fallback applies ONLY to a whitespace-free value. Applied to prose it
 * flagged this library's own output: `prWindowWarning`'s message always tripped it
 * (>=32 chars, mixed case, contains "30"), as did
 * `"'prod-2' was not found. Check the value and re-run setup."` — so
 * `writeRcaContext` refused every context carrying a gap or a warning and told the
 * customer to rotate a credential that never existed. A sentence is not a secret;
 * a token inside a sentence still is, which is why each whitespace-separated word
 * is checked against the prefix and shape tables too.
 */
export function looksLikeSecret(value) {
  const v = String(value ?? "").trim();
  if (!v) return { secret: false };

  const hit = (kind) => ({ secret: true, kind, rotationGuidance: ROTATION_GUIDANCE });

  for (const [pattern, kind] of SECRET_SHAPES) {
    if (pattern.test(v)) return hit(kind);
  }

  // Whole value, then each word — so a bare PAT is caught whether it arrives alone
  // or embedded in a sentence.
  for (const candidate of [v, ...v.split(/\s+/)]) {
    for (const [pattern, kind] of SECRET_PREFIXES) {
      if (pattern.test(candidate)) return hit(kind);
    }
  }

  // Shape fallback, single tokens only. All three character classes are required so
  // a 40-character lowercase-hex git SHA stays out of the net.
  if (!/\s/.test(v) && v.length >= 32 && /[a-z]/.test(v) && /[A-Z]/.test(v) && /[0-9]/.test(v)) {
    return hit("high-entropy");
  }

  return { secret: false };
}

// ---- PR window --------------------------------------------------------------

/**
 * Warn when the base branch has no merged PRs in the lookback.
 *
 * Non-blocking on purpose: the branch is reachable, the window is merely empty. But
 * it predicts a dead culprit hunt, so it persists rather than printing once.
 */
export function prWindowWarning({ mergedCount, windowDays = PR_WINDOW_DAYS, branch } = {}) {
  if (Number(mergedCount) > 0) return null;
  return {
    code: "empty-pr-window",
    persist: true,
    windowDays,
    branch: branch ?? null,
    message:
      `No pull requests merged into '${branch}' in the last ${windowDays} days — culprit-PR ` +
      `attribution has nothing to search. Expected on a quiet or long-cadence branch; ` +
      `worth checking if this branch should be busy.`,
  };
}

// ---- over-broad credential scopes -------------------------------------------

/**
 * Scopes that exceed a read-only need badly enough to say out loud.
 *
 * GitHub OAuth vocabulary, and applied ONLY to GitHub. It was applied to every
 * capability's accessLevel, which meant a log or metrics provider's unrelated scope
 * strings were measured against `write:org`.
 */
const GITHUB_OVER_BROAD = [/^admin(:|$)/i, /^delete/i, /^write:org$/i, /(^|:)write$/i];

export function overBroadWarning(capability, scopes = []) {
  if (capability !== MANDATORY_CAPABILITY) return null;
  const broad = (scopes ?? []).filter((s) => GITHUB_OVER_BROAD.some((p) => p.test(String(s))));
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

// ---- the result contract ----------------------------------------------------

/** Keys that carry raw provider output. Present in a reported result, they would be
 *  persisted verbatim into a committed file. The agent reduces a failure to a class
 *  and a next action; the bytes stay in its own context. */
const RAW_OUTPUT_KEYS = new Set(["raw", "stdout", "stderr", "body", "response", "output"]);

function scanStrings(node, path, visit) {
  if (typeof node === "string") return visit(path, node);
  if (Array.isArray(node)) {
    node.forEach((v, i) => scanStrings(v, `${path}[${i}]`, visit));
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      scanStrings(v, path ? `${path}.${k}` : k, visit);
    }
  }
}

function rawOutputPaths(node, path = "", found = []) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => rawOutputPaths(v, `${path}[${i}]`, found));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      const p = path ? `${path}.${k}` : k;
      if (RAW_OUTPUT_KEYS.has(k)) found.push(p);
      else rawOutputPaths(v, p, found);
    }
  }
  return found;
}

/**
 * Validate and normalise one capability's reported verification.
 *
 * `result` is whatever the agent reports after doing the check its own way:
 *
 *   { verified, via, targets: [{field, value, ok, checkedBy?, gap?}],
 *     scopes?, warnings? }
 *
 * Returns `{ result, violations }`. The returned result is NORMALISED, which is
 * where the policy bites: a target claiming `ok` without naming a `checkedBy` is
 * rewritten to `unverified`, and a capability is `verified` only if at least one
 * target was actually checked. Violations describe what the agent got wrong so it
 * can be told, rather than silently corrected.
 */
export function validateVerification({ capability, row = {}, result = {} } = {}) {
  const violations = [];
  const declared = new Set(Object.keys(row?.scopeFields ?? {}));

  for (const p of rawOutputPaths(result)) {
    violations.push({
      code: "raw-output-in-result",
      field: p,
      message:
        `'${p}' carries raw provider output. Reduce a failure to a gap class and a next ` +
        `action — the bytes must not reach a committed file.`,
    });
  }

  scanStrings(result, "", (path, value) => {
    if (looksLikeSecret(value).secret) {
      violations.push({
        code: "secret-in-result",
        field: path || "(root)",
        message: `'${path || "(root)"}' looks like a credential. ${ROTATION_GUIDANCE}`,
      });
    }
  });

  const targets = Array.isArray(result.targets) ? result.targets : [];
  if (!Array.isArray(result.targets)) {
    violations.push({
      code: "targets-missing",
      message: `capability '${capability}' reported no targets array; a verification with no target proves nothing`,
    });
  }

  const normalizedTargets = targets.map((t, i) => {
    const at = `targets[${i}]`;
    if (t?.field !== undefined && declared.size > 0 && !declared.has(t.field)) {
      violations.push({
        code: "undeclared-target-field",
        field: `${at}.field`,
        message:
          `'${t.field}' is not a scope field the '${capability}' row declares ` +
          `(${[...declared].join(", ") || "none"}). The table is the field list.`,
      });
    }

    // A claim needs evidence. This is the rule that makes a wrong probe choice
    // unrepresentable rather than merely unlikely: without naming what was checked,
    // "ok" carries no information, so it is not accepted as one.
    if (t?.ok === true && !String(t?.checkedBy ?? "").trim()) {
      violations.push({
        code: "unsupported-claim",
        field: `${at}.checkedBy`,
        message:
          `'${t?.field}' is reported verified but names no check. Report what you ran ` +
          `(a command, an MCP tool, an API call) or report it as ${UNVERIFIED}.`,
      });
      return { ...t, ok: false, state: UNVERIFIED };
    }

    if (t?.ok === true) return { ...t, state: "verified" };

    // A failure must be actionable, and its class must be one the gate knows how to
    // respond to — the three classes prescribe opposite responses, so an unknown
    // one cannot be routed.
    const gap = t?.gap ?? null;
    if (t?.state === UNVERIFIED) return { ...t, ok: false, state: UNVERIFIED };

    if (!gap) {
      violations.push({
        code: "failure-without-gap",
        field: `${at}.gap`,
        message: `'${t?.field}' failed with no gap record, so nothing can be reported to the customer`,
      });
    } else {
      if (!GAP_CLASSES.has(gap.class)) {
        violations.push({
          code: "bad-gap-class",
          field: `${at}.gap.class`,
          message:
            `'${gap.class}' is not a gap class. One of: ${[...GAP_CLASSES].join(" | ")} — ` +
            `they prescribe opposite responses, so the gate cannot route an unknown one.`,
        });
      }
      if (!String(gap.nextAction ?? "").trim()) {
        violations.push({
          code: "gap-without-next-action",
          field: `${at}.gap.nextAction`,
          message: `the gap for '${t?.field}' names no next action; a diagnostic with no next step strands the customer`,
        });
      }
    }
    return { ...t, ok: false, state: "failed" };
  });

  const checked = normalizedTargets.filter((t) => t.state === "verified");
  const verified = checked.length > 0;

  if (result.verified === true && !verified) {
    violations.push({
      code: "verified-without-a-checked-target",
      message:
        `capability '${capability}' reports verified, but no target names a check. ` +
        `Reachability is not verification.`,
    });
  }

  const via = String(result.via ?? "").trim();
  if (verified && !via) {
    violations.push({
      code: "via-missing",
      message: `capability '${capability}' is verified but does not say through what — record the tool or server used`,
    });
  }

  const scopes = Array.isArray(result.scopes) ? result.scopes : null;
  const accessLevel = scopes && scopes.length > 0
    ? { state: ACCESS_LEVEL.REPORTED, scopes }
    : { state: ACCESS_LEVEL.NOT_REPORTABLE };

  const broad = overBroadWarning(capability, scopes ?? []);
  const warnings = [...(Array.isArray(result.warnings) ? result.warnings : []), ...(broad ? [broad] : [])];

  return {
    result: {
      capability,
      verified,
      via: via || null,
      targets: normalizedTargets,
      accessLevel,
      warnings,
    },
    violations,
  };
}

/**
 * The mandatory-capability gate.
 *
 * GitHub is binary and this is the only place that says so. Without the code
 * changes and the PRs merged into the branch under test there is no culprit PR to
 * name, which is the entire output — so a partially-verified GitHub is not a state
 * the run can act on.
 */
export function githubGate(validated) {
  if (validated?.capability !== MANDATORY_CAPABILITY) return { blocking: false };
  if (validated.verified === true) return { blocking: false };

  const failed = (validated.targets ?? []).find((t) => t.state === "failed" && t.gap);
  const unproven = (validated.targets ?? []).find((t) => t.state === UNVERIFIED);

  const detail = failed
    ? `${failed.field} '${failed.value}': ${failed.gap.nextAction}`
    : unproven
      ? `${unproven.field} could not be proven — report what you checked, or say why you could not.`
      : "its scope is unresolved — I have neither a repository nor a base branch to verify.";

  return {
    blocking: true,
    message: `GitHub is mandatory and I cannot move ahead without it: ${detail}`,
    nextAction: failed?.gap?.nextAction ?? "Answer the GitHub repository and base branch, then re-run setup.",
  };
}
