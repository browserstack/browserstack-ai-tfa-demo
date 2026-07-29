---
name: rca-build
description: Single-gate autonomous batch RCA over every failed test of a BrowserStack build via tfaRcaTurn. One gate (connector validation + assumed intake), then fully autonomous — clusters failures, routes evidence, triggers the dashboard report. Args: build id, optional PR URLs / repo hints.
---

# rca-build — single-gate autonomous RCA over a build

Drives the `tfaRcaTurn` collaborative loop over **every failed test** of a build
and lands a per-test RCA in the TRA (Test Observability) dashboard. **TFA owns
logs; the client agent owns everything else** (product code, infra/runtime, logs,
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

**Step 0 — enumerate connector-shaped skills FIRST (before probing raw MCP tools).**
Run:

```bash
ls .claude/skills/ ~/.claude/skills/ 2>/dev/null
```

For each `SKILL.md` found, open it and look for a **Capability declaration**
block (or a `capability: <name>` line in the frontmatter/body). Any skill that
declares `capability: github | infra | logs | metrics | other` **IS** the
connector for that capability and MUST be added to the manifest — it
**SUPERSEDES** the raw MCP tool for that capability because it carries
product-specific routing (repo map, cluster/namespace, branch conventions,
falsification protocol) the raw tool does not. Record the skill name in the
manifest entry (e.g. `github: valid, via: gh (skill=nl2steps-github)`). Skipping
this step is the failure mode where the orchestrator dispatches coordinators
that grep the wrong repos on the wrong branch.

**Disambiguating by product (nudge / one-question rule).** Connector skills are
product-scoped — a workspace may hold none, one, or several product families
(e.g. `nl2steps-*`, `o11y-*`, `tcm-*`, whatever the user has). After the `ls`,
pick the *product family* whose connector skills apply to THIS build:

- **Zero families found** → **nudge the user in the gate summary**:
  "No connector-shaped skills found under `.claude/skills/` — proceeding with
  raw MCP tools only; culprit-PR attribution will be best-effort against
  workspace `git remote` guesses. Add a `<product>-github` / `<product>-infra`
  skill for higher-fidelity routing." Then proceed with raw connectors. **Do
  NOT block.**
- **Exactly one family** → use it. No question.
- **Multiple families** (`nl2steps-*` AND `o11y-*` AND `tcm-*` …) → try to
  disambiguate WITHOUT asking:
  1. Match the build's project / build name (from `getBuildId` metadata or
     the invocation args) against each family's SKILL.md description / product
     hints — if one family matches unambiguously, use it.
  2. Match the discovered failure signatures (from Step 2's `listTestIds` if it
     has already run, else defer this to a re-visit after discovery) against
     each family's declared file paths / error patterns — if one family owns
     the failure surface, use it.
  If both signals leave the choice ambiguous, this earns the **one
  consolidated gate question** (Part B rules apply): fold it into the same
  question as any other non-assumable field, e.g. *"Multiple product families
  found (`nl2steps`, `o11y`, `tcm`); build/failure signatures don't uniquely
  pick one — which family owns this build's failures?"* Headless: pick the
  first alphabetically and record the ambiguity as a gap.

Then enumerate every connector relevant to test RCA:

- from `config/rca.config.json` → `evidenceRouting`: **github**
  (product_code/deploy/ci), **infra** (whatever runtime the user has — k8s,
  ECS, docker, Nomad, plain VMs, PM2, …), **logs** (kibana or any log store),
  **metrics**, **other**;
- plus any connector-shaped skills / MCP servers present in the session
  (a log-search MCP, a metrics MCP, an infra skill, …).

**Validate** each with a cheap probe — discovery alone is not enough:

| Connector | Probe |
|---|---|
| github | `gh auth status` (or a GitHub MCP tool listed) |
| infra | ANY runtime connector the user has — probe what exists, never assume one: `kubectl version --request-timeout=5s`, `docker ps`, `aws ecs list-clusters`, `nomad status`, `pm2 ls`, or an infra-shaped skill/MCP tool. Record the KIND in the manifest (`via: kubectl \| docker \| ecs \| …`) |
| logs | a log-search skill/MCP tool actually listed in the session |
| metrics | a metrics skill/MCP tool actually listed in the session |
| other | best-effort; default `absent` |

**Scope validation — run the SCOPE PROBES declared by each connector skill.**
The base probe above (`gh auth status`, `kubectl version`, …) only confirms the
raw tool works. It does not confirm the *concrete targets* a coordinator will
touch — specific repos, branches, clusters, namespaces, indices — are actually
reachable. That is the connector SKILL's job: each connector skill MUST
declare, in its `Capability declaration` section, a `Scope probes:` list
naming what to check and how. This orchestrator's contract is generic:

1. For every connector skill added to the manifest in Step 0, read its
   `Scope probes:` list.
2. Run each probe verbatim.
3. Record every target's result in the manifest entry — passes go into a
   resolved-scope field (e.g. `repos_validated: [...]`, `namespace: ok`),
   failures go into a per-target gap (e.g. `<target>: 404 not_accessible`).
4. A per-target failure is a scoped gap, not a connector-wide failure — the
   connector stays `valid` for the targets that did pass.

Coordinators can then act freely inside the resolved scope and must fail
closed outside it. This closes the failure mode where a coordinator degrades
to `unavailable` because the orchestrator didn't confirm the specific target.

Skills that don't declare `Scope probes:` degrade to a manifest-time warning
("scope probes missing — coordinator may over-degrade"). Do not invent
product-specific probes here.

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

**Product-repo corroboration (do NOT skip).** The product repo must plausibly
be the *system under test for THIS build's failures* — not merely a repo name
found lying around. A repo mentioned only in workspace docs/READMEs is a **weak
hint, never an assumption**: cross-check it against the failure signatures
(discovery runs first if needed) — do the failing area, files, or error strings
relate to that repo's domain? If they don't (e.g. the failures are self-healing
`healedElement is null` cases but the only named repo is an observability API),
the doc-sourced repo is discarded — never carry it (or its PRs) into the
manifest as a settled product repo.

When corroboration leaves **no** product repo, decide by whether a human can help:
- **PRs were supplied** → treat those as the suspect surface; product repo is
  derived from them. No question needed.
- **No PRs, interactive session** → the product repo is now **non-assumable AND
  load-bearing** (without it the mandatory culprit-PR hunt is dead), so it earns
  the single consolidated gate question below — ask it; don't silently degrade.
- **No PRs, headless** → record the gap ("product repo: unknown") and proceed
  RCA-only; every culprit-PR hunt reports "no culprit PR identified".

Record each assumption in the gate summary (format:
`templates/gate-summary.md`; worked example: `examples/sample-run.md`)
("assumed product repo =
`org/obs-api` from git remote"). A field that cannot be assumed is recorded as
"none" and the run proceeds RCA-only for it — **unless** it is both genuinely
non-assumable AND load-bearing. In practice that set is: the build id; **the
product repo when it could not be corroborated and no PRs were supplied** (see
above — without it the culprit-PR hunt cannot run); and rarely an ambiguous repo
when PRs were supplied. Those, and only those, may be asked **ONCE, in a single
consolidated question at gate close** — e.g. *"Failures look like `<domain>`;
which repo owns that code? (reply 'none' → I'll RCA without culprit-PR
attribution)."* Never a second question. **Headless: skip asking entirely;
record the gaps.**

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

Drive the cluster work-list, **`concurrency` (default 50) at a time**:
representatives deep, siblings one-turn-confirm. Eagerly persist to the CSV/WAL
(claim → heartbeat → flip) so the run is resumable. On the Claude Code /
Workflow-tool path, this is a soft target only — the Workflow runtime hard-caps
actual concurrent `agent()` calls at `min(16, cpu cores - 2)` regardless of
this config value; excess work queues and runs as slots free up rather than
running 50-wide. The sequential harness / manual subagent-dispatch path has no
such ceiling and will honor `concurrency` literally.

- Claude Code → run the dynamic workflow `workflows/rca-batch.mjs`
  (script-orchestrated; gap → "unavailable" back to TFA → best-effort finalize).
- Hosts without the Workflow runtime → dispatch `tfa-rca:ai-tfa-coordinator`
  subagents ≤ `concurrency` at a time, or drive the sequential harness
  `lib/loop.mjs` (`runRcaLoop`). Same contract, same no-prompt rule.

Subagents/coordinators return compact `RCA_OUTPUT` blocks, never transcripts. A
coordinator that dies becomes a recorded `failed` row — one stuck test never
sinks the batch (partial-first). No path ever prompts the user (the gate is
closed).

**Coordinator prompts MUST name every connector-shaped skill on the manifest.**
Each dispatch prompt lists, per capability, the resolved connector skill from
Gate Part A Step 0 — e.g. *"Use `nl2steps-github` for every product_code /
deploy / ci ask (canonical repos + branch live in the skill; do NOT grep other
repos). Use `nl2steps-infra` for every infra ask."* A coordinator prompt that
omits a manifest-listed connector skill — and that therefore lets the
coordinator infer repos from workspace `git remote` or cwd — is a bug: the
coordinator will land plausible-but-wrong PR attributions on adjacent repos.

**Application bugs need a culprit PR.** Whenever a test's RCA classifies as
PRODUCT_BUG / application bug, the coordinator MUST hunt the culprit PR via the
github connector (deploy timeline vs last-pass window, changed paths vs failure
signature — `references/github-evidence.md`) and feed the PR link(s) to TFA in
the turn message so the dashboard RCA's `related_prs` populates. An
application-bug RCA with no GitHub PR link is **incomplete**: keep digging until
the turn cap; if still none, the turn must explicitly state "no culprit PR
identified after <what was searched>" and the CSV row records the gap.

## Step 6 — finish: glimpse + dashboard report (NO local report)

This plugin **never renders or writes a local RCA report, and never surfaces RCA
detail in Claude.** The in-Claude output is a two-line completion notice plus the
link — that is all. When every row is terminal:

1. Print the **completion summary** from the CSV (`lib/glimpse.mjs` →
   `renderGlimpse`): `RCA analysis complete — build <id>` + a status count line
   (`<N> tests · <R> resolved · <P> pending · <F> failed`). **Nothing per-test.**
2. Call **`triggerRcaReport(buildUuid=<build id>)`** (add `force=true` only to
   re-run over an existing completed report).
3. Print the link line, verbatim shape:

   ```
   Full report on the Test Observability UI: <viewReport>
   ```

**Do NOT print** root causes, culprit/related PRs, cluster breakdowns, per-test
analysis, confidence rationales, or a per-test table — root_cause, related_prs,
suspect_signals and the like are for the CSV + the dashboard ONLY. If a human
wants the "why", they open the link. Claude's job here is "analysis complete →
report is at <link>", not to re-narrate the RCA the BrowserStack agent authored.

## Resume

On startup, run the reaper (`lib/csv-state.mjs` → `reaper`) to reclaim rows
stranded `in_flight` by a crashed worker (heartbeat older than
`reaperHeartbeatTtlSec`) back to `pending`, then re-point fan-out at the CSV.
Live `threadId`/`turnId` resume the prior thread; dead threads re-run from
pending. Resuming a run does **not** reopen the gate — no new questions.
(In-session only — cross-session durability is deferred.)

A `pending-resume` row now means the coordinator's **soft-PENDING drain budget
was spent** (`softPendingDrain`), not merely that a turn ran past 90s — the
common case is drained in-flight and never reaches the CSV. Resume reads such a
row's `turnId` with `getTfaTurnResult` **before** submitting anything new on the
thread.

## Hard rules

- Exactly one gate. At most one consolidated question, at gate close. **After
  the gate closes, never ask the user anything.**
- An invalid/absent connector is a recorded gap, never a blocker.
- Headless + missing build id → end immediately. Headless never asks.
- Never call `tfaRcaTurn` from this skill — always via the `ai-tfa-coordinator`.
- A soft-`PENDING` is never an answer: it must be drained with
  `getTfaTurnResult(testRunId, turnId)` before any further submit on that thread.
  Only a spent drain budget may end a test `PENDING`.
- Every failed test must end terminal in the CSV — partial-first, no abort-on-one-failure.
- Never gather `test_logs` — TFA owns logs.
- Never render/write a local RCA report — glimpse table + `triggerRcaReport` +
  the Test Observability UI link only.
- A PRODUCT_BUG RCA without a GitHub PR link is incomplete — dig until the turn
  cap, else state what was searched and record the gap.
- A connector skill's own compulsory mandate (e.g. `nl2steps-infra`'s "kubectl
  app-log check is COMPULSORY") is honored **proactively on turn 1** — never
  gated on TFA naming that evidenceType in an ask. TFA is observed to mislabel
  deploy/infra-shaped questions as `product_code`, so ask-routing alone cannot
  be trusted to trigger a compulsory check; the coordinator runs it unconditionally
  (`agents/ai-tfa-coordinator.md` Operating Principle 0) and records it under
  `mandatory_checks` in the RCA_OUTPUT.
