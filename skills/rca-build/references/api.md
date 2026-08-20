# API reference — read this, don't grep the source

The `lib/` and `bin/` surface the orchestrator and coordinator call. Load this
when you first need a signature (Step 2 onward) — not at gate time. Everything
here is product-neutral: build ids, repos, branches, workloads and paths are all
**inputs**, supplied by the gate and the connector skills.

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

**Config — `config/rca.config.json`**: `concurrency`, `turnCap`, `softPendingDrain`,
`reaperHeartbeatTtlSec`, `paths.stateDir`, `evidenceRouting`. Read it once at the
gate and pass the values down; a coordinator should never need to open it.
