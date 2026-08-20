---
name: rca-build
description: Single-gate autonomous batch RCA over every failed test of a BrowserStack build via tfaRcaTurn. One gate (capability validation + assumed intake), then fully autonomous — clusters failures, gathers evidence, triggers the dashboard report. Args: build id, optional PR URLs / repo hints.
---

# rca-build — single-gate autonomous RCA over a build

Drive the `tfaRcaTurn` loop over **every failed test** of a build so each one lands
an RCA in the Test Observability dashboard.

**TFA owns logs. You own everything else** — product code, runtime, application
logs, metrics, deploy, CI. You are the build-level orchestrator; you dispatch an
`ai-tfa-coordinator` per test or cluster member, and the coordinator drives the loop
so TFA authors the RCA. **The report lives on the dashboard, not in this session.**
Your output is a completion notice and a link.

Two invariants, and they are the whole shape of this skill:

1. **One gate, and it closes.** Everything you need from a human is settled in a
   single pass before any RCA work. After it closes you never ask again — every
   later gap becomes an `unavailable` note back to TFA.
2. **Every failed test ends terminal.** Partial results beat an aborted run. One
   test failing to resolve never stops the others.

## Mandated reading

- `<pluginRoot>/skills/rca-build/SKILL.md` (this body)
- `<pluginRoot>/skills/rca-build/references/api.md` — the `lib/` signatures you call
- `<pluginRoot>/skills/rca-setup/references/context-api.md` — the committed setup
  context, shared with `rca-setup` so one copy serves both
- `<pluginRoot>/skills/rca-build/references/clustering.md` — Step 3
- `<pluginRoot>/skills/rca-build/references/evidence-routing.md` — Step 4, and every
  coordinator you dispatch
- `<pluginRoot>/skills/rca-build/references/code-evidence.md` — the culprit-PR hunt

## How to work

**Batch independent work.** Capability probes, per-repo fetches, per-workload
sweeps, cluster dispatches — anything with no dependency between the calls goes in
one message. The only ordering that is real is a genuine data dependency: one
call's output being another's input. Sequencing independent calls has cost real runs
minutes at the front of the pipeline, where it delays everything after it.

**You decide how; the config decides what.** `config/rca.config.json` names the
capabilities that exist, what each one is for, and which scope questions have a
downstream consumer. It does not tell you which command to run, and it does not
know your customer's stack. Deciding that `newrelic-cli` serves metrics, or that a
Nomad box is not a Kubernetes box, is your judgement — a fixed list of vendor names
cannot make it, and one that tried told New Relic customers to install `promtool`.

**Say what you actually checked.** When you verify something, name the check. A
capability reported working without naming what proved it is recorded `unverified`,
not verified, because a claim with no evidence carries no information.

## Step 0 — input

Parse the build id from the invocation args: a bare id, `build_id=<id>`, or a
dashboard link. Also take any PR URLs and repo hints the user supplies and carry
them into the gate as pre-answered intake.

No build id: interactive → fold "which build?" into the gate's single question, the
one genuinely load-bearing field. **Headless → stop immediately.**

## Step 1 — the gate

### Part A — what this machine can reach

Read the persisted setup context first, before any probe. A probe confirms what
`rca-setup` already resolved; it does not rediscover it.

```js
const read = readRcaContext({ from: process.cwd(), pluginRoot });
const verdict = startOfRunRefusal(read);   // the entire refusal policy
```

`startOfRunRefusal` refuses in three cases: no context found, a context present but
unusable, and GitHub unverified. Its `message` and `nextAction` are written to be
printed as-is. The distinction between the first two matters — telling someone to
run setup when their file is merely conflict-marked throws away every answer they
already gave.

Otherwise `verdict.partial` tells you whether some capabilities were left
unanswered; those are declared as gaps, exactly like a skip.

**Seed the manifest from the context.** `context.verified` carries each capability's
route and the targets setup proved. Confirm those cheaply and in one batch. Anything
the context does not cover, resolve now:

- Connector-shaped skills supersede a raw tool for their capability, because they
  carry a repo map and conventions the raw tool does not. Look under
  `.claude/skills/`, and above cwd as well — when this plugin is itself a checkout
  in the workspace, the product's skills sit one or two levels up. A skill
  declaring `capability: <name>` IS the connector for it.
- Several product families may be present. Pick the one that owns THIS build's
  failures by matching build metadata and failure signatures against what each
  declares. If both signals leave it genuinely ambiguous, that earns a part of the
  single gate question. Headless: take the first and record the ambiguity as a gap.
- Otherwise probe whatever the session actually has. Record what each capability
  is reached through, so a coordinator knows whether it is talking to a CLI or an
  MCP server.

Output the capability manifest through `buildManifest` — `available` plus what it is
reached `via`. **An absent capability is a recorded gap, never a blocker — except**
the three start-of-run context refusals above, which fire before the gate opens.

### Part B — intake

Fields: product repo, automation repo, working branch, default branch, the PRs in
play, the build id.

**Resolve by assumption wherever possible.** Less interaction is the point.

```js
const intake = resolveIntake({
  buildMeta,                                   // fetchBuildInsights — the branch the build ran on
  invocationArgs,                              // build id, PR URLs, repo hints the user typed
  context: intakeFromContext(read.context),    // translate: the artifact's vocabulary is not the run's
  connectorDefaults,                           // the connector skill's intake defaults
  fields: ["repo", "automationRepo", "baseBranch", "namespace", "workloads"],
});
```

Precedence, in full: **build metadata → invocation args → persisted context →
connector intake defaults → inference.** Inference is not a tier — it runs only on fields
that came back `unresolved`, and never overwrites a resolved one. Report each
field's `source` at the gate so a human can see which tier won.

`intakeFromContext` is required, not decoration: the artifact speaks the capability
table's vocabulary and this call asks for the run's, and `resolveIntake` matches
keys exactly.

Two things worth stating because both have gone wrong:

- **A context-verified repo is given, not a hint.** Never re-ask for a repo setup
  already proved. The corroboration below applies to doc- and remote-sourced hints.
- **A branch adopted from build metadata is re-verified.** Setup verified the
  persisted branch; metadata may hand you a different one, and adopting it unchecked
  skips the empty-PR-window warning that predicts a dead culprit hunt.

**Corroborate the product repo.** It must plausibly be the system under test for
*these* failures, not a name found lying around. A repo mentioned only in a README
is a weak hint: check it against the failure signatures. If the failing area, files
and error strings have nothing to do with that repo's domain, discard it.

With no corroborated product repo: PRs supplied → derive it from them, no question.
Interactive and no PRs → it is load-bearing and non-assumable, so it earns the gate
question. Headless → record the gap and run RCA-only; every culprit hunt reports no
culprit PR found.

### Gate close

Print one screen: resolved intake with each field's source, the capability manifest
with gaps named. Format in `templates/gate-summary.md`.

**At most one question, and only for a field that is both non-assumable and
load-bearing.** In practice that is the build id, and the product repo when it could
not be corroborated and no PRs were supplied. If more than one survives, they are
parts of ONE question. There is no second gate question.

**Then the gate closes and the run is autonomous.** The only things that stop a run
are the three start-of-run refusals above, and they fire before the gate opens —
which is the precondition for autonomy, not an exception to it.

## Step 2 — discovery

```
listTestIds(buildId=<id>, status="failed", includeFailureDetail=true)
```

`includeFailureDetail` returns each row's failure signature, which is the seed for
clustering — so no per-test probe turns are needed.

Harden the state directory once (`hardenStateDir`), then resolve the state file with
`csvPathFor(buildId, config.paths.stateDir)`. The build id is in the filename and
the default directory is OS temp, so builds cannot collide and the workspace stays
clean. Pass that exact path to fan-out.

Seed the CSV spine: one row per failed test, `rca_done=pending`, signatures
populated. `seed` is idempotent and preserves terminal rows, so a resume against the
same build id is safe. Empty result → write an empty CSV, report it, stop.

These artifacts are the resume state, so nothing sweeps them automatically. Clean up
only after the report is triggered.

## Step 3 — clustering

Details in `references/clustering.md`. One **representative** per cluster runs the
full loop; siblings get a pre-seeded one-turn confirm against their own logs. That
collapses the evidence hunt to the number of distinct causes while every test still
lands its own RCA.

**You group the failures; nothing in `lib/` does.** Call `getBuildFailureThemes`
first — it reflects real root-cause analysis rather than string similarity, and it
makes themes exist rather than only reading them. When it is not ready, group from
the failure signatures `listTestIds` already returned. Either way, hand
`{testRunId: clusterId}` to `persistClusters`, which refuses a partially clustered
CSV — every row assigned, a singleton being a decision and an omission being a
silent per-test fan-out.

Cluster from `readRows(csvPath)` — the CSV Step 2 seeded — not from a `listTestIds`
result held over from earlier in the turn. A held-over result has cost a real run
correctness.

```js
// {testRunId: clusterId} — your grouping. Ids are yours; only stability matters.
const clusters = persistClusters(csvPath, csvState, assignment);
```

## Step 4 — evidence

Routing in `references/evidence-routing.md`; the culprit-PR protocol in
`<pluginRoot>/skills/rca-build/references/code-evidence.md`.

Build-level evidence is gathered **once** and shared, not re-fetched per test: the
PR window for each repo, the deploy state, the log sweep per workload. Write it to
the shared evidence file so every coordinator reads the same bytes.

Fetches for different repos and different workloads are independent — one batch.

**Read from local clones where you can.** Resolve them once at the gate and record
the result, or every file read goes over the network — on one measured run file
contents were 126 of 407 forge calls.

```js
const { root } = discoverWorkspaceRoot({ repos, from: process.cwd() });
const local = resolveLocalRepos({ repos, pins: deployShas(evidencePath).pins, workspaceRoot: root });
setLocalRepos(evidencePath, local, Date.now());   // coordinators read this, never re-probe
```

Then, once the gathers land, derive coverage from what actually has a gap-free
entry rather than from what you tried:

```js
recomputeCoverage(evidencePath, { repos, workloads }, Date.now());
```

**Read-only lookups go through the tool cache** (`bin/cached-exec.mjs`,
`bin/cached-mcp.mjs`). Two things it needs from you:

- **Say whether a result is stable or a snapshot.** File content at a commit sha is
  stable — immutable, safe to reuse indefinitely. Live state is a snapshot: pod
  status, a log query, a metrics instant query, a PR list, anything mid-run. A
  snapshot reused later is an assertion about the past.
- **Never cache a stateful call.** Turn submission and turn results change by
  design, and so does anything still being computed server-side. If reusing an
  answer could hide a transition, it is not cacheable.

A cache hit reports its age. If the age matters for what you are concluding, say so
in the evidence rather than treating the hit as current.

## Step 4b — turn-1 pre-dispatch

Concurrent with Step 4, submit turn 1 for each cluster representative — one direct
`tfaRcaTurn` call each. This is the **only** place this skill calls `tfaRcaTurn`
directly; every other turn goes through a dispatched coordinator.

Record the outcome in the turn-1 registry, then hand it to fan-out:

- `PENDING` → the coordinator resumes that thread rather than opening a new one.
- `NEEDS_INFO` → its asks are the coordinator's Step-4 shopping list.
- `RESOLVED` → flip it terminal in the CSV; no coordinator needed.

**A soft `PENDING` is not an answer.** Drain it with `getTfaTurnResult(testRunId,
turnId)` before submitting anything further on that thread. Only a spent drain
budget may leave a test `PENDING`.

## Step 5 — fan-out

Dispatch coordinators at `config.concurrency`. Representatives first; siblings once
their representative resolves, pre-seeded with its finding via `siblingPreSeed`.

A sibling confirms against its own logs — it never inherits a cause unchecked. Same
signature is a strong prior, not a conclusion.

Every dispatch prompt carries: the build id, the CSV path, the evidence-file path,
the capability manifest, the turn-1 entry, and the reference paths — all
`pluginRoot`-qualified, since the coordinator's cwd is not yours.

## Step 6 — finish

When every row is terminal, trigger the dashboard report, then clean up this build's
artifacts.

Print a status count and the link. Nothing else:

```
Full report on the Test Observability UI: <viewReport>
```

**Do not print root causes, culprit PRs, cluster breakdowns, per-test analysis or a
per-test table.** Those belong in the CSV and the dashboard. If a human wants the
why, they open the link. Your job here is "analysis complete → it is at this link",
not to re-narrate an RCA the BrowserStack agent authored.

## Resume

Run the reaper on startup to reclaim rows stranded `in_flight` by a dead worker,
then re-point fan-out at the CSV. Live threads resume; dead ones re-run from
pending. **Resuming does not reopen the gate.**

A `pending-resume` row means a coordinator's soft-`PENDING` drain budget was spent.
Read its `turnId` with `getTfaTurnResult` before submitting anything new on that
thread.

## Hard rules

- One gate. At most one consolidated question, at gate close. After it closes, never
  ask the user anything.
- An unavailable capability is a recorded gap, never a blocker — **except** the three
  start-of-run context refusals, which stop the run before the gate opens.
- Headless never asks. Headless with no build id ends immediately.
- Never call `tfaRcaTurn` from this skill except Step 4b's turn-1 pre-dispatch.
- A soft `PENDING` must be drained before any further submit on that thread.
- Every failed test ends terminal. Partial-first; never abort on one failure.
- Never gather `test_logs` — TFA owns logs.
- Never write a local RCA report. The dashboard link is the output.
- A `PRODUCT_BUG` verdict without a PR link is incomplete — dig until the turn cap,
  then state what you searched and record the gap.
- A verified capability names what proved it. An unnamed check is `unverified`.
- Every path handed to a coordinator is `pluginRoot`-qualified.
