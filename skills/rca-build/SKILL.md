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
For maximum efficiency, whenever you need to perform multiple independent
operations — connector probes, per-repo evidence fetches, per-workload log
sweeps, or any other set of calls with no dependency between them — invoke all
relevant tools simultaneously in one message rather than sequentially.
Prioritize calling tools in parallel whenever possible; err on the side of
maximizing parallel tool calls rather than running too many tools
sequentially. This applies throughout every step below (Gate probes, Step 4's
per-repo/per-workload pre-fetch, Step 4b's cluster dispatch, Step 5's
representative and sibling dispatch) — a real run measured this exact
violation costing 4+ minutes on gate probes alone. The only exception is when
one call's output is a literal input to another; that pair, and only that
pair, runs in order.
</use_parallel_tool_calls>

## Mandated reading

Files this skill's flow requires loading. The per-skill API guard in `tests/wiring.test.mjs` asserts
that every `lib/` export this skill drives is documented across this set, and the prose-budget check
measures this set plus this body. This body counts as part of its own mandated reading, which is why
the API reference below satisfies the guard where it sits.

- `<pluginRoot>/skills/rca-build/SKILL.md` (this body — holds the API reference below)

## API reference — read THIS, do not grep the source

Every signature this run needs, in one place. This exists because agents were
routinely re-deriving these signatures live — `grep -n "^export function"
lib/…`, `cat config/…`, repeated `ls .claude/skills/` — a real, recurring tax
that grew every time a helper was added faster than the docs described it, so
the plugin taxed every agent to relearn itself from source instead of reading
one page.

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

**Clustering — `lib/signature.mjs`**
```
clusterAndPersist(csvPath, csvStateModule)          → clusters; WRITES cluster_id back. Use this.
siblingPreSeed(csvPath, csvState, clusterId, repId) → {ok, pre_seed} | {ok:false, reason}
clusterRows(rows)                                   → {rows, clusters}; mutates, does NOT persist
```

**Shared evidence — `lib/evidence-file.mjs`**
```
evidencePathFor(buildId, stateDir="")   initEvidenceFile(path, buildId, nowMs)
setGithubEvidence(path, repo, entry, nowMs)      setLogsEvidence(path, workload, entry, nowMs)
setBaseline(path, baseline, suspectWindow, nowMs) setLocalRepos(path, localRepos, nowMs)
contributeGithubEvidence(path, writerId, repo, patch, nowMs)   ← coordinators write HERE
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

**Committed setup context — `lib/rca-context.mjs`** (owned by BOTH skills)
```
readRcaContext({from, pluginRoot, path})   → {ok, context, path, complete} | {ok:false, code, message}
    codes: no-context · parse-error · schema-version · missing-field · unreadable
    Distinct on purpose — never degrade a broken context to "no context", which
    would trigger a full re-interview and read as the feature forgetting the user.
resolveIntake({buildMeta, invocationArgs, context, connectorDefaults, fields})
    → {field: {value, source}}   source: buildMeta|invocationArgs|context|connectorDefaults|unresolved
    THE gate's precedence rule. Verified context outranks connector intake defaults.
    Inference is NOT a tier here — the gate performs it, only on `unresolved` fields.
findContextFile({from, pluginRoot})   → path | null   two-stage walk; refuses pluginRoot
contextHomeDir({homeRepo, verifiedRepos, from, pluginRoot}) → {ok, dir} | {ok:false, code, message}
writeRcaContext({context, verifiedRepos, from, pluginRoot})  → {ok, path} | {ok:false, code, message}
    refuses `incomplete-github`: a complete context whose GitHub is unverified is a
    state every run would refuse — the interview writes a partial instead.
findSecretFields(context)   → [{path, kind}]   names WHERE, never the value
startOfRunRefusal(readResult) → {refuse, code, message, nextAction, partial}
    THE start-of-run policy — call it in Part A Step 0a. Refuses on no-context,
    unreadable-context and github-unverified. A partial with verified GitHub
    proceeds with `partial: true`.
CONTEXT_FILENAME  ".rca-context.json"   at the home repo's worktree root, NOT under .rca/
SCHEMA_VERSION    CREDENTIAL_KIND  { ENV_VAR, PROVIDER_MANAGED }
```
This artifact is git-tracked, so it is the one persisted file here that is
deliberately NOT hardened — never point `hardenStateDir` at it.

**Housekeeping — `lib/state-dir.mjs`**
```
hardenStateDir(dir)                       run once at gate start; idempotent
pruneStateDir(dir, nowMs, {maxAgeMs, dryRun})   NOT automatic — these files are the resume state
```

**Step 4b turn-1 pre-dispatch registry — `lib/turn1-registry.mjs`**
```
turn1PathFor(buildId, stateDir="")   → <stateDir|tmpdir>/bstack-rca/rca-turn1.<buildId>.json
initTurn1Registry(path, buildId, nowMs)   idempotent, never clobbers existing entries
recordTurn1(path, testRunId, {status, threadId, turnId?, asks?}, nowMs)   PENDING or NEEDS_INFO only — RESOLVED is flipped straight into the CSV instead
readTurn1(path, testRunId)   → entry | null
readAllTurn1(path)           → {testRunId: entry}   run-end stats only
deleteTurn1Registry(path)    → boolean (existed?)   called by lib/build-cleanup.mjs
```

**Build-completion cleanup — `lib/build-cleanup.mjs`**
```
cleanupBuildArtifacts(buildId, stateDir="") → {deleted, errors}
  deletes THIS build's CSV, evidence file + .contrib shards, tool cache dir, and turn1 registry.
  Call ONLY after triggerRcaReport succeeds (Step 6) — never a periodic sweep, see lib/state-dir.mjs.
```

**Routing / output — `lib/routing.mjs`, `lib/glimpse.mjs`, `lib/evidence-cache.mjs`**
```
loadConfig(configPath)  buildManifest(config, discovered)  routeAsks(asks, config, manifest)
renderGlimpseFromCsv(csvPath, {buildId})    resolveBaseline(lastGreenRef, fallbackRef)
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

> **ADAPTER (milestone 1 scaffolding — delete when Part B reads context natively.)**
> Everything in this blockquote and the matching one in Part B exists to feed the
> `rca-setup` context into today's gate. Milestone 2 rewrites the gate around it and
> this scaffolding goes away; the precedence chain below must survive that rewrite.

**Step 0a — load the persisted setup context BEFORE any probe.** A probe's job here
is to *confirm* what setup already resolved, not to rediscover it.

```js
const read = readRcaContext({ from: process.cwd(), pluginRoot });   // lib/rca-context.mjs
const verdict = startOfRunRefusal(read);
```

`startOfRunRefusal` is the whole refusal policy, as a tested function rather than a
list of paragraphs here. It refuses in four cases and only four:

| `verdict.code` | Meaning | What to print |
|---|---|---|
| `no-context` | nothing found | "run the `rca-setup` skill once in this repo" |
| `unreadable-context` | present but unusable — parse error, `schemaVersion` mismatch, missing field, bad overlay | the file path, the class, and the fix. **Never** "no context found" |
| `github-unverified` | context exists, GitHub is not verified in it — including a partial without it | re-run setup; check the credential it names |
| — | `refuse: false` | proceed; `verdict.partial` says whether unanswered capabilities must be declared as gaps |

**Refuse before any RCA work, identically in interactive and headless mode.** The
third and fourth rows are the ones a prose list forgets: `unreadable-context` looks
like `no-context` until you look closely, and telling someone to run setup when
their file is merely conflict-marked discards every answer they already gave.

When `refuse: false`, **seed the manifest from the context** before probing —
`verified` carries each capability's route and resolved targets, so the probes below
confirm rather than discover. A partial's unanswered capabilities are declared as
gaps exactly like a skip.

**Step 0 — enumerate connector-shaped skills FIRST (before probing raw MCP tools).**
Run:

```bash
# cwd, the WORKSPACE ROOT above it, and the user dir. The middle one matters:
# when this plugin is itself a repo inside the workspace, cwd is the plugin and
# the product's connector skills sit one or two levels UP, so a bare
# `ls .claude/skills/` finds nothing and the run silently degrades to raw MCP
# tools with best-effort repo guesses — on a real run it missed every
# connector actually present on the workspace this way.
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

**REQUIRED before you open any single family's SKILL.md: list every family the
`ls` output actually returned, one line each, THEN check each one's failure-
signature match — never open just the first (or only) one you happen to
notice and stop there.** This has gone wrong on a real run: the `ls` returned
three families (`a11y-*`, `tm-*`, `tra-*`), the build's actual failures were
accessibility/Workflow-Analyzer domain, and the orchestrator read only
`tra-regression-context` (a TRA/Observability connector whose declared lanes
don't include accessibility at all) — never opened `a11y-regression-context`,
the one that actually matched. That silently produced "exactly one family, use
it" behavior even though three were present, and the mismatch then had to be
patched by asking the user two separate questions Part B says never to ask.
**If you are about to read one family's SKILL.md and cannot recite the other
families the `ls` output also returned, STOP — you skipped the enumeration.**
The failure-signature check (step 2 below) is what catches a family that looks
present but doesn't actually own this build's failures; skipping straight to
one file is exactly how a wrong-family read reaches Part B undetected.

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
being absent) never blocks another connector's probe from running; there is
nothing here for one row to wait on. For example: `gh auth status`, `kubectl
version --request-timeout=5s` (or whatever infra tool applies), a logs-MCP
check, and a metrics-MCP check all belong in the SAME turn — not four separate
turns run one after the other, and not "check github, then check infra,
then …". (This is the same class of bug Step 4b hit on a real run: a
sequential-*looking* list of independent checks got executed sequentially in
practice, costing minutes it never needed to. Don't repeat that here, at the
very front of the pipeline where it delays everything downstream.)

**This rule has already been read and violated on a real run — measured
cost 4+ minutes on gate/scope probes alone.** The coordinator had this exact
paragraph available and still issued `gh api <repo>`, an env-var check, a
second env-var check, `kubectl get ns`, `kubectl auth can-i`, `kubectl get
pods` (×2), and `kubectl get pod` as eight separate messages, one Bash call
each, 10-34 seconds apart. Restating the rule again clearly did not prevent
that, so treat it as a hard gate, not a preference:

- **REQUIRED before your first probe Bash call:** write out the full list of
  every probe you are about to run this pass — every base probe, every scope
  probe, every target — one line each. Then issue every item on that list as
  its own tool-call block **in this one message**.
- **If a message you are about to send contains exactly one Bash call for a
  probe, and your list above still has unissued items with no dependency on
  that call's result — STOP.** That message is the violation in progress.
  Add the rest of the list to it before sending.
- "I'll check github's connector first, then move to infra" is the
  rationalization that produced the 4-minute real-run cost above. It sounds
  like reasonable sequencing; it is the forbidden pattern. github's probes
  and infra's probes have no dependency on each other — there is no "first."
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

**A real run skipped this whole section — not one scope probe ran, for a
connector that declares seven of them.** The base probes (`gh auth status`,
`kubectl version`) passed and the run went straight to Step 2's `listTestIds`,
never reading or running the connector's `Scope probes:` list at all. **Before
your first `listTestIds`/discovery call: confirm you can name every scope
probe you ran and its result, for every connector recorded `valid` in the
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

> **ADAPTER (milestone 1 scaffolding.)** This block must stay ABOVE the
> intake-defaults paragraph that follows it. Ordering is the entire point: a
> declaring connector skill supersedes the raw tool, and Part B has historically
> checked intake defaults before anything else — so an adapter placed underneath
> both is invisible, and a proving run would pass while proving nothing.

**Resolve intake from the context FIRST, through `resolveIntake`.**

```js
const intake = resolveIntake({
  buildMeta,                        // fetchBuildInsights — branch the build actually ran on
  invocationArgs,                   // build id, PR URLs, repo hints the user typed
  context: read.context,            // what `rca-setup` verified
  connectorDefaults,                // the connector skill's intake-defaults section
  fields: ["repo", "automationRepo", "baseBranch", "namespace", "workloads"],
});
```

Precedence, in full: **build metadata → invocation args → persisted context →
connector intake defaults → inference.** Every field comes back `{value, source}`,
and a field no source supplies comes back `source: "unresolved"` — **inference runs
only on those**, and never overwrites a resolved field. Report each field's `source`
in the gate summary so a human can see which tier won.

Two consequences that are easy to get wrong:

- **A context-verified repo enters as `given`, not as a hint.** The product-repo
  corroboration below applies to doc- and remote-sourced hints only. It must never
  discard or re-ask a repo `rca-setup` verified — a machine with a complete context
  would otherwise still hit the consolidated question, which breaks the
  zero-questions guarantee outright.
- **A branch adopted from build metadata is re-verified before use.** Setup verified
  the *persisted* branch; reconciliation may hand the run a different one, and
  adopting it unchecked skips the very 30-day window warning that predicts a dead
  culprit hunt.

**Check the selected connector skill's own intake-defaults section FIRST — before
falling through to inference, and before ever asking.** A connector skill that
declares "Intake defaults for the gate (Part B)" (or equivalent) is telling you
these fields are answerable outright for its product, by build-name/lane or
failure-pattern lookup — not assumptions, not something to ask about. Skipping
straight to inference or to the user when the connector already names the
answer is the exact bug a real run hit: the selected connector's own intake
section explicitly read _"An orchestrator that... asks the consolidated
question about them is reading the wrong place"_, and the run asked anyway —
two separate questions, not even the allowed single one. If the connector's
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

**This has already been violated on a real run** — a product-family
disambiguation question and a repo-ownership question went out as two separate
`AskUserQuestion` calls, 33 seconds apart, instead of one consolidated
question (or, better, no question at all, since the connector's own intake
defaults answered both — see above). **Before your first `AskUserQuestion`
call this pass: write out every field this run still needs from the user,
across every reason it might be non-assumable, in one list — then ask them as
ONE question with multiple parts if more than one survives.** If you are about
to send a second `AskUserQuestion` call in the same gate pass, STOP — fold its
content into the first question instead, or if the first has already been
sent, that is the violation; there is no second gate question, ever.
**Headless: skip asking entirely;
record the gaps.**

### Gate close

Print a one-screen summary: resolved intake (with assumptions marked) + the
validated capability manifest (with gaps named). Then the gate closes.

**AFTER THE GATE CLOSES, THE RUN NEVER ASKS THE USER ANYTHING AGAIN.** RCA
execution is fully autonomous: every downstream evidence gap becomes an
`unavailable` block back to TFA (best-effort finalize), never a prompt.

**Never a blocker — except the start-of-run context refusals.** Once the gate has
closed, nothing stops the run. But the four `startOfRunRefusal` cases in Part A
Step 0a fire BEFORE it opens, and those do stop it: no resolvable context, a
context present but unreadable, and GitHub unverified. That is not an exception to
autonomy — it is the precondition for it, since a run with no verified GitHub
cannot produce the culprit PR that is the entire output.

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

## Step 3 — clustering (see `<pluginRoot>/skills/rca-build/references/clustering.md`)

Each cluster gets one **representative** (full multi-turn loop) and `N−1`
**siblings** (pre-seeded one-turn confirm against their own logs). This collapses
the expensive evidence hunt to O(distinct causes) while every test still lands a
per-test RCA. Singleton clusters are just plain per-test loops.

**Prefer the server's own clustering over recomputing it client-side.** A real
run skipped straight to the client-side fallback below without ever calling
`getBuildFailureThemes` — the tool's schema had even been loaded via
`ToolSearch` that pass, it was simply never invoked. **`clusterAndPersist` may
ONLY be called after a `getBuildFailureThemes` call this pass returned
`ready: false` (or errored) — never as a first move.** If you are about to call
`clusterAndPersist` and cannot point to this pass's own `getBuildFailureThemes`
call and its `ready: false` result, STOP — you are taking the fallback without
ever having tried the preferred path, which throws away the server's own
root-cause grouping for no reason and degrades every run to text-signature
clustering by default instead of by necessity.

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
   A real run hit exactly this: an earlier `listTestIds(status="failed")` call
   in the same session errored ("fetch failed"), a later call used a
   *different* status filter, and `clustersFromThemes` was fed whatever `rows`
   was still in scope — every theme member came back unmatched (every
   `rowById.get(...)` lookup missed), which reads exactly like a "test ID
   mismatch" but isn't one: `getBuildFailureThemes`/`listTestsInFailureTheme`
   themselves returned correct data the whole time. The result: the CSV ended
   up with signature-hash `c-xxxxx` cluster IDs (`clusterAndPersist`'s fallback
   format) instead of `theme-<id>`/`solo-<id>`, i.e. the preferred path was
   silently abandoned even though it never actually failed. The CSV is the one
   row set guaranteed fresh and from a successful seed (Step 2 only seeds
   after `listTestIds` succeeds) — always re-read it here rather than trusting
   a variable carried over from turns ago.
3. **`ready: false`** — a **server-outage net, not the routine path.** The
   trigger endpoint is deployed, so a never-computed build gets its themes from
   the POST inside Step 1 and returns `ready: true`; `ready: false` now means
   the server genuinely couldn't produce them (still computing past the poll
   budget, a failure status, or `status: "trigger-unavailable"` — the trigger
   call itself errored). Only then **fall back** to
   **`clusterAndPersist(csvPath, csvStateModule)`** (`lib/signature.mjs`), not
   `clusterRows` directly:

   ```js
   const clusters = clusterAndPersist(csvPath, await import("./lib/csv-state.mjs"));
   ```

   `clusterRows` assigns `cluster_id` **in place** and returns `{rows, clusters}`,
   so `const { clusters } = clusterRows(rows)` gives you working cluster objects
   while every `cluster_id` is silently discarded — the CSV keeps empty cluster
   columns and the run degrades to **one coordinator per test**, losing the whole
   representative/sibling collapse. This is a real failure mode, not a
   theoretical one — a real run hit it, with the clustering silently "done" in
   the return value but never written to the CSV. `clusterAndPersist` writes
   back and verifies the count, so it cannot forget.

   Never block the run waiting on the server; the fallback keeps the same
   `{ cluster_id, representative, siblings }` contract the fan-out consumes,
   so nothing downstream needs to know which path produced it. With the trigger
   endpoint deployed this path is the exception, not the rule: a healthy server
   reaches `ready: true` on its own (fresh builds included), and this net only
   engages on a genuine outage — the server erroring, failing computation, or a
   real backlog outrunning the poll budget.

`clustersFromThemes` mutates each row's `cluster_id` in place but does NOT
persist — it's pure/dependency-free by design. Write its rows back yourself
with `csvState.writeRows(csvPath, rows)` before fan-out; `clusterAndPersist`
already does this for the fallback path. Then verify either way: **if
`cluster_id` is empty on any row, Step 3 did not take effect** — do not
proceed, the run would silently cost O(tests) instead of O(causes).

## Step 4 — build-evidence pre-fetch (see `<pluginRoot>/skills/rca-build/references/evidence-routing.md` and `<pluginRoot>/lib/evidence-file.mjs`)

Once, after clustering (Step 3) and before fan-out — the capability manifest
already exists from Gate Part A, reuse it, do not re-discover. This step
replaces each coordinator's own turn-1 evidence sweep with ONE pre-fetch:
it does not remove the requirement that turn-1 evidence exists, only _who
gathers it_.

**Narrate this as one combined phase, not two sequential ones.** Step 4b
(below) starts the moment Step 3 finishes and runs the whole time Step 4 does
— any progress line shown to the user during this window should say something
like `Evidence pre-fetch (Step 4) + turn-1 pre-dispatch (Step 4b)`, never "Step
4 done, now starting Step 4b." That sequential phrasing is exactly what caused
Step 4b to be *executed* sequentially in practice on a real run — the
narration and the execution went wrong together, and fixing only one of them
leaves the other free to reintroduce the bug.

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

   **Every repo's PR-window search is independent of every other repo's —
   fire all of them as parallel tool calls in ONE message, never one repo,
   read its result, then the next repo.** The same rule that governs Gate
   Part A's connector probes applies here at repo granularity: write the
   full repo list from step 2 first, then issue every repo's `gh pr list`
   call together. A message containing exactly one repo's fetch, with other
   repos from the union still unfetched and no dependency on this one's
   result, is the violation — go back and batch the rest in before sending.

   **`--json` on THIS FIRST `gh pr list` call MUST include `files` — there is
   no separate step where it gets added later.** This is the single
   highest-leverage thing in Step 4, and it is a MUST, not a nice-to-have: a
   PR-list call than omits `files` here is never corrected downstream — it
   just becomes one `gh pr view <n> --json files` per PR, run from inside the
   `for pr in ...` loop this exact mistake produces. This has happened on a
   real run: the orchestrator listed PRs without `files`, then looped `gh pr
   view --json files` once per PR to backfill it — entirely avoidable had the
   first call carried `files`. There is no legitimate reason to split these
   into two calls; `--json files` costs nothing extra on the list call itself.

   ```bash
   gh pr list -R <org>/<repo> --state merged --base <branch> \
     --search 'merged:<from>..<to>' --json number,title,mergedAt,url,files --limit 100
   ```

   `--json files` returns every PR's changed paths in the SAME call, so one
   request per repo replaces one `gh pr view <n> --json files` per PR across
   every coordinator. Across real runs, per-PR file-list fetches have been a
   meaningful slice of all `gh` traffic — entirely avoidable here.
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

   Two other real wastes this step should pre-empt:
   - **Never let coordinators re-probe connectors.** `gh auth status` /
     `kubectl version` calls have shown up repeatedly from coordinators purely
     because the manifest wasn't trusted. State plainly in the dispatch prompt
     that the gate validated them.
   - **File contents are a large, only partly predictable slice of `gh`
     traffic**, so do NOT bulk-fetch them. The `files` lists above tell a
     coordinator exactly which files matter, and the tool cache dedupes the
     ones two coordinators both open.
4. For each workload: run the connector skill's compulsory kubectl +
   VictoriaLogs sweep **once**, anchored to the build's own clock — never
   "now". **Every workload's sweep is independent of every other workload's
   and of every repo's fetch in step 3 — batch all of them into the same
   message(s), same rule as step 3's repo fetches.** **PAD the window:
   `started_at − 2m` .. `finished_at + 10m`.**
   `finished_at` is when the build was _marked_ finished, which is not when
   the failing behaviour stopped: on a real build, an upstream outage was
   still ongoing after `finished_at` was recorded — a sweep scoped strictly
   to `started_at..finished_at` would have caught only the very start of it
   and missed the cause entirely. Label every
   finding with whether it falls inside or outside the strict window so a
   coordinator can weigh it; do NOT silently widen to an arbitrary window
   (that is the separate, opposite failure of matching a coincidence from
   unrelated traffic). Persist via `setLogsEvidence(path, workload,
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
   branch names. A developer's clone is routinely stale, and reading a branch
   locally has returned different bytes than the real head — for RCA that is
   a confident wrong answer about code that never shipped.

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

## Step 4b — turn-1 pre-dispatch (fire-and-forget, fully async alongside Step 4)

Every cluster's representative testRunId is already known the moment Step 3
finishes, for however many clusters this build produced — never assume a
fixed count, it is whatever Step 3 found. Turn 1's message has no dependency
on Step 4's evidence pre-fetch at all: it is built entirely from Step 2's CSV
seed (`error_summary`/`testName`), exactly the same construction
`agents/ai-tfa-coordinator.md`'s loop step 0 uses when neither `pre_seed` nor
`resume` applies (`error_digest` present → `"Error: <title + endpoint>"`; else
→ `"Initiating collaborative RCA for test run <id>."`). So there is no need to
wait for Step 4 before starting Step 4b — and, just as importantly, no need to
wait for Step 4b either before moving on.

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

An Agent-tool dispatch returns *immediately* with a launch confirmation, not
the subagent's result — this is fundamentally different from a batch of raw
MCP tool calls in one turn, which blocks the orchestrator until every call in
that turn returns. Fire off every representative's dispatch together, then
**immediately proceed to Step 4's evidence pre-fetch in the very next turn —
do not wait for any of them.** There is no "same batch as Step 4" trick to get
right here (an earlier version of this section relied on that and it is easy
to execute wrong, e.g. by finishing Step 4 first and only then starting Step
4b — the fire-and-forget dispatch here has no such ordering hazard, because
nothing about it requires being co-located with Step 4's own tool calls).

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
5. **A subagent that never reports back fails open, not closed.** If a turn-1
   subagent dies, errors, or times out before emitting its `TURN1_OUTPUT`
   block, no registry entry gets recorded for that representative — there is
   nothing to distinguish "Step 4b never ran for this test" from "Step 4b ran
   and failed." Both land in exactly the same place: Step 5's `readTurn1`
   returns nothing, and Step 5 falls back to a completely normal, fresh
   dispatch (submit turn 1 from scratch, no `resume`/`turn1_result`) — which
   is functionally the retry. There is no separate "check Step 4b succeeded,
   re-trigger turn 1 if not" step to build; the existing no-entry fallback
   already covers it. The one real cost: if the dead subagent *did* reach
   `tfaRcaTurn` before failing to report back, that thread is now orphaned —
   Step 5's fresh dispatch starts a genuinely new thread rather than resuming
   it. Not a correctness problem (the new thread resolves independently just
   fine) — just one wasted, never-continued thread on TFA's side per failure.

**This removes orchestrator-side blocking, not underlying capacity — cap the
fan-out itself.** Every dispatched subagent still makes a real `tfaRcaTurn`
call, consuming the same API/compute capacity Step 5's fan-out competes for.
"Async" means the orchestrator never sits idle waiting on these dispatches —
it does NOT mean the dispatches are free, and firing an unbounded number of
them at once for a build with many clusters risks the same session/rate-limit
cascade a large Step 5 fan-out can hit. **Dispatch at most `concurrency` (from
`config/rca.config.json` — the same value Step 5 already uses, not a separate
setting) turn-1 subagents at a time.** For a build with more cluster
representatives than that, issue the first `concurrency` immediately, then
issue the next batch as soon as they're dispatched (still fire-and-forget,
still never blocking Step 4's own progress) rather than firing every
representative in one shot regardless of cluster count.

None of this — `initTurn1Registry`, the pending-resume skip-list check, or the
first dispatch batch — has any dependency on Step 4's own tool calls, or vice
versa. **The very first turn can contain Step 4b's setup-and-first-dispatch-
batch together with Step 4's own first evidence-gathering calls, in the same
batch.** Do not treat Step 4b's prep as a turn Step 4 waits behind, even for
one turn — that is the same one-extra-turn-of-latency mistake this whole
section exists to remove, just smaller.

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
issued.** A real run skipped Step 4b entirely — no lightweight turn-1
pre-dispatch subagent was ever launched, and all N cluster representatives
went straight to a full `ai-tfa-coordinator` dispatch here instead, paying
full multi-turn coordinator cost for every cluster including the ones that
would have resolved in one pre-dispatched turn. **If you are about to issue
Step 5's representative dispatches and cannot point to this pass's
`initTurn1Registry` call and a turn-1 dispatch batch issued for every
thread-less cluster representative, STOP — go back and fire that dispatch
batch first.** This gate is about the dispatch having gone out, same
fire-and-forget contract Step 4b already documents — it is NOT a "wait for
Step 4b's subagents to finish" gate, and reading it that way reintroduces the
exact sequential-latency bug Step 4b exists to remove. In practice this batch
should already be long since fired by the time you reach Step 5, since Step
4b's own instructions have it go out in the same turn as Step 4's first
evidence-gathering calls — this check exists only to catch the case where
that never happened at all, not to insert a new wait.

**ORDER MATTERS: representative first, siblings only after it lands.** For each
cluster, dispatch the representative, wait for its row to go terminal, then
dispatch its siblings carrying `pre_seed` from
`siblingPreSeed(csvPath, csvState, clusterId, representativeId)`. Clusters are
independent, so they still run concurrently *with each other* — the barrier is
per cluster, not global.

A sibling is only cheap because it confirms a hypothesis someone else already
established. Dispatch one without that hypothesis and "one-turn confirm"
degenerates into a full independent investigation *with the sibling framing on
top*, so it costs MORE than the representative it was meant to be a fraction
of — this has happened on a real run, with siblings running well past
representative-level cost because nothing ordered them after their rep and
nothing refused to dispatch without a seed. It degrades silently, with no
error to flag it.

`siblingPreSeed` returns `{ok:false, reason}` when the representative is not
resolved or recorded no `root_cause` — **do not dispatch that sibling yet**.
Never hand-roll the seed: the guard is the only thing standing between a
clustered run and O(tests) cost.

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
> the JSON value literally: fan out coordinator subagents in batches of
> `concurrency` (one message, up to `concurrency` tool-use blocks per batch).
> The opt-in `workflows/rca-batch.mjs` path is subject to the Workflow tool's
> architectural cap of `min(16, cpu cores - 2)` — on that path `concurrency`
> is a soft upper bound and excess work queues rather than running N-wide.
> If you need literal fan-out, use the default direct-dispatch path.

- **Default (all hosts, including Claude Code) → direct Agent-tool dispatch.**
  Read `concurrency` from `config/rca.config.json` and dispatch
  `tfa-rca:ai-tfa-coordinator` subagents in batches of that size (one message,
  up to `concurrency` tool-use blocks per batch), refilling each next batch per
  the rolling work-queue discipline above — never two rigid all-reps /
  all-siblings phases. This path is **outside the Workflow runtime**, so the
  `min(16, cores-2)` ceiling does not apply and the JSON value is honored
  literally. Prefer this path whenever the machine's Workflow cap (`min(16,
  cores-2)`) would be smaller than the configured `concurrency` — e.g. an
  8-core Mac caps Workflow at 6 while the JSON asks for 20 — but remember it
  only gets per-BATCH streaming, not per-cluster: prefer
  `workflows/rca-batch.mjs` instead whenever cluster count exceeds
  `concurrency` and the Workflow tool is available.

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
  trade. On this path `concurrency` is a soft target only — the runtime hard-
  caps at `min(16, cores-2)` regardless of the JSON value.
- Hosts without the Workflow runtime and without Agent-tool fan-out → drive
  the sequential harness `lib/loop.mjs` (`runRcaLoop`) one test at a time.
  Same contract, same no-prompt rule.

Subagents/coordinators return compact `RCA_OUTPUT` blocks, never transcripts. A
coordinator that dies becomes a recorded `failed` row — one stuck test never
sinks the batch (partial-first). No path ever prompts the user (the gate is
closed).

**Coordinator prompts MUST carry `pluginRoot` and use it to fully qualify every
reference-doc / lib path.** A coordinator is dispatched fresh, with no
guarantee about its own cwd — `references/evidence-routing.md` (bare,
relative) resolves against whatever directory the coordinator happens to
start in, which is routinely NOT this plugin's root. This has cost real
coordinators repeated `Read` attempts at the wrong bare path followed by a
`find` to recover the real one (`<pluginRoot>/skills/rca-build/references/evidence-routing.md`,
`.../github-evidence.md`, `.../clustering.md`). Every dispatch prompt must
state `pluginRoot=<absolute path>` up front and every reference-doc pointer in
the prompt (and echoed from `agents/ai-tfa-coordinator.md`) must already be
`pluginRoot`-qualified — never a bare `references/<file>.md`.

**Coordinator prompts MUST also point at the API reference instead of letting
the coordinator re-derive it.** State plainly in the dispatch prompt: "Function
signatures for `lib/*.mjs` are documented at `<pluginRoot>/skills/rca-build/SKILL.md`
§ API reference — read that section once if a signature is needed; do not
`grep`/`Read`/`cat` the `lib/` source to re-derive a signature already
documented there." This is a real, recurring self-discovery tax — one
coordinator re-read `lib/evidence-file.mjs` plus a `grep`, all to re-learn
`contributeLogsEvidence`'s signature — a cost this pointer removes.

**Coordinator prompts MUST name every connector-shaped skill on the manifest.**
Each dispatch prompt lists, per capability, the resolved connector skill from
Gate Part A Step 0 — e.g. _"Use `<resolved-github-skill>` for every
product_code / deploy / ci ask (canonical repos + branch live in the skill; do
NOT grep other repos). Use `<resolved-infra-skill>` for every infra ask."_ A
coordinator prompt that omits a manifest-listed connector skill — and that
therefore lets the
coordinator infer repos from workspace `git remote` or cwd — is a bug: the
coordinator will land plausible-but-wrong PR attributions on adjacent repos.

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

This is not optional polish; without it the MCP cache goes unused. Before this
was added, the cache went entirely unused across every live run — an agent's
check-then-call-then-store costs three calls on a miss to save one later, so
skipping it is the rational choice for a one-off query. Pre-seeding inverts
that — the agent's `get` is a single call that usually hits. Store the same
digest you put in the evidence file; the two are complementary (the file is
read wholesale at turn 1, the cache answers a specific repeat query later).

**Also hand every dispatch the tool cache.** The evidence file shares digested
_findings_; `bin/cached-exec.mjs` / `bin/cached-mcp.mjs` share raw _call
results_, which is where most duplicate work actually hides — `gh` calls make
up a large share of all coordinator tool calls on a real build, and a
meaningful number of them are byte-identical commands re-run by different
coordinators. Include the plugin root in each
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
comparison under a realistic concurrent read→work→write window showed a
single shared file losing the large majority of concurrent updates, while
this sharded layout lost none.

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

1. Print the **completion summary** from the CSV (`lib/glimpse.mjs` →
   `renderGlimpse`): `RCA analysis complete — build <id>` + a status count line
   (`<N> tests · <R> resolved · <P> pending · <F> failed`). **Nothing per-test.**
2. Call **`triggerRcaReport(buildUuid=<build id>, force=true)`** — **always pass
   `force=true`; never `force=false` in any case.** Forcing regenerates the
   release-readiness report from the RCAs completed so far, so the report is
   produced for this run's actual analysis even when only a subset of tests
   reached terminal RCA — instead of returning a stale/empty cached report or
   blocking on a bulk re-trigger of every test's RCA.
3. **Only once that call succeeds**, call
   `cleanupBuildArtifacts(buildId, config.paths.stateDir)`
   (`lib/build-cleanup.mjs`) to delete THIS build's own CSV, evidence file +
   `.contrib/` shards, tool cache, and turn1 registry. Never call this before
   `triggerRcaReport` succeeds, and never on a run that ends with any row still
   non-terminal — at that point resume still needs these files. This is safe
   specifically because Step 6 only runs "when every row is terminal": there is
   nothing left to resume for THIS build once its report has generated. It is
   deliberately not `lib/state-dir.mjs`'s `pruneStateDir` (a separate, manual,
   age-based sweep across every build in the shared temp dir) — that remains
   the safety net for a build that crashes before ever reaching Step 6.
4. Print the link line, verbatim shape:

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
- An invalid/absent connector is a recorded gap, never a blocker — **except the
  start-of-run context refusals** (Part A Step 0a): no resolvable context, a context
  present but unreadable, or GitHub unverified. Those three stop the run before the
  gate opens. Every other missing connector, at any later point, is a gap.
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
