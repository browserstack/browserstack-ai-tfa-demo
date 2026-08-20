# API reference — the `lib/` surface this run calls

Read this instead of grepping `lib/`. Agents were re-deriving these signatures live
every run — `grep -n "^export function" lib/…`, repeated `ls`, `cat config/…` — which
on one measured run cost 92 of 407 tool calls.

Everything here is product-neutral. Build ids, repos, branches, workloads and paths
are **inputs**, supplied by the gate.

Two things this file deliberately does NOT contain: commands to run, and vendor
names. Nothing in `lib/` decides how to reach a customer's stack — that is your
judgement, and Step 1 of the skill body says why.

## Capabilities — no module

There is no capability module any more. `lib/routing.mjs`, `lib/discovery.mjs` and
`lib/capability-table.mjs` are deleted: they scanned PATH, matched vendor
fingerprints, joined a config object to what the scan found, and re-validated our
own shipped config on every run. You can see the environment directly and you read
the config yourself, so all three were a lookup table standing between you and two
things already in front of you — and the fingerprint list was the reason a customer
running something nobody had written down was second-class.

What replaced each one:

| was | now |
|---|---|
| `loadCapabilityTable` + `validateTable` | read `config.capabilities`. Its schema is checked in `tests/config.test.mjs`, at build time, where a property of a shipped constant belongs |
| the `capabilities` overlay | nothing. It was persisted, secret-scanned, and read by no caller — and with no probe commands and no hint list left in a row, it had nothing to carry |
| `matchHint` / `planInterview` / `preFillFromConnectorSkills` | your judgement, per `references/setup.md` |
| `buildManifest` | build `{capability: {available, via}}` yourself from the config rows and what you observed |
| `unavailableCapabilities` / `reportableUnavailable` | filter that object. Skip rows marked `exemptFromDiscoveryReport` on the human-facing screen only — the TFA declaration still reports them |
| `routeAsks` / `TEST_LOGS` | `config.evidenceRouting`: a slot with `owner: "tfa"` is theirs and is never gathered, `skip: true` is never gathered, everything else names its `capability` |

## Verification policy — `lib/verify.mjs`

Policy over what YOU report. It never probes, never builds a command, and no longer
re-checks your report — see the module header for why that check was theatre.

```
githubGate(report, row) → {blocking, message?, nextAction?}
    report in: {capability, targets:[{field, value, ok, checkedBy, gap?}]}
    THE one blocking invariant. Fails CLOSED, so a thrown or skipped verification
    step blocks rather than waving the run past. Requires COVERAGE: every field in
    row.scopeFields needs a target that is ok AND names a non-empty `checkedBy`.
    A target claiming ok with no check is called out as that, not as missing.

looksLikeSecret(value) → {secret, kind?, rotationGuidance?}
    Entropy applies to WORDS, not whole values. Both boundaries were live defects:
    whole-value entropy flagged this library's own prose, and skipping any value
    with whitespace let `export SOME_TOKEN <40 chars>` through clean.

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
