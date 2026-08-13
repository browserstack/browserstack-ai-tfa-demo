// Code-enforced PR validation gate (Fix A).
//
// Every coordinator's `related_prs` exits through `loop.mjs` `out()`, which
// calls `validateAndDeduplicatePRs` here to cross-check each claimed PR
// against the evidence file's ground truth. A PR that fails validation is
// downgraded to `verdict: "ruled-out (<reason>)"` — never silently dropped.

/**
 * Extract owner/repo from a PR entry's link or url field.
 * Handles GitHub PR URLs like "https://github.com/owner/repo/pull/123".
 */
function extractOwnerRepo(entry) {
  const raw = entry?.link || entry?.url || "";
  const m = String(raw).match(/github\.com\/([^/]+\/[^/]+)\/pull\//);
  return m ? m[1] : null;
}

/**
 * Build the lookup key for a PR: "owner/repo" string.
 * Prefers explicit owner+repo fields; falls back to parsing link/url.
 */
function resolveRepo(entry) {
  if (entry?.owner && entry?.repo) return `${entry.owner}/${entry.repo}`;
  return extractOwnerRepo(entry);
}

/**
 * Validate a single suspect PR entry against the evidence file.
 *
 * @param {object} entry - PR entry with owner, repo, number, merged_at, link/url
 * @param {object} evidenceDoc - folded evidence file from readEvidenceFile
 * @returns {{valid: boolean, reason?: "not-in-evidence" | "shipped-after"}}
 */
export function validateSuspectPR(entry, evidenceDoc) {
  const repoKey = resolveRepo(entry);
  if (!repoKey) return { valid: false, reason: "not-in-evidence" };

  const repoEvidence = evidenceDoc?.github?.[repoKey];
  const prsInWindow = repoEvidence?.prsInWindow ?? [];

  const num = entry?.number ?? entry?.pr;
  if (num == null) return { valid: false, reason: "not-in-evidence" };

  const normalise = (n) => String(n).replace(/^#/, "");
  const match = prsInWindow.find(
    (p) => normalise(p.pr) === normalise(num),
  );
  if (!match) return { valid: false, reason: "not-in-evidence" };

  // Merge-window check: merged_at must not be after the build's started_at.
  const startedAt = evidenceDoc?.suspectWindow?.startedAt;
  if (startedAt) {
    const mergedMs = Date.parse(entry.merged_at ?? match.mergedAt ?? "");
    const startedMs = Date.parse(startedAt);
    if (!Number.isNaN(mergedMs) && !Number.isNaN(startedMs) && mergedMs > startedMs) {
      return { valid: false, reason: "shipped-after" };
    }
  } else if (startedAt === undefined || startedAt === null) {
    // Cannot falsify on window — log but allow.
    console.warn(`[pr-validation] suspectWindow.startedAt absent — skipping merge-window check`);
  }

  return { valid: true };
}

/**
 * Deduplicate and validate an array of suspect PR entries against the evidence file.
 *
 * - Deduplicates by (owner, repo, number).
 * - Enriches each entry with ground-truth fields from the evidence file.
 * - Valid entries keep their existing verdict.
 * - Invalid entries are downgraded to `verdict: "ruled-out (<reason>)"`.
 * - All entries (valid + ruled-out) are returned — nothing is silently dropped.
 *
 * @param {Array} relatedPrs - the TFA agent's claimed suspect PRs
 * @param {object} evidenceDoc - folded evidence file from readEvidenceFile
 * @returns {Array} deduplicated, validated PR entries
 */
export function validateAndDeduplicatePRs(relatedPrs, evidenceDoc) {
  if (!Array.isArray(relatedPrs) || relatedPrs.length === 0) return [];

  // Deduplicate by (repo, number).
  const seen = new Map();
  for (const entry of relatedPrs) {
    const repoKey = resolveRepo(entry);
    const num = entry?.number ?? entry?.pr;
    const dedup = repoKey && num != null
      ? `${repoKey}#${String(num).replace(/^#/, "")}`
      : `anon-${seen.size}`;
    if (!seen.has(dedup)) seen.set(dedup, entry);
  }

  const results = [];
  for (const entry of seen.values()) {
    const repoKey = resolveRepo(entry);
    const num = entry?.number ?? entry?.pr;

    // Enrich from evidence ground truth when possible.
    const normalise = (n) => String(n).replace(/^#/, "");
    const repoEvidence = repoKey ? evidenceDoc?.github?.[repoKey] : null;
    const groundTruth = (repoEvidence?.prsInWindow ?? []).find(
      (p) => num != null && normalise(p.pr) === normalise(num),
    );

    // Build the output entry: ground-truth fields override LLM transcription.
    const enriched = groundTruth
      ? { ...entry, ...Object.fromEntries(Object.entries(groundTruth).filter(([, v]) => v != null)) }
      : { ...entry };

    const { valid, reason } = validateSuspectPR(entry, evidenceDoc);
    if (!valid) {
      enriched.verdict = `ruled-out (${reason})`;
      console.warn(`[pr-validation] PR ${repoKey ?? "?"}#${num ?? "?"} downgraded: ${reason}`);
    }
    // Valid entries keep their existing verdict (typically "supported").

    results.push(enriched);
  }

  return results;
}
