// Terse end-of-run glimpse — the ONLY in-client output of a /factory run.
// One line per test: testRunId → cluster → status → confidence one-liner.
// The full RCA report lives on the Test Observability UI (triggerRcaReport →
// viewReport link); this is deliberately a glimpse, never a report. Degrade,
// don't crash: missing fields render as "-".

import { readRows } from "./csv-state.mjs";

const DASH = "-";
const ONE_LINER_MAX = 80;

function cell(value) {
  const s = value == null ? "" : String(value).trim();
  if (s === "") return DASH;
  return s.replace(/\s*\n\s*/g, " ");
}

function oneLiner(row) {
  const confidence = cell(row.confidence);
  const cause = cell(row.root_cause);
  const text = cause === DASH ? confidence : `${confidence}: ${cause}`;
  return text.length > ONE_LINER_MAX ? `${text.slice(0, ONE_LINER_MAX - 1)}…` : text;
}

// Render the glimpse from CSV rows. Returns a plain-text block:
//   <testRunId> → <cluster_id> → <status> → <confidence one-liner>
export function renderGlimpse(rows, { buildId } = {}) {
  const lines = [`Glimpse${buildId ? ` — build ${buildId}` : ""}`];
  if (!rows || rows.length === 0) {
    lines.push("No failed tests analyzed.");
    return lines.join("\n") + "\n";
  }
  const byState = rows.reduce((acc, r) => {
    const k = r.rca_done || "unknown";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(byState)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
  lines.push(`${rows.length} test(s) — ${summary}`);
  for (const r of rows) {
    lines.push(
      `${cell(r.testRunId)} → ${cell(r.cluster_id)} → ${cell(r.rca_done)} → ${oneLiner(r)}`,
    );
  }
  return lines.join("\n") + "\n";
}

export function renderGlimpseFromCsv(csvPath, opts = {}) {
  return renderGlimpse(readRows(csvPath), opts);
}
