---
name: rca-build
description: Batch collaborative RCA over every failed test of a BrowserStack build via tfaRcaTurn. Clusters failures, routes evidence (GitHub/k8s/logs/metrics), writes a per-test RCA. Generic across product and infra. Use when a build is red. Args: build id, optional mode=auto|interactive.
---

# rca-build — batch collaborative RCA over a build

Drives the `tfaRcaTurn` collaborative loop over **every failed test** of a build
and records a per-test RCA. **TFA owns logs; the client agent owns everything
else** (product code, k8s, kibana, metrics, deploy, ci) — routed by capability,
generic over product and infra.

This skill is the **build-level orchestrator** (`ai-tfa-orchestrator` role). It
never calls `tfaRcaTurn` itself — it dispatches the `ai-tfa-coordinator`
(test-level) per test/cluster member, which drives the loop and lets TFA author
the dashboard RCA.

Config (concurrency, turn-cap, paths, evidence registry) lives in
`config/rca.config.json`. State lives in the CSV/WAL spine (`lib/csv-state.mjs`).

## Step 0 — mode + input

Parse the build id from the invocation args. Accepted forms: a bare build id, a
`build_id=<id>` token, or a build dashboard link (extract the id). Also accept an
optional `mode=auto|interactive` and any PR URLs the user supplies (carry them
into the pre-flight intake as the product/automation PRs).

- No build id present → it is required:
  - interactive session → ask the user.
  - **headless (`claude -p`) with build id missing → end immediately (fail fast).**
- No mode given → ask the user once (auto vs interactive). In headless, default `auto`.

## Step 1 — pre-flight intake (F1)

Intake fields: product repo, automation (test) repo, working branch, default
branch, the PRs in play (product + automation), and the build id. **How they're
collected depends on mode — auto must never block.**

**Auto mode → do NOT prompt. Proceed with whatever is present.** Gather the
intake from the invocation args (build id + any PR URLs / repos / branch the user
passed) and from cheap inference (e.g. `gh repo view`, current branch). Any field
not supplied is recorded as "I don't have one" and the run proceeds **RCA-only**
for that field. Auto mode is autonomous — it does not stop to ask the user, in an
interactive `claude` session or otherwise. Show the resolved intake + capability
manifest as a one-line FYI, then immediately continue to Step 2. (This is the
"present human answered at launch by passing args" assumption — the absence of an
arg is itself the answer, not a reason to wait.)

**Interactive mode → ask A1 once, in one pass**, for the fields above. Every
question is answerable with "I don't have one" → record the gap and proceed
RCA-only. Do not block the run on missing GitHub context. After this single
upfront pass, the rest of the batch runs without re-prompting (gaps surface via
the per-test gap-return, not the intake).

**Headless rule:** in `claude -p`, the build id is the only required input; if
it's missing after parsing, end immediately (fail fast). All intake fields
default to "none" without prompting (same as auto).

## Step 2 — discovery (F2)

Call the bundled MCP tool:

```
listTestIds(buildId=<id>, status="failed", includeFailureDetail=true)
```

`includeFailureDetail=true` returns each row's trimmed failure signature
(`failure.{category, error_summary, file_path, …}`) — the seed for clustering, so
no per-test probe turns are needed.

Seed the CSV/WAL spine from the payload (`lib/csv-state.mjs` → `seed`): one row
per failed test, every row `rca_done=pending`, signature columns populated.
Re-running `seed` on an existing CSV is idempotent and preserves terminal rows
(resume-safe). If `listTestIds` returns empty → write an empty CSV, report "no
failed tests", stop.

## Step 3 — failure-signature clustering (see references/clustering.md)

Compute a failure signature per row and assign `cluster_id` (`lib/signature.mjs`).
Each cluster gets one **representative** (full multi-turn loop) and `N−1`
**siblings** (pre-seeded one-turn confirm against their own logs). This collapses
the expensive evidence hunt to O(distinct causes) while every test still lands a
per-test RCA. Singleton clusters are just plain per-test loops.

## Step 4 — build-evidence pre-compute + capability manifest (see references/evidence-routing.md)

Once, before fan-out:

- **Capability manifest** — enumerate the skills/tools the client actually has
  into `capability → {available, via}` (GitHub, k8s, logs, metrics, …). Declare
  to the user up front what will be **unavailable** ("k8s + metrics not
  available"). Every coordinator routes asks against this manifest.
- **Build-level evidence** — compute the last-green→this-build delta (diff,
  deploy timeline, suspect-PR window) **once** and pre-seed every coordinator
  with the same grounded window. Cache by `(repo, commit-range)`. No "last green"
  baseline (never-green suite) → fall back to a configured baseline ref and log it.

## Step 5 — fan-out (the mode fork)

Drive the cluster work-list, **`concurrency` (default 5) at a time**:
representatives deep, siblings one-turn-confirm. Eagerly persist to the CSV/WAL
(claim → heartbeat → flip) so the run is resumable.

- **auto** → run the dynamic workflow `workflows/rca-batch.mjs` (script-orchestrated,
  no user input; gap → "unavailable" back to TFA → best-effort finalize).
- **interactive** → spawn `ai-tfa-coordinator` subagents 5 at a time; on an
  evidence gap a subagent ends early with a `GAP_OUTPUT` (resume handles), and
  this orchestrator asks the user (A1) then re-dispatches with `resume=`. Subagents
  return compact blocks, not transcripts (keeps the main context lean for large
  batches). Full protocol: `references/interactive-mode.md`.

Both modes use the **same** `ai-tfa-coordinator`; only the injected gap-resolver
differs. A coordinator that dies becomes a recorded `failed` row — one stuck test
never sinks the batch (partial-first).

## Step 6 — report (see references/report-format.md)

When every row is terminal, render the report (`paths.reportFile`): per-test rows
with status + the **evidence-coverage band** (a RESOLVED built with evidence
unavailable reads as lower confidence than a fully-evidenced one). Degrade,
don't crash — missing fields render as "not available".

## Resume

On startup, run the reaper (`lib/csv-state.mjs` → `reaper`) to reclaim rows
stranded `in_flight` by a crashed worker (heartbeat older than
`reaperHeartbeatTtlSec`) back to `pending`, then re-point fan-out at the CSV.
Live `threadId`/`turnId` resume the prior thread; dead threads re-run from
pending. (In-session only — cross-session durability is deferred.)

## Hard rules

- Always run the pre-flight intake; never silently skip it (but never block on "I don't have one").
- Headless + missing required input → end immediately.
- Never call `tfaRcaTurn` from this skill — always via the `ai-tfa-coordinator`.
- Every failed test must end terminal in the CSV — partial-first, no abort-on-one-failure.
- Never gather `test_logs` — TFA owns logs.
