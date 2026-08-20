// Cluster helpers: pick a stable representative for a server-computed failure
// theme, and build the pre-seed a sibling needs from its representative's
// already-landed CSV row. Dependency-free + deterministic (no crypto, no clock,
// no random) so it is usable from the workflow sandbox and trivially testable.
//
// Clustering comes from the server (lib/theme-clustering.mjs +
// getBuildFailureThemes); when the server returns no themes, every failed test
// is its own representative (a singleton).

// A stable representative for a cluster: prefer a non-flaky member (a flaky test
// is a poor exemplar), then the smallest testRunId. Deterministic.
export function selectRepresentative(members) {
  return [...members].sort((a, b) => {
    const aFlaky = a.is_flaky === "true" || a.is_flaky === true ? 1 : 0;
    const bFlaky = b.is_flaky === "true" || b.is_flaky === true ? 1 : 0;
    if (aFlaky !== bFlaky) return aFlaky - bFlaky;
    return Number(a.testRunId) - Number(b.testRunId);
  })[0];
}

/**
 * Build the `pre_seed` a cluster sibling needs, from its representative's
 * already-landed CSV row. Returns `{ok:false, reason}` if the representative
 * is not terminal yet — meaning the sibling MUST NOT be dispatched.
 *
 * Siblings are only cheap because they confirm a hypothesis someone else
 * already established. Dispatch one without that hypothesis and "one-turn
 * confirm" degenerates into a full independent investigation — with the
 * sibling framing on top, so it costs MORE than the representative it was
 * meant to be a fraction of. Measured on a real run: siblings averaged 22.7
 * tool calls and 2.2 turns against 8.0 and 2.0 for the representative, and
 * one burned 60 calls over 17 minutes. Nothing in the fan-out ordered them
 * after their rep, and nothing refused to dispatch without a seed, so the
 * degradation was silent.
 *
 * Fan-out contract: for each cluster, dispatch the representative, WAIT for it
 * to land terminal, then dispatch its siblings with this seed. Clusters are
 * independent, so they still run concurrently with each other.
 */
export function siblingPreSeed(csvPath, csvState, clusterId, representativeId) {
  const rows = csvState.readRows(csvPath);
  const rep = rows.find((r) => String(r.testRunId) === String(representativeId));
  if (!rep) return { ok: false, reason: `representative ${representativeId} not in the CSV` };

  const state = String(rep.rca_done ?? "").toLowerCase();
  if (state !== "resolved") {
    return {
      ok: false,
      reason: `representative ${representativeId} is "${rep.rca_done || "pending"}", not resolved — dispatching siblings now would make each one re-investigate from scratch`,
    };
  }
  if (!String(rep.root_cause ?? "").trim()) {
    return { ok: false, reason: `representative ${representativeId} resolved but recorded no root_cause — nothing for a sibling to confirm` };
  }

  return {
    ok: true,
    clusterId,
    representativeId: String(representativeId),
    pre_seed: {
      cause: rep.root_cause,
      failure_type: rep.failure_type || "",
      related_prs: rep.related_prs || "",
      confidence: rep.confidence || "",
      // Stated so the sibling confirms against ITS OWN evidence rather than
      // adopting the verdict — the independence rule in Operating Principle 0.
      instruction:
        "Confirm or refute this against YOUR OWN test's evidence in one turn. Do not adopt it because it is written here.",
    },
  };
}
