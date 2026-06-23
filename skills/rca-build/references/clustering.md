# Failure-signature clustering

Why: a red build's N failures usually trace to a handful of causes (one bad
PR/deploy/shared helper). Running the full collaborative loop once per *cause*
instead of once per *test* turns the dominant cost from **O(tests) → O(distinct
causes)** — the only thing that makes "RCA for ALL failed tests, even thousands"
feasible. But **every failed test must still show a per-test RCA in the TRA
dashboard**, so clustering collapses the *evidence hunt*, not the *output*.

The logic lives in `lib/signature.mjs`; this file is the protocol.

## The signature

Computed from the trimmed failure detail `listTestIds(includeFailureDetail=true)`
already returns on each row — **no extra probe turns**:

```
signature = normalize(failure_category) | normalize(error_summary) | normalize(file_path)
```

`normalize` folds the volatile tokens that make two instances of the *same*
failure look different: ISO timestamps, UUIDs, hex/memory addresses, `file:line:col`,
and bare numbers. So `timeout after 3000ms on node-7` and `timeout after 5000ms
on node-2` share a signature.

A row with **no signal** (empty category, error, and path) is **not** merged into
a catch-all — it becomes its own singleton (`solo-<testRunId>`). Better an
un-clustered test than a wrong cluster.

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
- TFA returns `NEEDS_INFO` / `BLOCKED` (the hypothesis does not hold for this
  test's logs) → the sibling **falls back to its own full loop**. The
  representative's cause is never stamped onto a sibling without log confirmation.

This keeps correctness independent of the cost optimization: worst case, every
sibling runs its own full loop (same as no clustering); best case, one deep run
covers the whole cluster.

## Singletons

A cluster of one is just a plain per-test loop — no pre-seed, no confirm step.
