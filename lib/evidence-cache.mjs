// Build-level evidence cache (ideation #2). "Diff since last green", "deploy
// timeline", "PRs in the suspect window" are properties of the BUILD, not the
// test — yet a naive loop re-fetches them per test. Compute once, cache by
// (repo, commit-range, evidenceType), and pre-seed every coordinator with the
// same grounded suspect window. Collapses N×M redundant git/infra calls to ~M.
//
// The cache is created fresh per run (function-scoped Map — never a module-level
// global), so it holds no cross-run/cross-user state: in-workspace, single
// session, multi-tenant-safe by construction.

export function makeEvidenceCache() {
  const store = new Map();
  const keyOf = (repo, range, evidenceType) =>
    `${repo ?? ""}@@${range ?? ""}@@${evidenceType ?? ""}`;

  return {
    has(repo, range, evidenceType) {
      return store.has(keyOf(repo, range, evidenceType));
    },
    get(repo, range, evidenceType) {
      return store.get(keyOf(repo, range, evidenceType));
    },
    set(repo, range, evidenceType, value) {
      store.set(keyOf(repo, range, evidenceType), value);
      return value;
    },
    // Compute-once: run `fn` only on a cache miss; reuse on every later call.
    async compute(repo, range, evidenceType, fn) {
      const k = keyOf(repo, range, evidenceType);
      if (store.has(k)) return store.get(k);
      const value = await fn();
      store.set(k, value);
      return value;
    },
    size() {
      return store.size;
    },
  };
}

// Resolve the baseline ref for the last-green→this-build delta. When there is no
// "last green" (e.g. a never-green flaky suite) fall back to a configured ref and
// flag it so the report can note the weaker grounding.
export function resolveBaseline(lastGreenRef, fallbackRef) {
  if (lastGreenRef) return { ref: lastGreenRef, isFallback: false };
  return { ref: fallbackRef ?? null, isFallback: true };
}
