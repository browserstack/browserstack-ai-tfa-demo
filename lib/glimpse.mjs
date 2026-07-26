// Terse end-of-run summary — the ONLY in-client output of a /rca-build run.
// Deliberately a COMPLETION NOTICE, not a report: status counts + the UI link,
// nothing else. Root causes, culprit PRs, per-test analysis, cluster breakdowns
// live ONLY on the Test Observability dashboard (triggerRcaReport → viewReport).
// Do not reintroduce per-test cause/PR lines here — that is the whole point of
// the trim. Degrade, don't crash: missing fields are treated as absent.

import { readRows } from "./csv-state.mjs";

// Map raw CSV rca_done states → the three buckets a human cares about.
function bucket(state) {
  const s = (state || "").toLowerCase();
  if (s === "resolved") return "resolved";
  if (s === "pending" || s === "pending-resume") return "pending";
  return "failed";
}

// Render the completion summary. Returns a plain-text block:
//   RCA analysis complete — build <id>
//   <N> tests · <R> resolved · <P> pending · <F> failed
// (the caller appends the "Full report on the Test Observability UI: <link>"
//  line from triggerRcaReport's viewReport — see SKILL.md Step 6).
export function renderGlimpse(rows, { buildId } = {}) {
  const head = `RCA analysis complete${buildId ? ` — build ${buildId}` : ""}`;
  if (!rows || rows.length === 0) {
    return `${head}\nNo failed tests analyzed.\n`;
  }
  const counts = rows.reduce(
    (acc, r) => {
      acc[bucket(r.rca_done)] += 1;
      return acc;
    },
    { resolved: 0, pending: 0, failed: 0 },
  );
  const parts = [`${rows.length} test(s)`, `${counts.resolved} resolved`];
  if (counts.pending) parts.push(`${counts.pending} pending`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  return `${head}\n${parts.join(" · ")}\n`;
}

export function renderGlimpseFromCsv(csvPath, opts = {}) {
  return renderGlimpse(readRows(csvPath), opts);
}
