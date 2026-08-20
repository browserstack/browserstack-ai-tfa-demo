# Clustering

Why: a red build's N failures usually trace to a handful of causes (one bad
PR/deploy/shared helper). Running the full collaborative loop once per *cause*
instead of once per *test* turns the dominant cost from **O(tests) → O(distinct
causes)** — the only thing that makes "RCA for ALL failed tests, even thousands"
feasible. But **every failed test must still show a per-test RCA in the TRA
dashboard**, so clustering collapses the *evidence hunt*, not the *output*.

## You do the grouping

Nothing in `lib/` clusters any more. It used to: normalise the failure signature
with a regex chain — fold timestamps, UUIDs, hex, `file:line:col`, bare numbers —
join `category | error | file`, hash it, and group by **exact match**. That is a
weak algorithm wearing determinism as a disguise. `Timeout waiting for element`
and `element not visible after 30s` are one cause and two strings, and no amount
of regex folding closes that gap; conversely two identical error strings can have
unrelated causes, which exact matching happily conflates.

You group better than that, so you do it. Two inputs, used together:

- **The server's failure themes**, preferred, because they reflect real
  root-cause analysis rather than string similarity. `getBuildFailureThemes` is
  responsible for making themes EXIST, not just reading them: if none have been
  computed it triggers computation on the same call and polls in-call — one GET
  first, a single POST trigger only when the build has no themes (never
  re-fired), then GET every 3s to a 90s ceiling. `ready: true` on success;
  `ready: false` means the server genuinely could not produce them. Then
  `listTestsInFailureTheme` per theme, following `nextCursor`, for the members.
- **Your own reading of the signatures**, which `listTestIds(includeFailureDetail=true)`
  already returned on every row — no extra probe turns. This is what you fall back
  to when themes are not ready, and what you use to sanity-check a theme that
  groups two failures you can see are unrelated.

Any test the server did not place is never dropped: give it its own singleton id.
Better an un-clustered test than a wrong cluster.

Then hand the result to `persistClusters(csvPath, csvState, {testRunId: clusterId})`.
That call is the one piece of this still in code, and it is there because it
failed in production: the old API mutated rows and returned `{rows, clusters}`, so
a caller destructuring only `clusters` discarded every `cluster_id` — 12 tests
became 26 subagents over 30 minutes, twice in one day, by two independent
callers. It writes, reads back to confirm, and refuses a partially clustered CSV.
**Every row must be assigned**; an omission is a silent per-test fan-out.

## Representative + siblings

Each cluster gets:

- **Representative** — `selectRepresentative` picks it: non-flaky preferred, then
  smallest `testRunId`. Deterministic on purpose, because the CSV persists
  `cluster_id` but not which member was the exemplar, so a resumed run that chose
  differently would pay for the same investigation twice. Runs the **full
  multi-turn `ai-tfa-coordinator` loop** →
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
