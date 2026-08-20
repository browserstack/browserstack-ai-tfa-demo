// Failure-signature clustering (ideation #1). A red build's N failures usually
// trace to a handful of causes; clustering collapses the expensive evidence hunt
// to O(distinct causes). The signature is computed from the trimmed failure
// detail U1 surfaces on each listTestIds row (category + first error line + file
// path) — no extra probe turns.
//
// Dependency-free + deterministic (no crypto, no clock, no random) so it is
// usable from the auto-mode workflow sandbox and trivially testable.

// Normalize a string for signature comparison: lowercase and fold the volatile
// tokens that make two instances of the SAME failure look different (ids,
// timestamps, hex/uuids, line:col, bare numbers).
export function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}\S*/g, "<ts>") // ISO timestamps
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/0x[0-9a-f]+/g, "<hex>") // memory addresses
    .replace(/:\d+(:\d+)?\b/g, ":<line>") // file:line(:col)
    .replace(/\d+/g, "<n>") // remaining numbers (incl. unit-suffixed, e.g. 3000ms)
    .replace(/\s+/g, " ")
    .trim();
}

// The signature triple: normalized category | error summary | file path.
export function computeSignature(row) {
  const category = normalize(row.failure_category);
  const error = normalize(row.error_summary);
  const file = normalize(row.file_path);
  const sig = `${category}|${error}|${file}`;
  return sig.replace(/\|/g, "").trim().length === 0 ? "" : sig;
}

// Deterministic short id for a signature string (FNV-1a → base36).
function hashId(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

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

// Cluster rows by signature. Mutates each row's `cluster_id`. Rows with no
// signal (empty signature) become their own singleton (never merged into a
// catch-all). Returns { rows, clusters } where each cluster carries its
// representative + siblings.
export function clusterRows(rows) {
  const groups = new Map();

  for (const row of rows) {
    const sig = computeSignature(row);
    const id = sig === "" ? `solo-${row.testRunId}` : `c-${hashId(sig)}`;
    row.cluster_id = id;
    if (!groups.has(id)) groups.set(id, { cluster_id: id, signature: sig, members: [] });
    groups.get(id).members.push(row);
  }

  const clusters = [];
  for (const group of groups.values()) {
    const representative = selectRepresentative(group.members);
    const siblings = group.members.filter((m) => m !== representative);
    clusters.push({ ...group, representative, siblings });
  }

  return { rows, clusters };
}

/**
 * Seed-free, persist-safe clustering: read the CSV, assign `cluster_id`, and
 * WRITE IT BACK. Returns the cluster objects.
 *
 * `clusterRows` mutates its input and returns `{rows, clusters}`, so a caller
 * that destructures only `clusters` gets working cluster objects while every
 * `cluster_id` is silently discarded — the CSV keeps empty cluster columns and
 * the run degrades to one coordinator per test, losing the entire
 * representative/sibling collapse. That is not a hypothetical: it happened on
 * a real run (12 tests → 26 subagents, 30 minutes), and again to a second
 * caller the same day. Two independent callers making the same mistake is an
 * API problem, not a user problem.
 *
 * Prefer this over calling `clusterRows` directly whenever the rows came from
 * a CSV. It cannot forget to persist.
 */
export function clusterAndPersist(csvPath, csvState) {
  const { readRows, writeRows } = csvState;
  const rows = readRows(csvPath);
  const { clusters } = clusterRows(rows);
  writeRows(csvPath, rows);
  const persisted = readRows(csvPath).filter((r) => r.cluster_id).length;
  if (rows.length && persisted !== rows.length) {
    throw new Error(
      `[signature] clustering wrote ${persisted}/${rows.length} cluster_id values — refusing to continue with a partially clustered CSV`,
    );
  }
  return clusters;
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
