# API reference — the `lib/` surface this run calls

Read this instead of grepping `lib/`. Agents were re-deriving these signatures live
every run — `grep -n "^export function" lib/…`, repeated `ls`, `cat config/…` — which
on one measured run cost 92 of 407 tool calls.

Everything here is product-neutral. Build ids, repos, branches, workloads and paths
are **inputs**, supplied by the gate.

Two things this file deliberately does NOT contain: commands to run, and vendor
names. Nothing in `lib/` decides how to reach a customer's stack — that is your
judgement, and Step 1 of the skill body says why.

## Capability routing — `lib/routing.mjs`, `lib/capability-table.mjs`

```
loadCapabilityTable(config, overlay) → {table, violations}
    Pass `context.capabilities` as the overlay — a customer may seed hints and
    scope fields for a stack the shipped table does not name. It may not set
    `mandatory`, `resolvable`, `intent` or `exemptFromDiscoveryReport`.
    A violation naming a capability the customer supplied is THEIR input to fix;
    one naming a shipped row is our bug. Say which.

buildManifest(config, routes) → {capability: {available, via}}
unavailableCapabilities(manifest) → [capability]
reportableUnavailable(unavailable, table) → the subset worth showing a human
    (a catch-all row that can never match is noise every run)
routeAsks(asks, config, manifest) → per-ask {action: gather|skip|gap}
TEST_LOGS   the ask type TFA owns — never gather it, always skip
```

## Interview planning — `lib/discovery.mjs`

```
planInterview({table, env, assigned, connectorSkills})
    → {routes, relevant, questions, unassigned, violations}
    `assigned` is YOUR judgement, {capability: {via, kind, why}}, and it wins over
    the table's seedHints unconditionally. `relevant` is a capability the repo
    shows evidence for but this machine cannot reach — its questions are still
    asked, because a teammate who can reach it inherits the answer.
    `unassigned` is a tool nothing claimed; you decide whether it matters.

matchHint(row, env) → {via, kind, name} | null    convenience for common cases only
preFillFromConnectorSkills(table, skills) → {scopeByCapability, violations}
```

## Verification policy — `lib/verify.mjs`

Validates what YOU report. It never probes and never builds a command.

```
validateVerification({capability, row, result}) → {result, violations}
    result in:  {verified, via, targets:[{field, value, ok, checkedBy, gap?}], scopes?}
    A target reported ok WITHOUT a `checkedBy` is normalised to `unverified` —
    a claim with no named check carries no information.
    A failing target needs gap.class ∈ GAP_CLASS and a non-empty gap.nextAction.
    Raw provider output and credential-shaped strings are refused outright.

githubGate(validated) → {blocking, message?, nextAction?}    GitHub is binary
looksLikeSecret(value) → {secret, kind?, rotationGuidance?}
prWindowWarning({mergedCount, windowDays, branch}) → warning | null
overBroadWarning(capability, scopes) → warning | null        GitHub scopes only
GAP_CLASS  absent-on-this-machine · scope-invalid-for-team · credential-under-scoped
ACCESS_LEVEL  reported · not-reportable      UNVERIFIED   PR_WINDOW_DAYS  30
MANDATORY_CAPABILITY  "github"
```

## State spine — `lib/csv-state.mjs`

```
csvPathFor(buildId, stateDir="") → <stateDir|tmpdir>/bstack-rca/rca-state.<buildId>.csv
seed(csvPath, buildId, tests)   → rows; idempotent, preserves terminal rows
readRows / writeRows            throws on a foreign header rather than dropping columns
claim(csvPath, testRunId, worker, nowMs)      → false if already claimed
heartbeat(csvPath, testRunId, worker, nowMs)
flip(csvPath, testRunId, fields, nowMs)       → false if rca_done non-terminal
reaper(csvPath, ttlSec, nowMs)                → reclaimed ids
pendingRows(csvPath)            → pending + pending-resume
COLUMNS  the canonical set; writeRows emits exactly these
RESUMABLE  "pending-resume" — a SOFT terminal: claim released, row still picked up
```

## Clusters — `lib/signature.mjs`

**You** decide which failures share a cause. Nothing in `lib/` groups them any
more: the old path normalised a signature with a regex chain and grouped by exact
string match, which cannot see that "Timeout waiting for element" and "element not
visible after 30s" are one cause. Use the server's failure themes when they are
ready, your own reading of the signatures when they are not, or both.

```
persistClusters(csvPath, csvState, assignment) → [{cluster_id, members,
                                                   representative, siblings}]
    assignment: {testRunId: clusterId} — one entry per row, ids of your choosing.
    EVERY row must be assigned. A test genuinely unlike the others gets its own
    singleton id: that is a decision. An omission is a silent per-test fan-out,
    which cost 12 tests -> 26 subagents over 30 minutes, twice in one day.
    Writes cluster_id, then reads back to confirm it landed, and throws rather
    than continue on a partially clustered CSV.

selectRepresentative(members) → non-flaky first, then smallest testRunId
    Deterministic on purpose: the CSV persists cluster_id but not WHICH member was
    the exemplar, so a resume that chose differently would pay for the same
    investigation twice.

siblingPreSeed(csvPath, csvState, clusterId, repId) → {ok, pre_seed} | {ok:false, reason}
    Refuses until the representative is terminal WITH a root cause. A sibling
    dispatched without a hypothesis re-investigates from scratch — measured at 22.7
    tool calls against the representative's 8.0, one burning 60 over 17 minutes.
```

## Shared evidence — `lib/evidence-file.mjs`

Build-level evidence, gathered once, read by every coordinator.

```
evidencePathFor(buildId, stateDir="")     initEvidenceFile(path, buildId, nowMs)
setBaseline(path, baseline, suspectWindow, nowMs)   setLocalRepos(path, repos, nowMs)
setCodeEvidence(path, repo, entry, nowMs)           setLogsEvidence(path, workload, entry, nowMs)
    code entry: {deployState:{block,gap}, prsInWindow:[...], prsSearched, gap}
    logs entry: {clusterIds, sweeps:[{via, block, gap}], gap}
        one sweep per log source ACTUALLY USED, each naming the tool or server it
        came from. There is no fixed slot per vendor: a team on three log sources
        records three, a team on one records one.
contributeCodeEvidence(path, writerId, repo, patch, nowMs)     ← coordinators write HERE
contributeLogsEvidence(path, writerId, workload, patch, nowMs)
    a sweep with no `via` is dropped — an unattributable blob proves nothing
readEvidenceFile(path)  folds base + shards      readBaseFile(path)  base ONLY
deployShas(pathOrDoc) → {pins:{repo:sha}, source}
recomputeCoverage(path, {repos, workloads}, nowMs)
stalenessOf(doc, nowMs) → how old this evidence is, so a resume can say so
hasTrustworthyPrList(entry) → false when the list is empty for an unknown reason
```

Coordinators use `contribute*`, never `set*`: single-writer shards are what stopped
concurrent writers losing each other's updates.

## Local repo reads — `lib/repo-source.mjs`

```
discoverWorkspaceRoot({repos, from, explicit, maxTries=3}) → {root, matched, tried, reason}
resolveLocalRepos({repos, pins, workspaceRoot}) → {repo: {usable, sha|reason}}
readFileAt({repo, sha, path, workspaceRoot})    → sha ONLY; a branch name is refused
```

A sha is immutable, so its content cannot be stale. A branch moves — reading one
returned bytes that did not match the commit under test on a real run.

## Turn-1 registry — `lib/turn1-registry.mjs`

```
turn1PathFor(buildId, stateDir="")   initTurn1Registry(path, buildId, nowMs)
recordTurn1(path, testRunId, {status, threadId, turnId?, asks?}, nowMs)
    PENDING or NEEDS_INFO only — RESOLVED is flipped straight into the CSV
readTurn1(path, testRunId) → entry | null      readAllTurn1(path) → {testRunId: entry}
deleteTurn1Registry(path) → boolean
```

## Housekeeping — `lib/state-dir.mjs`, `lib/build-cleanup.mjs`

```
hardenStateDir(dir)   run once at gate start; idempotent, never throws
pruneStateDir(dir, nowMs, {maxAgeMs, dryRun})   NOT automatic — these files ARE the
                                                resume state. dryRun first.
cleanupBuildArtifacts(buildId, stateDir="") → {deleted, errors}
    this build's CSV, evidence file + shards, tool cache and turn-1 registry.
    Call ONLY after the report is triggered.
```

## Output

Print a status count and the dashboard link. Nothing else — no root causes, no
culprit PRs, no cluster breakdown, no per-test table. There is no helper for this
because there is nothing to compute: count the CSV's terminal states and say so.

## Tool cache — `lib/tool-cache.mjs`, driven through `bin/`

```
node bin/cached-exec.mjs <buildId> <writerId> '<command>'   (pipe OUTSIDE the wrapper)
node bin/cached-mcp.mjs  <buildId> get|put <tool> '<argsJson>'
node bin/evidence-show.mjs <evidenceFile> [--summary | --prs | --repo <org/repo>]
node bin/repo-read.mjs <buildId> <writerId> <org/repo> <sha> <path> [--fetch]
```

Declare what kind of answer you are storing:

```
VOLATILITY.STABLE     the answer cannot change for this key — content at a commit
                      sha, a merged PR's diff. Reusable indefinitely.
VOLATILITY.SNAPSHOT   true as of a moment — live workload state, a log query, an
                      instant metrics read, a PR list. Expires after
                      SNAPSHOT_MAX_AGE_MS; the default, because guessing wrong in
                      this direction costs one refetch rather than a wrong answer.
```

A hit reports its **age** and whether the payload was **truncated**. Both matter:
reusing a snapshot is an assertion about the past, and a truncated payload turns
"grep found nothing" into a false negative. If the age matters for what you are
concluding, say so in the evidence rather than treating the hit as current.

Stateful calls are refused by the cache rather than trusted to be avoided. If
reusing an answer could hide a state transition, it is not cacheable.

## Config — `config/rca.config.json`

`concurrency`, `turnCap`, `softPendingDrain`, `reaperHeartbeatTtlSec`,
`paths.stateDir`, `evidenceRouting`, `capabilities`. Read it once at the gate and
pass values down; a coordinator should never open it.
