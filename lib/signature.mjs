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
