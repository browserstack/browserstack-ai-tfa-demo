// Policy that must not vary, and nothing else.
//
// This file used to also VALIDATE the agent's verification report — normalise its
// targets, scan for raw output, check gap classes. That is gone: re-checking a
// report the agent just wrote is bookkeeping the agent can do from the same table
// it read, and the one rule that looked structural (`checkedBy` must be present)
// turned out to be a presence check that `checkedBy: "promtool --version"` — the
// literal historical defect — satisfied. It read as enforcement and was not.
//
// What stays is the two things a run genuinely cannot be trusted to redo per-run:
//
//   1. `looksLikeSecret` — the ONLY control on a git-committed artifact, where a
//      miss is effectively permanent. Deterministic on purpose, and asserted to be
//      never weaker than the redactor guarding the temp files.
//   2. `githubGate` — the single invariant that can stop a run. It fails CLOSED and
//      requires COVERAGE of the declared scope, because "partly verified" is not a
//      state the culprit-PR hunt can act on.
//
// Everything else here is a warning generator or an enum the agent routes on.

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

  // Whole value, then each word. The per-word pass is what catches a credential
  // that arrives with anything beside it, and BOTH tests run on each word.
  //
  // Restricting the entropy test to whitespace-free VALUES — which is what the
  // fix for the prose false-positives did — meant a prefix-less token was missed
  // the moment a word sat next to it: `export INSTANA_TOKEN <40 chars>` came back
  // clean. That covers every provider whose keys carry no recognisable prefix
  // (Grafana, Instana, New Relic, Dynatrace, Loki), i.e. exactly the capabilities
  // this design opened up, and this guard is the ONLY control on a git-committed
  // file. Per-word is the correct scope: a sentence is not a secret, but no WORD
  // of ordinary prose is 32+ chars with all three character classes.
  const words = v.split(/\s+/);

  // Prefix tests apply to the whole value AND to each word: a bare PAT is a PAT
  // wherever it sits.
  for (const candidate of [v, ...words]) {
    for (const [pattern, kind] of SECRET_PREFIXES) {
      if (pattern.test(candidate)) return hit(kind);
    }
  }

  // Entropy applies to WORDS ONLY, never to the whole value. Both directions of
  // that boundary were live defects:
  //   * on the whole value it flagged this library's own prose — every
  //     prWindowWarning message and every gap next action clears 32 chars with
  //     three character classes — so writeRcaContext refused any context carrying
  //     a gap and told the customer to rotate a credential that never existed.
  //   * skipped entirely whenever the value contained whitespace, it missed
  //     `export INSTANA_TOKEN <40 chars>` — and a prefix-less provider key
  //     (Grafana, Instana, New Relic, Dynatrace, Loki) is exactly what the
  //     non-GitHub capabilities collect.
  // Per word is the only scope that is right: a sentence is not a secret, and no
  // WORD of ordinary prose is 32+ chars with all three classes.
  for (const w of words) {
    if (w.length >= 32 && /[a-z]/.test(w) && /[A-Z]/.test(w) && /[0-9]/.test(w)) {
      // All three classes required, so a 40-char lowercase-hex git SHA stays out.
      return hit("high-entropy");
    }
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
/** Did this target actually prove anything? A target claiming `ok` must name what
 *  was checked. The rule lives HERE rather than in a general validator, because
 *  this gate is the only place it changes an outcome — and a general validator that
 *  merely recorded a violation was mistaken for enforcement. */
const isProven = (t) => t?.ok === true && String(t?.checkedBy ?? "").trim().length > 0;

/**
 * The mandatory-capability gate — the ONE blocking invariant in the whole run.
 *
 * Reads the report the agent writes: `{verified, targets:[{field, value, ok,
 * checkedBy, gap:{class, nextAction}}]}`. Nothing normalises it first.
 *
 * GitHub is binary. Without the code and the merged PRs there is no culprit PR,
 * which is the run's entire output — so "partly verified" is not a state anything
 * downstream can act on.
 */
export function githubGate(report, row = null) {
  // Fails CLOSED. Every non-match used to return {blocking:false}, so
  // githubGate(undefined), githubGate({}) and a differently-cased capability all
  // waved the run past. A gate whose default is "proceed" is not a gate.
  // Case-folded: `capability: "GitHub"` is a plausible thing for an agent to write,
  // and an exact compare sent it down the not-mandatory path — skipping the one gate
  // that can stop the run, on a typo, silently.
  const cap = String(report?.capability ?? "").trim().toLowerCase();
  if (!cap) {
    return {
      blocking: true,
      message: "GitHub is mandatory and I cannot move ahead without it: nothing was reported for it.",
      nextAction: "Verify GitHub — a repository readable AND its base branch's merged-PR list — then continue.",
    };
  }
  if (cap !== MANDATORY_CAPABILITY.toLowerCase()) return { blocking: false };

  const targets = Array.isArray(report.targets) ? report.targets : [];
  const fallback = "Answer the GitHub repository and base branch, then verify them.";

  // COVERAGE, not existence. A repo that verified while the base branch FAILED
  // used to pass, sending the run to its single deliverable — the culprit-PR hunt
  // over that branch — with the branch proven unreachable and nothing said.
  const declared = Object.keys(row?.scopeFields ?? {});
  const proven = new Set(targets.filter(isProven).map((t) => t.field));
  const uncovered = declared.filter((f) => !proven.has(f));

  if (declared.length > 0 && uncovered.length === 0) return { blocking: false };
  if (declared.length === 0 && proven.size > 0) return { blocking: false };

  // A target claiming ok WITHOUT naming a check is the interesting failure: it
  // reads like success and proves nothing, so say exactly that rather than
  // reporting the field as merely missing.
  const unproven = targets.find((t) => t.ok === true && !isProven(t));
  const failed = targets.find((t) => t.ok !== true && t.gap);

  const detail = unproven
    ? `${unproven.field} is reported ok but names no check — say what you ran, or report it as ${UNVERIFIED}.`
    : failed
      ? `${failed.field} '${failed.value ?? "(no value)"}': ${failed.gap.nextAction || fallback}`
      : uncovered.length > 0 && declared.length > 0
        ? `${uncovered.join(", ")} ${uncovered.length === 1 ? "was" : "were"} not verified.`
        : "its scope is unresolved — I have neither a repository nor a base branch to verify.";

  return {
    blocking: true,
    message: `GitHub is mandatory and I cannot move ahead without it: ${detail}`,
    nextAction: failed?.gap?.nextAction || fallback,
  };
}
