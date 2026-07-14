---
name: rca-build
description: Single-gate autonomous batch RCA over every failed test of a BrowserStack build via tfaRcaTurn. One gate (connector validation + assumed intake), then fully autonomous — clusters failures, routes evidence, triggers the dashboard report. Args: build id, optional PR URLs / repo hints.
---

# rca-build — single-gate autonomous RCA over a build

Drives the `tfaRcaTurn` collaborative loop over **every failed test** of a build
and lands a per-test RCA in the TRA (Test Observability) dashboard. **TFA owns
logs; the client agent owns everything else** (product code, k8s, kibana,
metrics, deploy, ci) — routed by capability, generic over product and infra.

This skill is the **build-level orchestrator** (`ai-tfa-orchestrator` role). It
never calls `tfaRcaTurn` itself — it dispatches the `ai-tfa-coordinator`
(test-level) per test/cluster member, which drives the loop and lets TFA author
the dashboard RCA. **The full RCA report lives on the Test Observability UI, not
in Claude** — this run's job is to feed it, then surface a terse glimpse and the
link.

There is exactly **one mode**: autonomous. There is exactly **one gate** (Step
1) before execution. After the gate closes, **the run never asks the user
anything again.**

Config (concurrency, turn-cap, paths, evidence registry) lives in
`config/rca.config.json`. State lives in the CSV/WAL spine (`lib/csv-state.mjs`).

## Step 0 — input

Parse the build id from the invocation args. Accepted forms: a bare build id, a
`build_id=<id>` token, or a build dashboard link (extract the id). Also accept
any **PR URLs** and **repo hints** (product/automation repo names or paths) the
user supplies — carry them into Gate Part B as pre-answered intake.

- No build id present:
  - interactive session → fold "which build?" into the gate's single
    consolidated question (Step 1, Part B). It is the only genuinely
    load-bearing field.
  - **headless (`claude -p`) → end immediately (fail fast).**

## Step 1 — THE GATE (one gate, two parts, closes once)

Everything the run could possibly need from the user is settled here, in one
pass. The gate has two parts; both run before any RCA work starts.

### Part A — connector discovery + validation

Enumerate every connector relevant to test RCA:

- from `config/rca.config.json` → `evidenceRouting`: **github**
  (product_code/deploy/ci), **k8s**, **logs** (e.g. kibana), **metrics**,
  **other**;
- plus any connector-shaped skills / MCP servers present in the session
  (a log-search MCP, a metrics MCP, an infra skill, …).

**Validate** each with a cheap probe — discovery alone is not enough:

| Connector | Probe |
|---|---|
| github | `gh auth status` (or a GitHub MCP tool listed) |
| k8s | k8s skill present **and** `kubectl` reachable (e.g. `kubectl version --request-timeout=5s`) |
| logs | a log-search skill/MCP tool actually listed in the session |
| metrics | a metrics skill/MCP tool actually listed in the session |
| other | best-effort; default `absent` |

Output the **validated capability manifest**: `connector → valid | invalid |
absent` (`lib/routing.mjs` → `buildManifest`; `valid` maps to
`available: true`). An `invalid` or `absent` connector is a **recorded gap** —
declared to the user in the gate summary and to TFA on the first turn ("I don't
have logs/metrics access") — **never a blocker**. The run always proceeds.

### Part B — requirements (assume first, ask once, at most)

Intake fields: product repo, automation (test) repo, working branch, default
branch, the PRs in play, and the build id. **Resolve every field by ASSUMPTION
wherever possible** — this is an assumption-OK workflow; less user interaction
is the point:

- invocation args (build id, PR URLs, repo hints from Step 0),
- `gh repo view` / git remotes for the repos,
- the current branch for the working branch,
- cheap inference (e.g. the automation repo is the cwd if it holds the tests).

Record each assumption in the gate summary (format:
`templates/gate-summary.md`; worked example: `examples/sample-run.md`)
("assumed product repo =
`org/obs-api` from git remote"). A field that cannot be assumed is recorded as
"none" and the run proceeds RCA-only for it — **unless** it is both genuinely
non-assumable AND load-bearing (in practice: only the build id, and rarely an
ambiguous repo when PRs were supplied). Those, and only those, may be asked
**ONCE, in a single consolidated question at gate close**. Never a second
question. **Headless: skip asking entirely; record the gaps.**

### Gate close

Print a one-screen summary: resolved intake (with assumptions marked) + the
validated capability manifest (with gaps named). Then the gate closes.

**AFTER THE GATE CLOSES, THE RUN NEVER ASKS THE USER ANYTHING AGAIN.** RCA
execution is fully autonomous: every downstream evidence gap becomes an
`unavailable` block back to TFA (best-effort finalize), never a prompt.

## Step 2 — discovery

Call the bundled MCP tool:

```
listTestIds(buildId=<id>, status="failed", includeFailureDetail=true)
```

`includeFailureDetail=true` returns each row's trimmed failure signature
(`failure.{category, error_summary, file_path, …}`) — the seed for clustering,
so no per-test probe turns are needed.

Resolve the state file with `lib/csv-state.mjs` → `csvPathFor(buildId,
config.paths.stateDir)` — the **build id is in the filename** and the default
directory is **OS temp** (`<tmpdir>/bstack-rca/rca-state.<buildId>.csv`), so
different builds can never collide and the invoking workspace stays clean. Pass
this exact path to the fan-out workflow as `csvPath`.

Seed the CSV/WAL spine from the payload (`lib/csv-state.mjs` → `seed`): one row
per failed test, every row `rca_done=pending`, signature columns populated.
Re-running `seed` on an existing CSV is idempotent and preserves terminal rows
(resume-safe — same build id → same path). If `listTestIds` returns empty →
write an empty CSV, report "no failed tests", stop.

## Step 3 — failure-signature clustering (see references/clustering.md)

Compute a failure signature per row and assign `cluster_id` (`lib/signature.mjs`).
Each cluster gets one **representative** (full multi-turn loop) and `N−1`
**siblings** (pre-seeded one-turn confirm against their own logs). This collapses
the expensive evidence hunt to O(distinct causes) while every test still lands a
per-test RCA. Singleton clusters are just plain per-test loops.

## Step 4 — build-evidence pre-compute (see references/evidence-routing.md)

Once, before fan-out (the capability manifest already exists from Gate Part A —
reuse it, do not re-discover):

- **Build-level evidence** — compute the last-green→this-build delta (diff,
  deploy timeline, suspect-PR window) **once** and pre-seed every coordinator
  with the same grounded window. Cache by `(repo, commit-range)`. No "last green"
  baseline (never-green suite) → fall back to a configured baseline ref and log it.

## Step 5 — fan-out (fully autonomous)

Drive the cluster work-list, **`concurrency` (default 5) at a time**:
representatives deep, siblings one-turn-confirm. Eagerly persist to the CSV/WAL
(claim → heartbeat → flip) so the run is resumable.

- Claude Code → run the dynamic workflow `workflows/rca-batch.mjs`
  (script-orchestrated; gap → "unavailable" back to TFA → best-effort finalize).
- Hosts without the Workflow runtime → dispatch `tfa-rca:ai-tfa-coordinator`
  subagents ≤ `concurrency` at a time, or drive the sequential harness
  `lib/loop.mjs` (`runRcaLoop`). Same contract, same no-prompt rule.

Subagents/coordinators return compact `RCA_OUTPUT` blocks, never transcripts. A
coordinator that dies becomes a recorded `failed` row — one stuck test never
sinks the batch (partial-first). No path ever prompts the user (the gate is
closed).

**Application bugs need a culprit PR.** Whenever a test's RCA classifies as
PRODUCT_BUG / application bug, the coordinator MUST hunt the culprit PR via the
github connector (deploy timeline vs last-pass window, changed paths vs failure
signature — `references/github-evidence.md`) and feed the PR link(s) to TFA in
the turn message so the dashboard RCA's `related_prs` populates. An
application-bug RCA with no GitHub PR link is **incomplete**: keep digging until
the turn cap; if still none, the turn must explicitly state "no culprit PR
identified after <what was searched>" and the CSV row records the gap.

## Step 6 — finish: glimpse + dashboard report (NO local report)

This plugin **never renders or writes a local RCA report**. When every row is
terminal:

1. Print a **terse glimpse table** from the CSV (`lib/glimpse.mjs` →
   `renderGlimpse`): one line per test — `testRunId → cluster → status →
   confidence one-liner`. That is the entire in-Claude output.
2. Call the MCP tool **`triggerRcaReport(buildUuid=<build id>)`** (add
   `force=true` only to re-run over an existing completed report). It returns a
   trimmed glimpse (`state, verdict, verdictProvisional, partial, analyzedCount,
   totalFailedCount, totalPrs, faultyPrNumbers, failureReason, viewReport`).
3. Print the link line, verbatim shape:

   ```
   Full report on the Test Observability UI: <viewReport>
   ```

Humans read the real report **there**, populated by the BrowserStack agent —
not in Claude.

## Resume

On startup, run the reaper (`lib/csv-state.mjs` → `reaper`) to reclaim rows
stranded `in_flight` by a crashed worker (heartbeat older than
`reaperHeartbeatTtlSec`) back to `pending`, then re-point fan-out at the CSV.
Live `threadId`/`turnId` resume the prior thread; dead threads re-run from
pending. Resuming a run does **not** reopen the gate — no new questions.
(In-session only — cross-session durability is deferred.)

## Hard rules

- Exactly one gate. At most one consolidated question, at gate close. **After
  the gate closes, never ask the user anything.**
- An invalid/absent connector is a recorded gap, never a blocker.
- Headless + missing build id → end immediately. Headless never asks.
- Never call `tfaRcaTurn` from this skill — always via the `ai-tfa-coordinator`.
- Every failed test must end terminal in the CSV — partial-first, no abort-on-one-failure.
- Never gather `test_logs` — TFA owns logs.
- Never render/write a local RCA report — glimpse table + `triggerRcaReport` +
  the Test Observability UI link only.
- A PRODUCT_BUG RCA without a GitHub PR link is incomplete — dig until the turn
  cap, else state what was searched and record the gap.
