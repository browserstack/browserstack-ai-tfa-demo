// Credential fixtures ASSEMBLED at runtime, never written as literals.
//
// A test file full of token-shaped strings trips every secret scanner in CI, and
// this repo's pre-commit gitleaks guard rejects it outright — correctly. The
// runtime values are identical to literals, so detectors are exercised just as
// hard; only the source representation changes.
//
// One home for them, because two copies means the next test file copies whichever
// it finds first, and tightening the guard has to be applied per copy.

const repeatTo = (seed, n) => {
  let s = "";
  for (let i = 0; s.length < n; i++) s += seed[i % seed.length];
  return s.slice(0, n);
};

/** Mixed case + digits: matches [A-Za-z0-9] and trips the high-entropy rule. */
export const mixedBody = (n) => repeatTo("aB3", n);
/** Upper + digits only, for AWS-style key ids. */
export const upperBody = (n) => repeatTo("A1B2", n);
/** Lowercase hex, for a git SHA — deliberately NOT secret-shaped. */
export const hexBody = (n) => repeatTo("9f2b1c", n);

export const FAKE = {
  githubPat: "gh" + "p_" + mixedBody(36),
  githubFine: "github" + "_pat_" + mixedBody(30),
  gitlabPat: "gl" + "pat-" + mixedBody(20),
  awsKeyId: "AK" + "IA" + upperBody(16),
  slackToken: "xo" + "xb-" + mixedBody(30),
  apiKey: "s" + "k-" + mixedBody(32),
  highEntropy: mixedBody(40),
  /** 40 chars of lowercase hex. Long, high-entropy-looking, and legitimate — the
   *  detector must NOT flag it. */
  gitSha: hexBody(40),
};

/**
 * Credentials with NO provider prefix, which clear no entropy bar either.
 *
 * These are the shapes `redact` in lib/tool-cache.mjs catches and
 * `looksLikeSecret` in lib/verify.mjs did not — which made the guard on the
 * git-COMMITTED artifact strictly weaker than the one on a temp file. The URL form
 * was missed by both, and it is exactly what a customer types when asked for a log
 * or metrics endpoint.
 */
export const EMBEDDED = {
  /** `key=value`, no prefix the detector can anchor on. */
  kvToken: "to" + "ken=" + hexBody(32),
  kvApiKey: "api" + "_key=" + hexBody(32),
  /** An auth scheme with a base64 body — `elastic:password`, encoded. */
  basicScheme: "Ba" + "sic " + "ZWxhc3RpYzpwYXNzd29yZA==",
  bearerScheme: "Bea" + "rer " + mixedBody(24),
  /** userinfo in a URL: the shape of an answer to "which log endpoint?". */
  urlUserinfo: "https://" + "elastic:" + "hunter2" + "@logs.acme.internal:9200",
};

/** Values that must NEVER be flagged: real answers the interview collects. */
export const BENIGN = [
  "acme/api", "main", "release/2026-08", "services/billing",
  "app-logs-2026", "prod", "billing-consumer",
  "https://logs.acme.internal:9200",
  FAKE.gitSha,
];
