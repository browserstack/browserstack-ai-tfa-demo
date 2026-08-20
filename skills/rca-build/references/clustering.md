# Clustering

Why: a red build's N failures usually trace to a handful of causes (one bad
PR/deploy/shared helper). Running the full collaborative loop once per *cause*
instead of once per *test* turns the dominant cost from **O(tests) → O(distinct
causes)** — the only thing that makes "RCA for ALL failed tests, even thousands"
feasible. But **every failed test must still show a per-test RCA in the TRA
dashboard**, so clustering collapses the *evidence hunt*, not the *output*.

## Source: the server's failure themes

Clustering comes from one source — the server's failure themes — so the
`{ cluster_id, signature, members, representative, siblings }` shape is produced
the same way every run, and nothing downstream (the fan-out workflow, the
sequential harness) needs to branch on it.

`lib/theme-clustering.mjs` → `clustersFromThemes(rows, themesResult, testsByThemeId)`,
fed from the `getBuildFailureThemes` / `listTestsInFailureTheme` MCP tools
(SKILL.md Step 3). `getBuildFailureThemes` makes themes exist, not just reads
them: if none have been computed it triggers computation (one POST, same call)
and polls `buildThemeWorkflow.status` — one GET first, a single POST trigger
only when no themes exist yet (never re-fired), then GET every 3s up to a 90s
ceiling. `ready: true` (SUCCESS) → real themes; `ready: false` (budget spent,
`FAILED`/`ERROR`, or `trigger-unavailable`) → the server couldn't group. The
grouping reflects the server's own root-cause analysis: two failures with an
identical error string but unrelated causes aren't conflated the way a text-only
guess would conflate them.

**When the server returns no themes (`ready: false`)**, pass an empty
`buildThemes` to `clustersFromThemes` and every failed test falls through to its
own `solo-` cluster — i.e. **all tests become representatives**, each running a
full per-test loop. Correctness over the cost collapse: no local guessing.

## Representative + siblings

Each cluster gets:

- **Representative** — a stable exemplar (non-flaky preferred, then smallest
  `testRunId`). Runs the **full multi-turn `ai-tfa-coordinator` loop** →
  confirmed root cause + culprit `related_prs`.
- **Siblings** (`N−1`) — each runs its **own** coordinator, **pre-seeded** with
  the representative's `root_cause` + suspect PRs. TFA confirms the hypothesis
  **against that sibling's own logs in a single turn** → a logs-grounded per-test
  RCA in the dashboard at minimal cost.

Net cost per cluster: **1 deep investigation + (N−1) one-turn confirms.**

## The safeguard — never blindly inherit

Distinct failures can share an error string. A sibling's pre-seed turn is a
*hypothesis to confirm*, not a verdict to copy:

- TFA `RESOLVED`s the sibling in one turn → logs-grounded inheritance, cheap. 
- TFA returns `NEEDS_INFO` (the hypothesis does not hold for this
  test's logs) → the sibling **falls back to its own full loop**. The
  representative's cause is never stamped onto a sibling without log confirmation.

This keeps correctness independent of the cost optimization: worst case, every
sibling runs its own full loop (same as no clustering); best case, one deep run
covers the whole cluster.

## Singletons

A cluster of one is just a plain per-test loop — no pre-seed, no confirm step.
