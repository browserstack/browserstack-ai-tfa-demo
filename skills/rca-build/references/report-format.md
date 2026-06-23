# Report format, coverage stamp, and resume

## The CSV is the source of truth

Every per-test result lives as one CSV row (`lib/csv-state.mjs`, columns in
`COLUMNS`). The report is a deterministic render of that CSV — no per-test
transcripts are kept. `rca_done` ∈ `pending | resolved | blocked | failed |
pending-resume`.

## Coverage stamp (ideation #6, v1)

At flip time the orchestrator stamps each row (`lib/coverage.mjs`) from the
coordinator's `asks_fulfilled` / `asks_unavailable` + TFA's confidence:

- **coverage** — `full` (no gaps) · `partial` (some fulfilled, some unavailable) ·
  `thin` (nothing fulfilled, only gaps).
- **band** — TFA's confidence **capped by coverage**: `full` keeps it, `partial`
  caps at `medium`, `thin` caps at `low`; unknown floors to `low`.

So a RESOLVED with kibana/k8s unavailable reads as a lower band *because* evidence
was missing — not the same as a fully-evidenced RESOLVED. The report's **Coverage
caveats** section spells this out per affected row.

> Out of v1 scope: the build-level **blast-radius digest** (rows inverted by
> culprit PR, ranked) — deferred to follow-up. The per-row coverage stamp ships now.

## Report layout (`lib/report.mjs` → `renderReport`)

- Header + build id + generated-at.
- One-line summary: total + counts by `rca_done`.
- A per-test table: `testRunId | test | status | confidence | coverage | root cause | related PRs`.
- A **Coverage caveats** list for `partial`/`thin` rows.

**Degrade, don't crash:** any missing field renders as `not available`; an empty
batch renders "No failed tests analyzed."; pipes are escaped and newlines
collapsed so the table never breaks.

## Resume (ideation #7)

On startup the orchestrator runs the **reaper** (`lib/csv-state.mjs` → `reaper`):
rows stuck `in_flight` with a heartbeat older than `reaperHeartbeatTtlSec` are
reclaimed to `pending` (a crashed worker's rows), then fan-out re-points at the
CSV. A row that retains a live `threadId`/`turnId` resumes that TFA thread; a dead
thread re-runs from `pending`. In-session / in-workspace only — cross-session
durability is deferred.
