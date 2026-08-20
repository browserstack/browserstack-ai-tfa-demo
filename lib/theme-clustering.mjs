// Server-computed failure-theme clustering (`buildThemes`/`flat` via the
// getBuildFailureThemes/listTestsInFailureTheme MCP tools) — the clustering
// path (skills/rca-build/SKILL.md Step 3). When the server returns no themes,
// pass an empty `buildThemes` and every failed test falls through to its own
// singleton cluster (i.e. all tests become representatives).
//
// Pure + dependency-free: takes already-fetched plain data in, returns
// { rows, clusters }, so downstream code (the fan-out workflow, the sequential
// harness) is agnostic to how many themes the server produced.

import { selectRepresentative } from "./signature.mjs";

// Build { rows, clusters } from a getBuildFailureThemes result (`ready: true`)
// plus a per-theme map of already-fetched member rows (keyed by
// buildFailureThemeId, each entry the array listTestsInFailureTheme returned
// for that theme, already paginated to completion). `rows` is the full
// listTestIds row set — used to enrich each theme member with the row's own
// testName/error_summary and to catch any failed test the server didn't
// assign to a theme: never silently dropped, it becomes its own singleton.
// Mutates each row's `cluster_id` (the caller persists via writeRows).
//
// Themes are expected to be disjoint (a test belongs to at most one), but
// this isn't a guarantee the server's contract documents — so a row already
// claimed by an earlier theme is skipped (first-theme-wins) rather than
// letting it land in two clusters with conflicting `cluster_id` values.
export function clustersFromThemes(rows, themesResult, testsByThemeId) {
  const rowById = new Map(rows.map((r) => [String(r.testRunId), r]));
  const covered = new Set();
  const clusters = [];

  for (const theme of themesResult.buildThemes ?? []) {
    const themeRows = (testsByThemeId[theme.buildFailureThemeId] ?? [])
      .map((t) => rowById.get(String(t.testRunId)))
      .filter((r) => r && !covered.has(String(r.testRunId)));

    if (themeRows.length === 0) continue;

    const id = `theme-${theme.buildFailureThemeId}`;
    themeRows.forEach((r) => {
      r.cluster_id = id;
      covered.add(String(r.testRunId));
    });

    const representative = selectRepresentative(themeRows);
    const siblings = themeRows.filter((m) => m !== representative);
    clusters.push({
      cluster_id: id,
      signature: theme.themeData?.name ?? "",
      members: themeRows,
      representative,
      siblings,
    });
  }

  for (const row of rows) {
    if (covered.has(String(row.testRunId))) continue;
    const id = `solo-${row.testRunId}`;
    row.cluster_id = id;
    clusters.push({
      cluster_id: id,
      signature: "",
      members: [row],
      representative: row,
      siblings: [],
    });
  }

  return { rows, clusters };
}
