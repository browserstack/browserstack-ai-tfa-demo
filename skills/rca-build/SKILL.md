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
# cwd, the WORKSPACE ROOT above it, and the user dir. The middle one matters:
# when this plugin is itself a repo inside the workspace, cwd is the plugin and
# the product's connector skills sit one or two levels UP, so a bare
# `ls .claude/skills/` finds nothing and the run silently degrades to raw MCP
# tools with best-effort repo guesses. Measured: it missed all three real
# connectors on this workspace.
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
pick the *product family* whose connector skills apply to THIS build:

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
  question as any other non-assumable field, e.g. *"Multiple product families
  found (`<product-a>`, `<product-b>`); build/failure signatures don't
  uniquely pick one — which family owns this build's failures?"* Headless:
  pick the first alphabetically and record the ambiguity as a gap.

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

**First, sweep the state directory** (`lib/state-dir.mjs` → `hardenStateDir(dir)`).
Per-write hardening only tightens the file being written, so artifacts from a
build analysed before that landed keep their old permissions forever — a
completed build is never rewritten. Found in practice: the directory itself was
`drwxr-xr-x` with six `0644` files inside, holding root causes, culprit PRs and
log excerpts in a shared OS temp dir. The sweep is cheap and idempotent, so run
it unconditionally; it never throws, skipping anything it cannot chmod.

Nothing deletes these artifacts when a run finishes, and that is deliberate —
resume is keyed on `buildId` → same path, so cleaning up on completion would
break `pending-resume`. `pruneStateDir(dir, nowMs)` exists for growth (default
7 days, far longer than any run) but is **not** automatic: these files *are* the
resume state. Call it explicitly, with `dryRun: true` first.

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

Use **`clusterAndPersist(csvPath, csvStateModule)`** (`lib/signature.mjs`), not
`clusterRows` directly:

```js
const clusters = clusterAndPersist(csvPath, await import("./lib/csv-state.mjs"));
```

`clusterRows` assigns `cluster_id` **in place** and returns `{rows, clusters}`,
so `const { clusters } = clusterRows(rows)` gives you working cluster objects
while every `cluster_id` is silently discarded — the CSV keeps empty cluster
columns and the run degrades to **one coordinator per test**, losing the whole
representative/sibling collapse. That is measured, not theoretical: a real run
went 12 tests → 26 subagents and 30 minutes with the clustering "done" but
never written. `clusterAndPersist` writes back and verifies the count, so it
cannot forget.

Then verify before fan-out: **if `cluster_id` is empty on any row, Step 3 did
not take effect** — do not proceed, the run would silently cost O(tests)
instead of O(causes).

Compute a failure signature per row and assign `cluster_id` (`lib/signature.mjs`).
Each cluster gets one **representative** (full multi-turn loop) and `N−1`
**siblings** (pre-seeded one-turn confirm against their own logs). This collapses
the expensive evidence hunt to O(distinct causes) while every test still lands a
per-test RCA. Singleton clusters are just plain per-test loops.

## Step 4 — build-evidence pre-fetch (see references/evidence-routing.md and lib/evidence-file.mjs)

Once, after clustering (Step 3) and before fan-out — the capability manifest
already exists from Gate Part A, reuse it, do not re-discover. This step
replaces each coordinator's own turn-1 evidence sweep with ONE pre-fetch:
it does not remove the requirement that turn-1 evidence exists, only *who
gathers it*.

1. Resolve the evidence-file path: `lib/evidence-file.mjs` →
   `evidencePathFor(buildId, config.paths.stateDir)` —
   `<tmpdir>/bstack-rca/rca-evidence.<buildId>.json`, alongside the state CSV.
   `initEvidenceFile(path, buildId, nowMs)`.
2. **Scope the pre-fetch to the full union, never a single guess:**
   - **Repos** — every repo in Gate Part A's scope-probe-validated
     `repos_validated` list (e.g. a VRT-lane build validates `frontend` +
     `railsApp`; an nl2steps build validates `misc-services` + `ai-sdk-node`).
   - **Workloads** — the union of workloads every cluster's **representative**
     implicates, via the active connector skill's failure-signature→workload
     routing table (never one workload guessed from the first failing test).
3. For each repo: run the connector skill's PR-window-search + deploy-state
   recipes **once**, using `lib/evidence-cache.mjs`'s `compute(repo, range,
   evidenceType, fn)` to dedupe if two steps need the same `(repo, range)`.
   Digest the result into the `evidence-block.md` shape, then persist via
   `setGithubEvidence(path, repo, {deployState, prsInWindow, gap}, nowMs)`.
   A repo the connector can't reach records `{gap: "<reason>"}` — never blocks
   the rest of the pre-fetch.

   **Ask for `files` in the PR-list call — it costs nothing extra and is the
   single highest-leverage thing in this step:**

   ```bash
   gh pr list -R <org>/<repo> --state merged --base <branch> \
     --search 'merged:<from>..<to>' --json number,title,mergedAt,url,files --limit 100
   ```

   `--json files` returns every PR's changed paths in the SAME call, so one
   request per repo replaces one `gh pr view <n> --json files` per PR across
   every coordinator. Measured across three real runs, per-PR file-list
   fetches were **44 of 407 gh calls (10.8%)** — all of them avoidable here.
   Store the paths in each PR's `files` field rather than leaving it `null`:
   path-overlap is the first falsification test in
   `references/github-evidence.md`, so with `files` populated a coordinator
   rules a suspect in or out from the evidence file alone, and only fetches a
   diff for the handful that survive. Do NOT pre-fetch diffs — those are large
   and only a few PRs ever need one.

   Two other measured wastes this step should pre-empt:
   - **Never let coordinators re-probe connectors.** `gh auth status` /
     `kubectl version` accounted for **17 of 407 gh calls (4.2%)** purely
     because the manifest wasn't trusted. State plainly in the dispatch prompt
     that the gate validated them.
   - **File contents were 31% of gh traffic** and are only partly predictable,
     so do NOT bulk-fetch them. The `files` lists above tell a coordinator
     exactly which files matter, and the tool cache dedupes the ones two
     coordinators both open.
4. For each workload: run the connector skill's compulsory kubectl +
   VictoriaLogs sweep **once**, anchored to the build's own clock — never
   "now". **PAD the window: `started_at − 2m` .. `finished_at + 10m`.**
   `finished_at` is when the build was *marked* finished, which is not when
   the failing behaviour stopped: on one real build an upstream outage began
   at 06:12:00 and ran to 06:15:51, while `finished_at` was 06:12:21 — a
   sweep scoped strictly to `started_at..finished_at` saw 21 seconds of a
   4-minute outage and would have missed the cause entirely. Label every
   finding with whether it falls inside or outside the strict window so a
   coordinator can weigh it; do NOT silently widen to an arbitrary window
   (that is the separate, opposite failure of matching a coincidence from
   unrelated traffic). Persist via `setLogsEvidence(path, workload,
   {clusterIds, kubectlSweep, victorialogs, gap}, nowMs)`.

   Two query mechanics that cost real calls when missed:
   - **`direction` defaults to newest-first**, so a limited query always
     returns the END of the window. To find when something *started* — the
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
   the largest remaining slice of github traffic (31%), and most of it can be
   served with no network at all when the machine already has the repos
   checked out — measured `git show` ~37ms vs `gh api` ~1022ms for the same
   file, byte-identical.

   ```js
   const d = discoverWorkspaceRoot({ repos: reposValidated, from: pluginRoot });
   const { pins } = deployShas(path);          // structured, not prose
   const localRepos = d.root
     ? resolveLocalRepos({ repos: reposValidated, pins, workspaceRoot: d.root })
     : {};
   setLocalRepos(path, { workspaceRoot: d.root, repos: localRepos }, nowMs);
   ```

   `discoverWorkspaceRoot` takes the **validated repo list** and accepts a
   candidate directory only if it actually contains one of *this run's* repos —
   that check is what keeps the plugin generic, and it is bounded to ~3 tries
   because guessing harder risks reading an unrelated checkout, which is
   silently wrong rather than merely slow. Finding nothing is a fine outcome:
   every read falls back to the cached `gh` path.

   Set `deployState.sha` explicitly when you write each repo's entry.
   `deployShas()` falls back to parsing the prose `summary`, but that is a
   safety net, not the contract: when the wording drifts it returns an empty
   map, and every read silently degrades to the network while still looking
   like it worked.

   `pins` must be the **build-time commit shas** from `deployState`, never
   branch names. A developer's clone is routinely stale (12 commits, measured),
   and reading a branch locally returned different bytes than the real head —
   for RCA that is a confident wrong answer about code that never shipped.

   Doing this at the gate is the point: every coordinator then reads a map
   instead of probing the filesystem itself.
7. `recomputeCoverage(path, {repos, workloads}, nowMs)` and declare the
   resulting path in the gate summary alongside the capability manifest, so
   a human re-reading the run can find it.

**Size discipline is enforced at write time, not just at submit time.** Every
leaf (`deployState`, each PR, each log sweep) must already be a digested
`block` per `evidence-routing.md`'s caps (`SUMMARY≤80`, `SNIPPET≤4/8 lines`,
link over diff) — never a raw dump. Cap `prsInWindow` to the top ~30 candidates
by path-overlap relevance, not every PR in the window.

Pass `evidencePathFor(...)`'s path to Step 5's fan-out as `evidenceFilePath` —
every dispatch (representative and sibling) must be told to read it first.

## Step 5 — fan-out (fully autonomous)

**ORDER MATTERS: representative first, siblings only after it lands.** For each
cluster, dispatch the representative, wait for its row to go terminal, then
dispatch its siblings carrying `pre_seed` from
`siblingPreSeed(csvPath, csvState, clusterId, representativeId)`. Clusters are
independent, so they still run concurrently *with each other* — the barrier is
per cluster, not global.

A sibling is only cheap because it confirms a hypothesis someone else already
established. Dispatch one without that hypothesis and "one-turn confirm"
degenerates into a full independent investigation *with the sibling framing on
top*, so it costs MORE than the representative it was meant to be a fraction of.
Measured on a real run: siblings averaged **22.7 tool calls and 2.2 turns**
against **8.0 and 2.0** for the representative, and one burned **60 calls over
17 minutes**. Nothing ordered them after their rep and nothing refused to
dispatch without a seed, so it degraded silently.

`siblingPreSeed` returns `{ok:false, reason}` when the representative is not
resolved or recorded no `root_cause` — **do not dispatch that sibling yet**.
Never hand-roll the seed: the guard is the only thing standing between a
clustered run and O(tests) cost.

Drive the cluster work-list, **`concurrency` (default 20) at a time**:
representatives deep, siblings one-turn-confirm. Eagerly persist to the CSV/WAL
(claim → heartbeat → flip) so the run is resumable.

> **Concurrency comes from `config/rca.config.json` — always read it from
> there, never hardcode.** The default path (direct Agent-tool dispatch) honors
> the JSON value literally: fan out coordinator subagents in batches of
> `concurrency` (one message, up to `concurrency` tool-use blocks per batch).
> The opt-in `workflows/rca-batch.mjs` path is subject to the Workflow tool's
> architectural cap of `min(16, cpu cores - 2)` — on that path `concurrency`
> is a soft upper bound and excess work queues rather than running N-wide.
> If you need literal fan-out, use the default direct-dispatch path.

- **Default (all hosts, including Claude Code) → direct Agent-tool dispatch.**
  Read `concurrency` from `config/rca.config.json` and dispatch
  `tfa-rca:ai-tfa-coordinator` subagents in batches of that size (one message,
  up to `concurrency` tool-use blocks per batch). This path is **outside the
  Workflow runtime**, so the `min(16, cores-2)` ceiling does not apply and the
  JSON value is honored literally. Prefer this path whenever the machine's
  Workflow cap (`min(16, cores-2)`) would be smaller than the configured
  `concurrency` — e.g. an 8-core Mac caps Workflow at 6 while the JSON asks
  for 20.
- Opt-in `workflows/rca-batch.mjs` (Claude Code only) → use only when the
  Workflow tool's structured `pipeline()`/`parallel()` orchestration,
  `resumeFromRunId` resumability, or progress UI is worth the concurrency
  trade. On this path `concurrency` is a soft target only — the runtime hard-
  caps at `min(16, cores-2)` regardless of the JSON value.
- Hosts without the Workflow runtime and without Agent-tool fan-out → drive
  the sequential harness `lib/loop.mjs` (`runRcaLoop`) one test at a time.
  Same contract, same no-prompt rule.

Subagents/coordinators return compact `RCA_OUTPUT` blocks, never transcripts. A
coordinator that dies becomes a recorded `failed` row — one stuck test never
sinks the batch (partial-first). No path ever prompts the user (the gate is
closed).

**Coordinator prompts MUST name every connector-shaped skill on the manifest.**
Each dispatch prompt lists, per capability, the resolved connector skill from
Gate Part A Step 0 — e.g. *"Use `<resolved-github-skill>` for every
product_code / deploy / ci ask (canonical repos + branch live in the skill; do
NOT grep other repos). Use `<resolved-infra-skill>` for every infra ask."* A
coordinator prompt that omits a manifest-listed connector skill — and that
therefore lets the
coordinator infer repos from workspace `git remote` or cwd — is a bug: the
coordinator will land plausible-but-wrong PR attributions on adjacent repos.

**Coordinator prompts MUST also name the Step 4 evidence file.** Every
dispatch prompt (representative and sibling alike) includes the absolute
`evidenceFilePath` from Step 4 with the instruction: *"Read `<path>` (via the
Read tool) before making any live github/infra/logs gather call. It's a
pre-fetch, not a hard dependency — a repo/workload it doesn't name, or marks
with a `gap`, is a genuine gap: fall back to the capability manifest above
exactly as if no file existed."* For a sibling, add: *"The file's data about
your OWN test's workload is real evidence, not inheritance — reading it is
fine. What must stay independent is the CONFIRMATION judgment: never adopt the
representative's verdict just because the file already has the answer in
it."* A dispatch prompt that omits this path forces its coordinator back into
a full independent sweep — exactly the redundancy Step 4 exists to remove.

**The file is read-write, not just read-only.** When a coordinator has to
gather live (a genuine gap), tell it to write the result back —
`contributeGithubEvidence`/`contributeLogsEvidence` (`lib/evidence-file.mjs`),
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

This is not optional polish; without it the MCP cache goes unused. Measured
across every live run before this was added: **zero MCP entries ever stored**,
because an agent's check-then-call-then-store costs three calls on a miss to
save one later, so skipping it is the rational choice for a one-off query.
Pre-seeding inverts that — the agent's `get` is a single call that usually
hits. Store the same digest you put in the evidence file; the two are
complementary (the file is read wholesale at turn 1, the cache answers a
specific repeat query later).

**Also hand every dispatch the tool cache.** The evidence file shares digested
*findings*; `bin/cached-exec.mjs` / `bin/cached-mcp.mjs` share raw *call
results*, which is where most duplicate work actually hides — on one measured
build `gh` was 37% of all coordinator tool calls and 46 were byte-identical
commands re-run by different coordinators. Include the plugin root in each
dispatch prompt so coordinators can invoke the wrappers, and tell them to pass
their own `testRunId` as `writerId`. The cache lives at
`<tmpdir>/bstack-rca/rca-toolcache.<buildId>/`, one file per call key, shared
by shell and MCP alike. Read `node bin/cached-exec.mjs <buildId> --stats` at
the end of the run to report how much it actually saved rather than assuming.

**Concurrency is handled by layout, not by locking.** Base
(`rca-evidence.<buildId>.json`) has exactly one writer — this orchestrator, in
Step 4. Every coordinator writes only its own shard under
`rca-evidence.<buildId>.contrib/<testRunId>.json`. Since no two processes ever
open the same file for writing, concurrent write-back cannot lose an update;
`readEvidenceFile` folds base + all shards into one view, applying shards in
sorted order, with real evidence taking precedence over a recorded `gap`. A
measured comparison: 8 concurrent writers with a realistic read→work→write
window lost **28 of 40 updates** against a single shared file, and **0 of 40**
under this layout.

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
