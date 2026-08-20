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
dispatches the `ai-tfa-coordinator` (test-level) per test/cluster member, which
drives the loop and lets TFA author the dashboard RCA — the one narrow
exception is Step 4b's turn-1 pre-dispatch, a single direct `tfaRcaTurn` call
per cluster representative, concurrent with Step 4. **The full RCA report
lives on the Test Observability UI, not in Claude** — this run's job is to feed it, then surface a terse glimpse and the
link.

There is exactly **one mode**: autonomous. There is exactly **one gate** (Step

1. before execution. After the gate closes, **the run never asks the user
   anything again.**

Config (concurrency, turn-cap, paths, evidence registry) lives in
`config/rca.config.json`. State lives in the CSV/WAL spine (`lib/csv-state.mjs`).

<use_parallel_tool_calls>
Whenever you need to perform multiple independent operations — connector
probes, per-repo evidence fetches, per-workload log sweeps, or any other set
of calls with no dependency between them — invoke all relevant tools
simultaneously in one message rather than sequentially. The only exception is
when one call's output is a literal input to another; that pair, and only
that pair, runs in order.
</use_parallel_tool_calls>

## API reference — read THIS, do not grep the source

Everything below is product-neutral: build ids, repos, branches, workloads and
paths are all **inputs**, supplied by the gate and the connector skills.

**State spine — `lib/csv-state.mjs`**
```
csvPathFor(buildId, stateDir="")            → <stateDir|tmpdir>/bstack-rca/rca-state.<buildId>.csv
seed(csvPath, buildId, tests)               → rows; idempotent, preserves terminal rows
readRows(csvPath) / writeRows(csvPath,rows) throws on a foreign header rather than dropping columns
claim(csvPath, testRunId, worker, nowMs)    → false if already claimed
heartbeat(csvPath, testRunId, worker, nowMs)
flip(csvPath, testRunId, fields, nowMs)     → false if rca_done missing/non-terminal
reaper(csvPath, ttlSec, nowMs)              → reclaimed ids
pendingRows(csvPath)                        → pending + pending-resume
```

**Clustering — `lib/theme-clustering.mjs` + `lib/signature.mjs`**
```
clustersFromThemes(rows, themesResult, testsByThemeId) → {rows, clusters}; server themes → clusters (empty themes → every test a singleton). Mutates cluster_id; caller persists via writeRows.
siblingPreSeed(csvPath, csvState, clusterId, repId)    → {ok, pre_seed} | {ok:false, reason}
```

**Shared evidence — `lib/evidence-file.mjs`**
```
evidencePathFor(buildId, stateDir="")   initEvidenceFile(path, buildId, nowMs)
setCodeEvidence(path, repo, entry, nowMs)      setLogsEvidence(path, workload, entry, nowMs)
setBaseline(path, baseline, suspectWindow, nowMs) setLocalRepos(path, localRepos, nowMs)
contributeCodeEvidence(path, writerId, repo, patch, nowMs)   ← coordinators write HERE
contributeLogsEvidence(path, writerId, workload, patch, nowMs)
deployShas(pathOrDoc) → {pins:{repo:sha}, source}   recomputeCoverage(path, {repos,workloads}, nowMs)
readEvidenceFile(path) folds base+shards · readBaseFile(path) is base ONLY
```

**Local repo reads — `lib/repo-source.mjs`**
```
discoverWorkspaceRoot({repos, from, explicit, maxTries=3}) → {root, matched, tried, reason}
resolveLocalRepos({repos, pins, workspaceRoot})            → {repo:{usable, sha|reason}}
readFileAt({repo, sha, path, workspaceRoot})               → sha ONLY; a branch name is refused
```

**Housekeeping — `lib/state-dir.mjs`**
```
hardenStateDir(dir)                       run once at gate start; idempotent (perms only, never deletes)
```

**Step 4b turn-1 pre-dispatch registry — `lib/turn1-registry.mjs`**
```
turn1PathFor(buildId, stateDir="")   → <stateDir|tmpdir>/bstack-rca/rca-turn1.<buildId>.json
initTurn1Registry(path, buildId, nowMs)   idempotent, never clobbers existing entries
recordTurn1(path, testRunId, {status, threadId, turnId?, asks?}, nowMs)   PENDING or NEEDS_INFO only — RESOLVED is flipped straight into the CSV instead
readTurn1(path, testRunId)   → entry | null
readAllTurn1(path)           → {testRunId: entry}   run-end stats only
```

**Routing — `lib/routing.mjs`, `lib/evidence-cache.mjs`**
```
loadConfig(configPath)  buildManifest(config, discovered)  routeAsks(asks, config, manifest)
resolveBaseline(lastGreenRef, fallbackRef)
```

**Commands — `bin/`**
```
node bin/evidence-show.mjs <evidenceFile> [--summary | --prs | --repo <org/repo>]
node bin/repo-read.mjs <buildId> <writerId> <org/repo> <sha> <path> [--fetch]
node bin/cached-exec.mjs <buildId> <writerId> '<command>'      (pipe OUTSIDE the wrapper)
node bin/cached-mcp.mjs <buildId> get|put <tool> '<argsJson>'
```

**Constants worth knowing**
```
csv-state.COLUMNS    the canonical column set; writeRows emits exactly these
csv-state.RESUMABLE  "pending-resume" — a SOFT terminal: claim released, row still picked up
routing.TEST_LOGS    the ask type TFA owns; never gather it, always skip
```

**Config** — `config/rca.config.json`: `concurrency`, `turnCap`, `softPendingDrain`,
`reaperHeartbeatTtlSec`, `paths.stateDir`, `evidenceRouting`. Read it once at the
gate and pass the values down; a coordinator should never need to open it.

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
# cwd, the WORKSPACE ROOT above it, and the user dir — the middle levels matter
# because this plugin may be nested inside the workspace.
ls .claude/skills/ ../.claude/skills/ ../../.claude/skills/ ~/.claude/skills/ 2>/dev/null
```

For each `SKILL.md` found, open it and look for a **Capability declaration**
block (or a `capability: <name>` line in the frontmatter/body). Any skill that
declares `capability: github | infra | logs | metrics | other` **IS** the
connector for that capability and MUST be added to the manifest — it
**SUPERSEDES** the raw MCP tool for that capability because it carries
product-specific routing (repo map, cluster/namespace, branch conventions,
falsification protocol) the raw tool does not. Record the skill name in the
manifest entry (e.g. `github: valid, via: gh (skill=<product>-github)`). Skipping
this step is the failure mode where the orchestrator dispatches coordinators
that grep the wrong repos on the wrong branch.

**Disambiguating by product (nudge / one-question rule).** Connector skills are
product-scoped — a workspace may hold none, one, or several product families
(e.g. `<product-a>-*`, `<product-b>-*`, whatever the user has). After the `ls`,
pick the _product family_ whose connector skills apply to THIS build:

**Enumerate every family the `ls` returned before opening any one of them**, then
pick by failure-signature match (step 2 below) — never open just the first family
and stop. Reading only one when several are present silently degrades to
"exactly one family, use it" and lands a wrong-family read in Part B. If you can't
recite the other families the `ls` returned, you skipped this — stop and enumerate.

- **Zero families found** → **nudge the user in the gate summary**:
  "No connector-shaped skills found under `.claude/skills/` — proceeding with
  raw MCP tools only; culprit-PR attribution will be best-effort against
  workspace `git remote` guesses. Add a `<product>-github` / `<product>-infra`
  skill for higher-fidelity routing." Then proceed with raw connectors. **Do
  NOT block.**
- **Exactly one family** → use it. No question.
- **Multiple families** (e.g. `<product-a>-*` AND `<product-b>-*` …) → try to
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
     question as any other non-assumable field, e.g. _"Multiple product families
     found (`<product-a>`, `<product-b>`); build/failure signatures don't
     uniquely pick one — which family owns this build's failures?"_ Headless:
     pick the first alphabetically and record the ambiguity as a gap.

Then enumerate every connector relevant to test RCA:

- from `config/rca.config.json` → `evidenceRouting`: **github**
  (product_code/deploy/ci), **infra** (whatever runtime the user has — k8s,
  ECS, docker, Nomad, plain VMs, PM2, …), **logs** (kibana or any log store),
  **metrics**, **other**;
- plus any connector-shaped skills / MCP servers present in the session
  (a log-search MCP, a metrics MCP, an infra skill, …).

**Validate** each with a cheap probe — discovery alone is not enough. **Every
row below is independent of every other row — fire them all as one batch of
parallel tool calls, never one connector at a time.** A probe failing (or
being absent) never blocks another connector's probe from running.

- **REQUIRED before your first probe Bash call:** write out the full list of
  every probe you are about to run this pass — every base probe, every scope
  probe, every target — one line each. Then issue every item on that list as
  its own tool-call block **in this one message**.
- **If a message you are about to send contains exactly one Bash call for a
  probe, and your list above still has unissued items with no dependency on
  that call's result — STOP.** Add the rest of the list to it before sending.
- The only real dependency is per-connector: a connector's scope probes wait
  on that SAME connector's base probe, nothing else. Two different
  connectors' probes never wait on each other, ever.

| Connector | Probe                                                                                                                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| github    | `gh auth status` (or a GitHub MCP tool listed)                                                                                                                                                                                                                                              |
| infra     | ANY runtime connector the user has — probe what exists, never assume one: `kubectl version --request-timeout=5s`, `docker ps`, `aws ecs list-clusters`, `nomad status`, `pm2 ls`, or an infra-shaped skill/MCP tool. Record the KIND in the manifest (`via: kubectl \| docker \| ecs \| …`) |
| logs      | a log-search skill/MCP tool actually listed in the session                                                                                                                                                                                                                                  |
| metrics   | a metrics skill/MCP tool actually listed in the session                                                                                                                                                                                                                                     |
| other     | best-effort; default `absent`                                                                                                                                                                                                                                                               |

**Scope validation — run the SCOPE PROBES declared by each connector skill.**
The base probe above (`gh auth status`, `kubectl version`, …) only confirms the
raw tool works. It does not confirm the _concrete targets_ a coordinator will
touch — specific repos, branches, clusters, namespaces, indices — are actually
reachable. That is the connector SKILL's job: each connector skill MUST
declare, in its `Capability declaration` section, a `Scope probes:` list
naming what to check and how. This orchestrator's contract is generic:

1. For every connector skill added to the manifest in Step 0, read its
   `Scope probes:` list.
2. **Run every declared probe, across every connector and every target it
   names, together in one batch — the same rule as the base probes above.**
   The only real ordering constraint is *within* a single connector: its scope
   probes are only worth running once that same connector's base probe has
   passed (no point checking which repos github can reach if `gh auth status`
   already failed). That is a per-connector dependency, not a global one —
   e.g. github's repo-scope probes and infra's namespace-scope probes never
   depend on each other, so they still fire in the same batch as soon as
   their respective base probes clear. Never run one connector's scope
   probes, wait for them, then move to the next connector's.
3. Record every target's result in the manifest entry — passes go into a
   resolved-scope field (e.g. `repos_validated: [...]`, `namespace: ok`),
   failures go into a per-target gap (e.g. `<target>: 404 not_accessible`).
4. A per-target failure is a scoped gap, not a connector-wide failure — the
   connector stays `valid` for the targets that did pass.

Coordinators can then act freely inside the resolved scope and must fail
closed outside it. This closes the failure mode where a coordinator degrades
to `unavailable` because the orchestrator didn't confirm the specific target.

**Before your first `listTestIds`/discovery call: confirm you can name every
scope probe you ran and its result, for every connector recorded `valid` in the
manifest.** If a connector is `valid` in the manifest and you cannot name a
single scope-probe result for it, STOP — go back and run its declared list (or,
if it genuinely declares none, the manifest-time warning below is the only
legitimate reason to have nothing to name).

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
- **working branch — resolve in this order:**
  1. `fetchBuildInsights(buildId=<id>)`'s `branch` field, when a build id is
     known and the MCP tool returns one. This is the branch the build actually
     ran on — authoritative, and preferred over any assumption below.
  2. If `fetchBuildInsights` is unavailable, errors, or returns no `branch`
     (older build, field absent), fall back to whatever branch the user
     supplied in their skill invocation args.
  3. Only if neither is available, fall through to the connector's
     intake-defaults, then the current git branch, per the existing order
     below.
- cheap inference (e.g. the automation repo is the cwd if it holds the tests).

**Check the selected connector skill's own intake-defaults section FIRST — before
falling through to inference, and before ever asking.** A connector skill that
declares "Intake defaults for the gate (Part B)" (or equivalent) is telling you
these fields are answerable outright for its product. If the connector's
intake section doesn't resolve a field for THIS build (e.g. its lane table
doesn't match the failure signature at all), that is itself a sign the wrong
family was selected — go back to the enumeration step above before treating
the field as genuinely non-assumable.

**Product-repo corroboration (do NOT skip).** The product repo must plausibly
be the _system under test for THIS build's failures_ — not merely a repo name
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
consolidated question at gate close** — e.g. _"Failures look like `<domain>`;
which repo owns that code? (reply 'none' → I'll RCA without culprit-PR
attribution)."_ Never a second question.

**Before your first `AskUserQuestion` call this pass: write out every field
this run still needs from the user, across every reason it might be
non-assumable, in one list — then ask them as ONE question with multiple parts
if more than one survives.** If you are about to send a second
`AskUserQuestion` call in the same gate pass, STOP — fold its content into the
first question instead. There is no second gate question, ever.
**Headless: skip asking entirely;
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

**First, sweep the state directory** (`lib/state-dir.mjs` → `hardenStateDir(dir)`).
The sweep is cheap and idempotent — run it unconditionally; it never throws,
skipping anything it cannot chmod.

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

## Step 3 — clustering (see `<pluginRoot>/skills/rca-build/references/clustering.md`)

Each cluster gets one **representative** (full multi-turn loop) and `N−1`
**siblings** (pre-seeded one-turn confirm against their own logs). This collapses
the expensive evidence hunt to O(distinct causes) while every test still lands a
per-test RCA. Singleton clusters are just plain per-test loops.

**Clustering comes from the server's failure themes.** When the server has
none, every failed test is simply its own representative (a singleton).

1. Call `getBuildFailureThemes(buildUuid=<build id>)`. If nothing has ever
   been computed for this build, this triggers computation (one POST, same
   call) and polls in-call for `buildThemeWorkflow.status` to reach `SUCCESS`.
   The poll cadence is fixed: **one GET first; a single POST trigger only when
   the build has no themes yet (never re-fired); then GET every 3s up to a 90s
   wall-clock ceiling.** Reaching `SUCCESS` returns `ready: true`; exhausting
   the 90s (or a `FAILED`/`ERROR` status) returns `ready: false`. The call
   never blocks longer than ~90s — so it's safe to await inline.
2. **`ready: true`** → for each entry in `buildThemes`, call
   `listTestsInFailureTheme(buildUuid=<build id>, themeId=<buildFailureThemeId>)`,
   following `nextCursor` until exhausted, to get that theme's member
   testRunIds. Feed rows + the themes result + the per-theme member lists into
   `lib/theme-clustering.mjs` → `clustersFromThemes(rows, themesResult,
   testsByThemeId)` — this is the **preferred path**, since the grouping
   reflects the server's own root-cause analysis rather than a text-signature
   guess, and it never runs the coordinator fan-out N-tests-wide for a build
   with only a handful of distinct causes duplicated across teams. Any failed
   test the server didn't assign to a theme is never dropped — it still gets
   its own singleton cluster.

   **`rows` MUST be `readRows(csvPath)` — the CSV Step 2 already seeded —
   never a `listTestIds` result variable held over from earlier in the turn.**
   The CSV is the one row set guaranteed fresh and from a successful seed
   (Step 2 only seeds after `listTestIds` succeeds) — always re-read it here
   rather than trusting a variable carried over from turns ago.
3. **`ready: false`** (the server genuinely couldn't produce themes — still
   computing past the poll budget, a failure status, or `trigger-unavailable`)
   → call `clustersFromThemes(readRows(csvPath), { buildThemes: [] }, {})`.
   With no themes, every failed test falls through to its own `solo-` cluster —
   i.e. **all tests become representatives**, each running its own full per-test
   loop. No client-side clustering and no local guess; correctness over the cost
   collapse when the server can't group.

`clustersFromThemes` mutates each row's `cluster_id` in place but does NOT
persist — it's pure/dependency-free by design. Write its rows back yourself
with `csvState.writeRows(csvPath, rows)` before fan-out, then verify: **if
`cluster_id` is empty on any row, Step 3 did not take effect** — do not proceed.

## Step 4 — build-evidence pre-fetch (see `<pluginRoot>/skills/rca-build/references/evidence-routing.md` and `<pluginRoot>/lib/evidence-file.mjs`)

Once, after clustering (Step 3) and before fan-out — the capability manifest
already exists from Gate Part A, reuse it, do not re-discover. This step
replaces each coordinator's own turn-1 evidence sweep with ONE pre-fetch:
it does not remove the requirement that turn-1 evidence exists, only _who
gathers it_.

**Narrate this as one combined phase, not two sequential ones.** Step 4b
starts the moment Step 3 finishes and runs the whole time Step 4 does — any
progress line should say `Evidence pre-fetch (Step 4) + turn-1 pre-dispatch
(Step 4b)`, never "Step 4 done, now starting Step 4b."

1. Resolve the evidence-file path: `lib/evidence-file.mjs` →
   `evidencePathFor(buildId, config.paths.stateDir)` —
   `<tmpdir>/bstack-rca/rca-evidence.<buildId>.json`, alongside the state CSV.
   `initEvidenceFile(path, buildId, nowMs)`.
2. **Scope the pre-fetch to the full union, never a single guess:**
   - **Repos** — every repo in Gate Part A's scope-probe-validated
     `repos_validated` list (a build's failures often span several repos —
     validate the full set the connector maps, not one guessed repo).
   - **Workloads** — the union of workloads every cluster's **representative**
     implicates, via the active connector skill's failure-signature→workload
     routing table (never one workload guessed from the first failing test).
3. For each repo: run the connector skill's PR-window-search + deploy-state
   recipes **once**, using `lib/evidence-cache.mjs`'s `compute(repo, range,
evidenceType, fn)` to dedupe if two steps need the same `(repo, range)`.
   Digest the result into the `evidence-block.md` shape, then persist via
   `setCodeEvidence(path, repo, {deployState, prsInWindow, gap}, nowMs)`.
   A repo the connector can't reach records `{gap: "<reason>"}` — never blocks
   the rest of the pre-fetch.

   **Every repo's PR-window search is independent — fire all of them as
   parallel tool calls in ONE message.**

   **`--json` on THIS FIRST `gh pr list` call MUST include `files`.** A
   PR-list call that omits `files` here forces a per-PR `gh pr view --json
   files` backfill loop downstream. `--json files` costs nothing extra on the
   list call.

   ```bash
   gh pr list -R <org>/<repo> --state merged --base <branch> \
     --search 'merged:<from>..<to>' --json number,title,mergedAt,url,files --limit 100
   ```

   Store the paths in each PR's `files` field rather than leaving it `null`:
   path-overlap is the first falsification test in
   `<pluginRoot>/skills/rca-build/references/github-evidence.md`, so with `files` populated a coordinator
   rules a suspect in or out from the evidence file alone, and only fetches a
   diff for the handful that survive. Do NOT pre-fetch diffs — those are large
   and only a few PRs ever need one.

   A per-PR `gh pr view --json files` call is legitimate ONLY for a suspect
   PR discovered later (during a coordinator's own investigation, not in this
   pre-fetch's window) — never as a backfill for a PR-list call that should
   have carried `files` the first time.

   - **Never let coordinators re-probe connectors.** State plainly in the
     dispatch prompt that the gate validated them.
   - **Do NOT bulk-fetch file contents.** The `files` lists above tell a
     coordinator exactly which files matter, and the tool cache dedupes the
     ones two coordinators both open.
4. For each workload: run the connector skill's compulsory kubectl +
   VictoriaLogs sweep **once**, anchored to the build's own clock — never
   "now". **Batch all workload sweeps together with repo fetches from step 3.**
   **PAD the window: `started_at − 2m` .. `finished_at + 10m`.** Label every
   finding with whether it falls inside or outside the strict window so a
   coordinator can weigh it; do NOT silently widen to an arbitrary window.
   Persist via `setLogsEvidence(path, workload,
{clusterIds, kubectlSweep, victorialogs, gap}, nowMs)`.

   Two query mechanics that cost real calls when missed:
   - **`direction` defaults to newest-first**, so a limited query always
     returns the END of the window. To find when something _started_ — the
     first request after a gap, the onset of an error burst — pass
     `direction: "forward"`. A gap "confirmed" from a backward query is not
     confirmed at all; it is just the tail of the range.
   - **Absence needs a control.** A zero-result query is indistinguishable
     from a wrong selector. Before reporting "no traffic", prove the logger
     was alive in the same window with a query you expect to be non-empty
     (e.g. readiness probes from a named pod). Only then is silence evidence.

5. `resolveBaseline(lastGreenRef, fallbackRef)` (from `lib/evidence-cache.mjs`)
   → `setBaseline(path, baseline, suspectWindow, nowMs)`. No "last green"
   baseline (never-green suite) → fall back to a configured baseline ref and
   note the weaker grounding — this note travels into the file, not just a
   spoken log line, so every coordinator sees it.
6. **Resolve local clones ONCE** (`lib/repo-source.mjs`). File *contents* are
   the largest remaining slice of github traffic, and most of it can be served
   with no network at all when the machine already has the repos checked
   out — a local `git show` returns the same bytes as `gh api` far faster,
   with no round trip.

   ```js
   const d = discoverWorkspaceRoot({ repos: reposValidated, from: pluginRoot });
   const { pins } = deployShas(path);          // structured, not prose
   const localRepos = d.root
     ? resolveLocalRepos({ repos: reposValidated, pins, workspaceRoot: d.root })
     : {};
   setLocalRepos(path, { workspaceRoot: d.root, repos: localRepos }, nowMs);
   ```

   `discoverWorkspaceRoot` takes the **validated repo list** and accepts a
   candidate directory only if it actually contains one of *this run's* repos,
   bounded to ~3 tries. Finding nothing is fine: every read falls back to the
   cached `gh` path.

   Set `deployState.sha` explicitly when you write each repo's entry.
   `deployShas()` falls back to parsing prose `summary`, but that is a
   safety net, not the contract.

   `pins` must be the **build-time commit shas** from `deployState`, never
   branch names — a local branch may be stale.

   Doing this at the gate is the point: every coordinator then reads a map
   instead of probing the filesystem itself.
7. `recomputeCoverage(path, {repos, workloads}, nowMs)` and declare the
   resulting path in the gate summary alongside the capability manifest, so
   a human re-reading the run can find it.

**Size discipline is enforced at write time, not just at submit time.** Every
leaf (`deployState`, each PR, each log sweep) must already be a digested
`block` per `evidence-routing.md`'s caps (`SUMMARY≤400`, `SNIPPET≤20/40 lines`,
link over diff) — never a raw dump. Cap `prsInWindow` to the top ~30 candidates
by path-overlap relevance, not every PR in the window.

Pass `evidencePathFor(...)`'s path to Step 5's fan-out as `evidenceFilePath` —
every dispatch (representative and sibling) must be told to read it first.

## Step 4b — turn-1 pre-dispatch (fire-and-forget, fully async alongside Step 4)

Every cluster's representative testRunId is already known the moment Step 3
finishes. Turn 1's message has no dependency on Step 4's evidence pre-fetch —
it is built entirely from Step 2's CSV seed (`error_summary`/`testName`). So
there is no need to wait for Step 4 before starting Step 4b, or to wait for
Step 4b before moving on.

**Mechanic: dispatch, don't wait.** For every cluster representative, launch
one lightweight subagent via the Agent tool whose ONLY job is to call
`tfaRcaTurn(testRunId=<rep>, message=<first-turn digest>)` once and emit one
fixed-shape block as its final output — no evidence gathering, no loop, no
drain. This is deliberately **not** a full `ai-tfa-coordinator` dispatch (that
agent's whole design is the multi-turn evidence-gathering loop, far more
machinery than "submit one message and return"); write a minimal,
purpose-built inline prompt for this instead, and put the exact output
contract below directly in that prompt — an Agent-tool result is free text,
and with many of these dispatched concurrently the orchestrator has no other
reliable way to tell which representative a given notification is even for.

```
TURN1_OUTPUT_START
testRunId: <the testRunId this subagent was given>
status: RESOLVED | NEEDS_INFO | PENDING
threadId: <threadId from the tfaRcaTurn response, or "none">
turnId: <turnId — PENDING only, tfaRcaTurn never returns one for the other two statuses; else "none">
glimpse: <RESOLVED only — the trimmed {root_cause, failure_type, related_prs, confidence, viewRca} object, verbatim; else "none">
asks: <NEEDS_INFO only — the asks array, verbatim; else "none">
TURN1_OUTPUT_END
```

That block — not prose, not a summary — is this subagent's entire final
message. It is exactly what the orchestrator reads back off the
task-notification to do the bookkeeping below: `status` selects the branch,
`testRunId` is the join key back to the right CSV row / registry entry, and
`threadId`/`turnId`/`glimpse`/`asks` are pasted straight into `flip()` or
`recordTurn1()` with no re-interpretation needed.

Agent-tool dispatches return immediately (fire-and-forget). Fire off every
representative's dispatch together, then **immediately proceed to Step 4's
evidence pre-fetch — do not wait for any of them.**

As each subagent finishes — on its own schedule, bounded only by
`tfaRcaTurn`'s own ~90s in-call poll cap, so realistically within the first
minute or two of the run — a task-notification carrying its `TURN1_OUTPUT`
block arrives, interleaved with whichever Step 4 turn happens to be in flight
at that moment. Handle each one the moment you are next free to, as pure
bookkeeping — no new tool calls needed for this part:

1. `initTurn1Registry(turn1PathFor(buildId, config.paths.stateDir), buildId, nowMs)`
   once, before dispatching any turn 1s (`lib/turn1-registry.mjs`).
2. **Skip any representative whose CSV row already has a `threadId` +
   `turnId`** (a `pending-resume` row from a prior run attempt — an already
   in-flight thread). Dispatching a fresh turn 1 for it would start a SECOND
   thread for the same test, which every other part of this contract
   (`agents/ai-tfa-coordinator.md`'s "one thread per test" hard limit) forbids.
   That representative resumes its existing thread at Step 5 exactly as
   before Step 4b existed — Step 4b only ever applies to a representative with
   no prior thread at all.
3. For every remaining (thread-less) cluster representative, dispatch its
   turn-1 subagent. When its result notification lands, branch on it:
   - **RESOLVED** → `flip()` this CSV row straight to terminal, right here —
     same fields a coordinator's `RCA_OUTPUT` would set (`rca_done: resolved`,
     `root_cause`, `failure_type`, `related_prs`, `view_rca`, `confidence`,
     `turns_used: 1`, `threadId`). This representative needs **no Step 5
     dispatch at all** — the cheapest possible outcome. **Do not wait for
     Step 5 to formally start: dispatch this cluster's siblings immediately,
     right here in Step 4b** — as their own fire-and-forget Agent-tool
     dispatches too, same principle, don't wait on them either — via
     `siblingPreSeed(csvPath, csvState, clusterId, representativeId)` against
     the row you just flipped. A sibling only ever needs its OWN
     representative's result, never the state of any other cluster, so
     nothing about Step 5's fan-out has to begin first. This is the ONLY case
     a sibling can be dispatched this early, and the reason is narrow: it
     works because the representative resolved in ONE pre-dispatched turn, so
     `pre_seed` is already real evidence, not a guess. A representative still
     mid-loop (`NEEDS_INFO`/`PENDING`) has no `root_cause` yet — dispatching
     that cluster's siblings before it lands would degrade every one of them
     into a full independent investigation, at real representative-level cost
     instead of a cheap one-turn confirm (see Step 5's sibling-ordering note).
     Never do that; siblings of a not-yet-resolved representative wait for
     Step 5 exactly as documented there.
   - **NEEDS_INFO** → `recordTurn1(path, testRunId, {status: "NEEDS_INFO",
     threadId, asks}, nowMs)`. A real, non-terminal answer — hand it to Step
     5's coordinator as `turn1_result` (never resubmit turn 1).
   - **PENDING** → `recordTurn1(path, testRunId, {status: "PENDING", threadId,
     turnId}, nowMs)`. Do **not** drain it here — there is no reason to spend
     any of the orchestrator's own time on it. Step 5's coordinator dispatch
     already knows how to drain a soft-PENDING (the existing `resume` input
     covers this case as-is).
4. Nothing about this starts a second thread: it is exactly turn 1 of the one
   thread the Step 5 coordinator continues from `threadId`.
5. **A subagent that never reports back fails open, not closed.** Step 5's
   `readTurn1` returns nothing → Step 5 falls back to a fresh dispatch
   (submit turn 1 from scratch, no `resume`/`turn1_result`). If the dead
   subagent did reach `tfaRcaTurn`, that thread is orphaned — not a
   correctness problem, just one wasted thread per failure.

**Dispatch at most `concurrency` (from `config/rca.config.json`) turn-1
subagents at a time.** For a build with more cluster representatives than that,
issue the first `concurrency` immediately, then issue the next batch as soon
as they're dispatched (still fire-and-forget, still never blocking Step 4's
own progress).

**The very first turn can contain Step 4b's setup-and-first-dispatch-batch
together with Step 4's own first evidence-gathering calls, in the same batch.**

Pass `turn1PathFor(...)`'s path to Step 5 alongside `evidenceFilePath` — Step 5
must read it (`readTurn1(path, testRunId)`) before building each
representative's dispatch and translate the result into the matching input:
`PENDING` → `resume: {threadId, turnId}`; `NEEDS_INFO` → `turn1_result:
{threadId, asks}`; a flipped-to-terminal row (no registry entry, CSV already
`resolved`) → no dispatch, use the CSV row's result directly as this cluster's
representative outcome for seeding siblings.

## Step 5 — fan-out (fully autonomous)

**REQUIRED gate before your first Step 5 dispatch: Step 4b's dispatch batch
must have already been ISSUED this pass — not completed, not waited on,
issued.** **If you are about to issue Step 5's representative dispatches and
cannot point to this pass's `initTurn1Registry` call and a turn-1 dispatch
batch issued for every thread-less cluster representative, STOP — go back and
fire that dispatch batch first.** This is NOT a "wait for Step 4b's subagents
to finish" gate — it only catches the case where Step 4b never happened at
all.

**ORDER MATTERS: representative first, siblings only after it lands.** For each
cluster, dispatch the representative, wait for its row to go terminal, then
dispatch its siblings carrying `pre_seed` from
`siblingPreSeed(csvPath, csvState, clusterId, representativeId)`. Clusters are
independent, so they still run concurrently *with each other* — the barrier is
per cluster, not global.

`siblingPreSeed` returns `{ok:false, reason}` when the representative is not
resolved or recorded no `root_cause` — **do not dispatch that sibling yet**.
Never hand-roll the seed: without this guard, siblings degenerate into full
independent investigations at representative-level cost.

Drive the cluster work-list, **`concurrency` (default 20) at a time**:
representatives deep, siblings one-turn-confirm. Eagerly persist to the CSV/WAL
(claim → heartbeat → flip) so the run is resumable.

**"Per cluster, not global" is a rolling work-queue, not two rigid phases.**
Do NOT dispatch "all representatives first, then all siblings" as two fixed
mega-batches — that reintroduces a global-ish wait: any cluster's siblings
would sit idle until every representative in the current batch lands, not just
their own. Instead, whenever a batch of dispatches returns, immediately refill
the next batch by mixing (a) siblings of whichever representatives just
resolved (via `siblingPreSeed`) with (b) any not-yet-dispatched representatives
from other clusters, up to `concurrency` slots — so a fast cluster's siblings
enter the very next batch instead of waiting out an unrelated slow
representative.

This distinction matters differently on each path:
- **Opt-in `workflows/rca-batch.mjs`** achieves this structurally, for free:
  `pipeline(clusters, repStage, siblingStage)` has NO barrier between stages —
  a cluster's siblings start the instant ITS OWN representative resolves,
  fully interleaved with every other cluster's progress. Nothing to get wrong
  here.
- **Default direct Agent-tool dispatch** cannot be sub-batch-streaming the same
  way, because a single assistant turn's parallel tool calls are a real
  synchronization point: the orchestrator does not regain control until every
  call in that turn's batch has returned. So within any one batch, a cluster
  whose representative resolves early still cannot dispatch its siblings until
  the WHOLE batch drains — the rolling-refill discipline above is what keeps
  that batch-local wait from becoming a build-wide one, but it cannot eliminate
  it entirely. **When cluster count exceeds `concurrency`, or when the
  Workflow tool is available, prefer `workflows/rca-batch.mjs`** for
  latency-sensitive builds — it is the only path with a true per-cluster (not
  per-batch) guarantee.

> **Concurrency comes from `config/rca.config.json` — always read it from
> there, never hardcode.** The default path (direct Agent-tool dispatch) honors
> the JSON value literally (batches of `concurrency`, one message per batch).
> The opt-in `workflows/rca-batch.mjs` path caps it lower (see that bullet
> below); if you need literal fan-out, use the default path.

- **Default (all hosts, including Claude Code) → direct Agent-tool dispatch.**
  Read `concurrency` from `config/rca.config.json` and dispatch
  `tfa-rca:ai-tfa-coordinator` subagents in batches of that size (one message,
  up to `concurrency` tool-use blocks per batch), refilling each next batch per
  the rolling work-queue discipline above — never two rigid all-reps /
  all-siblings phases. Outside the Workflow runtime, so the JSON value is
  honored literally; but it streams per-BATCH, not per-cluster — prefer
  `workflows/rca-batch.mjs` whenever cluster count exceeds `concurrency` and
  the Workflow tool is available.

  **This path has no code enforcing the Step 4b handoff — you are the
  enforcement.** Unlike `workflows/rca-batch.mjs` (which reads the registry in
  code via `turn1Line()`) and `lib/loop.mjs` (which takes `turn1Result` as a
  structural parameter), building a representative's dispatch prompt here is
  entirely on you. **Before dispatching ANY representative, call
  `readTurn1(turn1PathFor(buildId, stateDir), testRunId)` and fold the result
  into the prompt using this exact mapping — the two are distinct coordinator
  inputs (`agents/ai-tfa-coordinator.md`), never interchangeable:**
  `PENDING` → `resume: {threadId, turnId}`; `NEEDS_INFO` → `turn1_result:
  {threadId, asks}`; no registry entry with the CSV row already `resolved` →
  skip the dispatch entirely, use the CSV row's result directly. Do NOT fold a
  `NEEDS_INFO` result into a `resume` field, or vice versa — a coordinator
  reads these as two different shapes and a swapped one is silently wrong, not
  rejected. Omit this translation altogether and Step 4b's pre-dispatch is
  silently wasted: the coordinator submits turn 1 again on a brand-new thread,
  abandoning the one Step 4b already started (not incorrect — the run still
  resolves — just the entire latency win thrown away without any error to
  notice it by).
- Opt-in `workflows/rca-batch.mjs` (Claude Code only) → use only when the
  Workflow tool's structured `pipeline()`/`parallel()` orchestration,
  `resumeFromRunId` resumability, or progress UI is worth the concurrency
  trade.
- Hosts without the Workflow runtime and without Agent-tool fan-out → drive
  the sequential harness `lib/loop.mjs` (`runRcaLoop`) one test at a time.
  Same contract, same no-prompt rule.

Subagents/coordinators return compact `RCA_OUTPUT` blocks, never transcripts. A
coordinator that dies becomes a recorded `failed` row — one stuck test never
sinks the batch (partial-first). No path ever prompts the user (the gate is
closed).

**Coordinator prompts MUST carry `pluginRoot` and use it to fully qualify every
reference-doc / lib path.** A coordinator is dispatched fresh with no guarantee
about its cwd. Every dispatch prompt must state `pluginRoot=<absolute path>` up
front and every reference-doc pointer must be `pluginRoot`-qualified — never a
bare `references/<file>.md`.

**Coordinator prompts MUST also point at the API reference instead of letting
the coordinator re-derive it.** State plainly in the dispatch prompt: "Function
signatures for `lib/*.mjs` are documented at `<pluginRoot>/skills/rca-build/SKILL.md`
§ API reference — read that section once if a signature is needed; do not
`grep`/`Read`/`cat` the `lib/` source to re-derive a signature already
documented there."

**Coordinator prompts MUST name every connector-shaped skill on the manifest.**
Each dispatch prompt lists, per capability, the resolved connector skill from
Gate Part A Step 0 — e.g. _"Use `<resolved-github-skill>` for every
product_code / deploy / ci ask. Use `<resolved-infra-skill>` for every infra
ask."_ Omitting a manifest-listed connector lets the coordinator infer repos
from workspace `git remote` or cwd, landing wrong PR attributions.

**Coordinator prompts MUST also name the Step 4 evidence file.** Every
dispatch prompt (representative and sibling alike) includes the absolute
`evidenceFilePath` from Step 4 with the instruction: _"Read `<path>` (via the
Read tool) before making any live github/infra/logs gather call. It's a
pre-fetch, not a hard dependency — a repo/workload it doesn't name, or marks
with a `gap`, is a genuine gap: fall back to the capability manifest above
exactly as if no file existed."_ For a sibling, add: _"The file's data about
your OWN test's workload is real evidence, not inheritance — reading it is
fine. What must stay independent is the CONFIRMATION judgment: never adopt the
representative's verdict just because the file already has the answer in
it."_ A dispatch prompt that omits this path forces its coordinator back into
a full independent sweep — exactly the redundancy Step 4 exists to remove.

**The file is read-write, not just read-only.** When a coordinator has to
gather live (a genuine gap), tell it to write the result back —
`contributeCodeEvidence`/`contributeLogsEvidence` (`lib/evidence-file.mjs`),
passing its own `testRunId` as `writerId` — before finishing, not just answer
TFA and move on. A representative's deep dive (a full diff, a downstream
trace, a PR the pre-fetch never named) then benefits its own siblings and any
other cluster sharing the same repo/workload, instead of every one of them
re-running the same live search. This is already baked into
`agents/ai-tfa-coordinator.md`'s Operating Principle 0 for any dispatch of
that agent type — no need to repeat the mechanics in the prompt, just don't
omit `evidenceFilePath` (above), since write-back has nothing to write to
without it.

**Pre-seed the MCP cache with the queries you just ran.** Step 4's log sweeps
are MCP calls, and a coordinator will often want the same ones. Deposit each
result under the key it would compute — `mcpCacheKey(tool, args)` then
`cachePut(toolCacheDirFor(buildId), key, {…, writerId: "orchestrator"}, nowMs)`
from `lib/tool-cache.mjs` — storing the DIGEST, not the raw rows.

Store the same digest you put in the evidence file; the two are complementary
(the file is read wholesale at turn 1, the cache answers a specific repeat
query later).

**Also hand every dispatch the tool cache.** Include the plugin root in each
dispatch prompt so coordinators can invoke `bin/cached-exec.mjs` /
`bin/cached-mcp.mjs`, and tell them to pass their own `testRunId` as
`writerId`. The cache lives at `<tmpdir>/bstack-rca/rca-toolcache.<buildId>/`,
one file per call key, shared by shell and MCP alike. Read
`node bin/cached-exec.mjs <buildId> --stats` at the end of the run to report
cache savings.

**Concurrency is handled by layout, not by locking.** Base
(`rca-evidence.<buildId>.json`) has exactly one writer — this orchestrator, in
Step 4. Every coordinator writes only its own shard under
`rca-evidence.<buildId>.contrib/<testRunId>.json`. `readEvidenceFile` folds
base + all shards into one view, applying shards in sorted order, with real
evidence taking precedence over a recorded `gap`.

**Application bugs need a culprit PR.** Whenever a test's RCA classifies as
PRODUCT_BUG / application bug, the coordinator MUST hunt the culprit PR via the
github connector (deploy timeline vs last-pass window, changed paths vs failure
signature — `<pluginRoot>/skills/rca-build/references/github-evidence.md`) and feed the PR link(s) to TFA in
the turn message so the dashboard RCA's `related_prs` populates. An
application-bug RCA with no GitHub PR link is **incomplete**: keep digging until
the turn cap; if still none, the turn must explicitly state "no culprit PR
identified after <what was searched>" and the CSV row records the gap.

## Step 6 — finish: glimpse + dashboard report (NO local report)

This plugin **never renders or writes a local RCA report, and never surfaces RCA
detail in Claude.** The in-Claude output is a two-line completion notice plus the
link — that is all. When every row is terminal:

1. Print a one-line **completion summary** by counting the CSV's terminal
   states: `RCA analysis complete — build <id>` + `<N> tests · <R> resolved ·
   <P> pending · <F> failed`. **Nothing per-test.**
2. Call **`triggerRcaReport(buildUuid=<build id>, force=true)`** — **always pass
   `force=true`; never `force=false` in any case.** Forcing regenerates the
   release-readiness report from the RCAs completed so far, so the report is
   produced for this run's actual analysis even when only a subset of tests
   reached terminal RCA — instead of returning a stale/empty cached report or
   blocking on a bulk re-trigger of every test's RCA.
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
- Never call `tfaRcaTurn` from this skill — always via the `ai-tfa-coordinator` —
  **except Step 4b's turn-1 pre-dispatch**, which is a deliberate, narrow carve-out
  (one direct call per cluster representative, concurrent with Step 4, never a
  follow-up turn) documented there. Every OTHER `tfaRcaTurn` call — every turn
  past 1, and every sibling's turn 1 — still goes exclusively through a
  dispatched coordinator.
- A soft-`PENDING` is never an answer: it must be drained with
  `getTfaTurnResult(testRunId, turnId)` before any further submit on that thread.
  Only a spent drain budget may end a test `PENDING`.
- Every failed test must end terminal in the CSV — partial-first, no abort-on-one-failure.
- Never gather `test_logs` — TFA owns logs.
- Never render/write a local RCA report — glimpse table + `triggerRcaReport` +
  the Test Observability UI link only.
- A PRODUCT_BUG RCA without a GitHub PR link is incomplete — dig until the turn
  cap, else state what was searched and record the gap.
- Step 4's first `gh pr list` call per repo MUST include `files` in `--json` —
  never split into a plain list followed by a per-PR `gh pr view --json files`
  backfill loop.
- Every reference-doc / `lib/` path handed to a coordinator (in the dispatch
  prompt or in `agents/ai-tfa-coordinator.md`) MUST be `pluginRoot`-qualified
  (`<pluginRoot>/skills/rca-build/references/<file>.md`) — never a bare
  `references/<file>.md`, which resolves against an unknown coordinator cwd.
