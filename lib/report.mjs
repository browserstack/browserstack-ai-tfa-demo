// Deterministic markdown report for a finished (or partial) batch. Degrade,
// don't crash: any missing field renders as "not available"; an empty batch
// still renders a valid report. Reads the CSV/WAL spine; no per-test transcripts.

import { readRows } from "./csv-state.mjs";

const NA = "not available";

function cell(value) {
  const s = value == null ? "" : String(value).trim();
  if (s === "") return NA;
  // keep the table one-line-per-row: collapse newlines, escape pipes
  return s.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
}

function countBy(rows, key) {
  return rows.reduce((acc, r) => {
    const k = r[key] || "unknown";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
}

// Render from a rows array (testable) — or pass a csvPath via renderReportFromCsv.
export function renderReport(rows, { buildId, generatedAt } = {}) {
  const lines = [];
  lines.push(`# RCA report${buildId ? ` — build ${buildId}` : ""}`);
  if (generatedAt) lines.push(`\nGenerated: ${generatedAt}`);

  if (!rows || rows.length === 0) {
    lines.push("\nNo failed tests analyzed.");
    return lines.join("\n") + "\n";
  }

  const byState = countBy(rows, "rca_done");
  const summary = Object.entries(byState)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
  lines.push(`\n**${rows.length} test(s)** — ${summary}\n`);

  lines.push(
    "| testRunId | test | status | confidence | coverage | root cause | related PRs |",
  );
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of rows) {
    lines.push(
      `| ${cell(r.testRunId)} | ${cell(r.testName)} | ${cell(r.rca_done)} | ${cell(
        r.confidence,
      )} | ${cell(r.coverage)} | ${cell(r.root_cause)} | ${cell(r.related_prs)} |`,
    );
  }

  // Surface coverage caveats so a "low confidence" reads as "because X unavailable".
  const thin = rows.filter((r) => r.coverage === "thin" || r.coverage === "partial");
  if (thin.length > 0) {
    lines.push(`\n## Coverage caveats`);
    for (const r of thin) {
      lines.push(
        `- ${cell(r.testRunId)} (${cell(r.coverage)} coverage): confidence band reflects evidence that was unavailable, not just model certainty.`,
      );
    }
  }

  return lines.join("\n") + "\n";
}

export function renderReportFromCsv(csvPath, opts = {}) {
  return renderReport(readRows(csvPath), opts);
}
