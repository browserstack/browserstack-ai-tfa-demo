// Cluster bookkeeping. The AGENT decides which failures share a cause; this file
// only makes the decision stick.
//
// It used to do the clustering: normalise a failure signature with a regex chain
// (fold timestamps, uuids, hex, line numbers, bare digits), join category | error |
// file, hash it, and group by EXACT match. That is a weak algorithm dressed as a
// deterministic one — "Timeout waiting for element" and "element not visible after
// 30s" are one cause and two strings, and no amount of regex folding closes that
// gap. The codebase already conceded the point: it prefers the server's semantic
// themes and called this the fallback.
//
// So the grouping is the agent's, and what stays here is the two things that are
// NOT judgement, both of which exist because they failed in production:
//
//   * the persistence guarantee — `clusterRows` mutated rows and returned
//     `{rows, clusters}`, so a caller destructuring only `clusters` silently
//     discarded every `cluster_id`. The CSV kept empty cluster columns and the run
//     degraded to one coordinator per test: 12 tests became 26 subagents over 30
//     minutes, twice in one day, by two independent callers. Two callers making the
//     same mistake is an API problem.
//   * a DETERMINISTIC representative — the CSV persists `cluster_id` but not which
//     member was the exemplar, so a resumed run that picks differently re-runs the
//     expensive investigation it already paid for.
//
// Dependency-free, no clock, no random — so it is usable from the workflow sandbox.

/**
 * A stable exemplar: prefer a non-flaky member (a flaky test is a poor exemplar),
 * then the smallest testRunId. Deterministic, which is the point — see above.
 *
 * NOTE the flakiness half is inert for clusters built from the CSV: `is_flaky` is
 * not in csv-state's COLUMNS, and writeRows emits exactly those, so a seeded row
 * never carries it and both sides compare 0. The effective rule there is
 * smallest-testRunId, which is what actually delivers the determinism this exists
 * for. The branch is kept because it is correct whenever a caller passes rows that
 * DO carry flakiness (a listTestIds payload does). Adding the column would make it
 * live, but `readRows` throws on a foreign header, so it would break resume for
 * any build already in flight — not a change to make incidentally.
 *
 * `Number()` of a non-numeric id is NaN and a NaN comparator makes sort order
 * implementation-defined, so ids are compared numerically only when both parse.
 */
export function selectRepresentative(members) {
  return [...members].sort((a, b) => {
    const aFlaky = a.is_flaky === "true" || a.is_flaky === true ? 1 : 0;
    const bFlaky = b.is_flaky === "true" || b.is_flaky === true ? 1 : 0;
    if (aFlaky !== bFlaky) return aFlaky - bFlaky;
    const na = Number(a.testRunId);
    const nb = Number(b.testRunId);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a.testRunId).localeCompare(String(b.testRunId));
  })[0];
}

/**
 * Persist the agent's clustering and return the cluster objects fan-out needs.
 *
 * `assignment` is `{testRunId: clusterId}` — one entry per row, from whatever the
 * agent judged: the server's failure themes, its own reading of the signatures, or
 * both. Ids are the agent's to choose; only stability within the run matters.
 *
 * Every row must be assigned. A row left out would silently become its own
 * investigation, which is the same degradation the discarded-`cluster_id` bug
 * caused — so this refuses rather than half-clustering. A test genuinely unlike any
 * other gets its own singleton id, which is a decision, not an omission.
 *
 * Returns `[{cluster_id, members, representative, siblings}]`.
 */
export function persistClusters(csvPath, csvState, assignment = {}) {
  const { readRows, writeRows } = csvState;
  const rows = readRows(csvPath);

  // readRows returns [] for a missing file, so without this a wrong buildId or
  // stateDir wrote a header-only CSV, skipped the read-back guard (`rows.length &&`)
  // and returned [] as SUCCESS — "no clusters" plus a stray state file, which is
  // the degenerate form of the omission this function exists to refuse.
  if (rows.length === 0) {
    throw new Error(
      `[clusters] no rows at ${csvPath} — nothing to cluster. Check the buildId and stateDir ` +
        `before assuming this build had no failures.`,
    );
  }

  const missing = rows.filter((r) => !String(assignment[r.testRunId] ?? "").trim());
  if (missing.length > 0) {
    throw new Error(
      `[clusters] ${missing.length} of ${rows.length} rows have no cluster assigned ` +
        `(${missing.slice(0, 5).map((r) => r.testRunId).join(", ")}${missing.length > 5 ? ", …" : ""}). ` +
        `Assign every row — a singleton is a decision, an omission is a silent per-test fan-out.`,
    );
  }

  for (const row of rows) row.cluster_id = String(assignment[row.testRunId]).trim();
  writeRows(csvPath, rows);

  // Read back rather than trust the write. This is the check that would have caught
  // the discarded-cluster_id bug the first time, instead of the second.
  const persisted = readRows(csvPath);
  const unpersisted = persisted.filter((r) => !r.cluster_id).length;
  if (rows.length && unpersisted > 0) {
    throw new Error(
      `[clusters] wrote ${rows.length - unpersisted}/${rows.length} cluster_id values — ` +
        `refusing to continue with a partially clustered CSV`,
    );
  }

  const groups = new Map();
  for (const row of persisted) {
    if (!groups.has(row.cluster_id)) groups.set(row.cluster_id, []);
    groups.get(row.cluster_id).push(row);
  }

  return [...groups.entries()].map(([cluster_id, members]) => {
    const representative = selectRepresentative(members);
    return { cluster_id, members, representative, siblings: members.filter((m) => m !== representative) };
  });
}

/**
 * Build the `pre_seed` a cluster sibling needs, from its representative's
 * already-landed CSV row. Returns `{ok:false, reason}` when the representative is
 * not terminal yet — meaning the sibling MUST NOT be dispatched.
 *
 * Siblings are only cheap because they confirm a hypothesis someone else already
 * established. Dispatch one without that hypothesis and "one-turn confirm"
 * degenerates into a full independent investigation — with the sibling framing on
 * top, so it costs MORE than the representative it was meant to be a fraction of.
 * Measured on a real run: siblings averaged 22.7 tool calls and 2.2 turns against
 * 8.0 and 2.0 for the representative, and one burned 60 calls over 17 minutes.
 * Nothing ordered them after their rep and nothing refused to dispatch without a
 * seed, so the degradation was silent.
 *
 * Fan-out contract: per cluster, dispatch the representative, WAIT for it to land
 * terminal, then dispatch its siblings with this seed. Clusters are independent, so
 * they still run concurrently with each other.
 */
export function siblingPreSeed(csvPath, csvState, clusterId, representativeId) {
  const rows = csvState.readRows(csvPath);
  const rep = rows.find((r) => String(r.testRunId) === String(representativeId));
  if (!rep) return { ok: false, reason: `representative ${representativeId} not in the CSV` };

  const state = String(rep.rca_done ?? "").toLowerCase();
  if (state !== "resolved") {
    return {
      ok: false,
      reason:
        `representative ${representativeId} is "${rep.rca_done || "pending"}", not resolved — ` +
        `dispatching siblings now would make each one re-investigate from scratch`,
    };
  }
  if (!String(rep.root_cause ?? "").trim()) {
    return {
      ok: false,
      reason: `representative ${representativeId} resolved but recorded no root_cause — nothing for a sibling to confirm`,
    };
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
