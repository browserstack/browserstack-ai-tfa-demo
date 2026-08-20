// Build-level evidence cache (ideation #2). "Diff since last green", "deploy
// timeline", "PRs in the suspect window" are properties of the BUILD, not the
// test — yet a naive loop re-fetches them per test. Compute once, cache by
// (repo, commit-range, evidenceType), and pre-seed every coordinator with the
// same grounded suspect window. Collapses N×M redundant git/infra calls to ~M.
//
// The cache is created fresh per run (function-scoped Map — never a module-level
// global), so it holds no cross-run/cross-user state: in-workspace, single
// session, multi-tenant-safe by construction.

export function resolveBaseline(lastGreenRef, fallbackRef) {
  if (lastGreenRef) return { ref: lastGreenRef, isFallback: false };
  return { ref: fallbackRef ?? null, isFallback: true };
}
