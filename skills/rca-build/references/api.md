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

**Scratch — `lib/state-dir.mjs`**

```
scratchDirFor(buildId, writerId, stateDir="") → an existing 0700 directory
    Yours alone, keyed on writerId, under the state tree beside the CSV and the
    tool cache. Never the invocation directory — that is the customer's, and every
    agent in a run shares it, so short filenames collide and the loser's work is
    gone. Prefer holding a file in context over writing it at all; the tool cache
    already dedupes the fetch. Whatever you do write, delete by name before you
    finish — the plugin never removes a file it did not create.
hardenStateDir(dir) → {dirs, files, skipped}    tightens to owner-only; never deletes
```

**Config — `config/rca.config.json`**: `concurrency`, `turnCap`, `softPendingDrain`,
`reaperHeartbeatTtlSec`, `paths.stateDir`, `evidenceRouting`. Read it once at the
gate and pass the values down; a coordinator should never need to open it.

## The setup context — `lib/rca-context.mjs`, driven through `bin/rca-context.mjs`

**Drive this through the CLI, not by importing the module.** The context file is
committed and shared; hand-written JSON in it is how a team's answers get silently
dropped. Every verb below refuses rather than half-writing, and every write is
temp-file-then-rename, so a refusal leaves the file byte-identical.

```
node <pluginRoot>/bin/rca-context.mjs <verb> [flags]

find                                            → the resolved path, or nothing
read              [--from DIR] [--path FILE]    → {path, trust, context}
select            [--build-name NAME] [--profile LABEL]
                  [--today YYYY-MM-DD] [--stale-after-days N]
capabilities      [--config FILE]               → the interview sequence
write             --file DOC.json | -
upsert-connector  --capability C --file CONN.json [--profile LABEL] [--today …]
record-gap        --capability C --classification K [--note …] [--target …]
record-warning    --capability C --classification K [--note …] [--target …]
record-knowledge  --artifact A --artifact-path P --part T [--capability C] [--note N]
```

**`select` is the verb Step 0 and the gate call.** `read` returns the document and
nothing else — it does no selection, takes no `--build-name`, and cannot tell you
whether the run may proceed. `select` is what returns the chosen profile plus
`runnable`, `provisioned`, `resumeAt` and `stale`. A non-zero exit means it refused;
the message names what it would otherwise have had to guess.

Refusal codes: `no-profiles` · `unknown-profile` · `no-matching-profile` ·
`ambiguous-profile` · `unknown-default-profile` · `no-default-profile` ·
`not-runnable`. **A refusal is never resolved by picking a profile yourself** — an
ambiguous match means two `buildMatch` patterns claim this build, and choosing one
silently is the wrong-context run this design exists to prevent.

### The module surface

```
CONTEXT_FILENAME  ".rca-context.json"     SCHEMA_VERSION  1
MANDATORY_CAPABILITY  "github"            DEFAULT_STALE_AFTER_DAYS  30
CREDENTIAL_KIND  { ENV_VAR: "env-var", PROVIDER_MANAGED: "provider-managed" }
CONTEXT_README    the header the CLI stamps into a new document

isRunnable(profile) → boolean
    THE gating predicate. True iff `connectors.github` exists AND its `verifiedBy`
    carries a `count` or an `observedAt`. Deliberately NOT "verifiedBy is
    non-empty": that is a presence check `{note: "TODO"}` satisfies, and an agent
    hedging instead of failing writes exactly that.
isProvisioned(profile, capabilities) → boolean
    The OTHER predicate, and it gates something different: whether the interview
    finished. True iff every capability has a `connectors` entry or a `gaps` entry.
    A profile can be runnable and unprovisioned — GitHub verified, the rest never
    asked — and that is what the gate offers to resume.
missingCapabilities(profile, capabilities, fallbacks) → string[]
    Element [0] IS the resume point. No stored `resumeAt`, so nothing can drift.
    A capability whose FALLBACK has a connector counts as covered — pass
    `capabilityFallbacks(config)` or `ci` becomes a trap: a team whose CI is their
    git forge has no second system to record, so `ci` gets no connector, and the
    only other route to provisioned would be recording a gap on a capability the
    fallback is demonstrably serving. Single hop, matching `buildManifest`.
capabilitySequence(config) → string[]      from evidenceRouting; TFA-owned excluded
capabilityFallbacks(config) → {capability: fallbackCapability}   e.g. {ci: "github"}
isRunnable/isProvisioned take the sequence, so adding a capability to config
    changes both without touching this module.

selectProfile({context, buildName, projectName, requested, todayISO, staleAfterDays})
    → {ok:true, label, profile, labels[], matchedBy, alsoMatched[], overriddenBuildMatch,
       projectUnchecked, stale[], ages{}}
    | {ok:false, code, message, labels[]}
    `todayISO` is injected — never read the clock in here. `matchedBy` says which
    rule won; `alsoMatched` is what else claimed this build and MUST be printed, or
    a bad `buildMatch` mis-routes every night unnoticed.
    `overriddenBuildMatch` is the patterns that were IGNORED: non-null only when
    `requested` was used against a build the profile does not claim. The gate prints it
    loudly — no automatic path produces that state, so it means a human chose it or an
    agent laundered a refusal.
    `labels` is EVERY profile in the file, not just the matches — the gate offers
    "use a different profile" and an option it cannot name is not an option.
    `projectName` FILTERS on `projectMatch` before build names are scored — project
    is the coarser bound and two projects routinely run near-identically named
    suites. Unknown project + a declared `projectMatch` passes rather than refusing
    (insights may be unavailable) and sets `projectUnchecked`, which the gate prints:
    a constraint the file asked for and this run could not apply.
matchesBuildName(pattern, buildName) → boolean
    Case-folded, whole-string, ONE `*`. No regex. A second wildcard matches nothing
    rather than being guessed at, and `nightly` does not match `web-nightly-*`.

validateContext(context)   → {ok} | {ok:false, problems:[{path, problem}]}
validateConnector(c, at)   → same shape
    Closed-object validation: an object refuses a key it does not define. This IS
    the secrets control — there is no credential detector anywhere in this module,
    by decision. Remove the key allowlist and `{kind, name, value:"<secret>"}`
    persists into a committed file. `scope` is the one open-keyed object, so
    `scope.value` is accepted; the interview's prompt discipline covers it.

findContextFile({from, pluginRoot}) → path | null
readRcaContext({from, pluginRoot, path}) → {ok:true, context, path, raw, trust}
    | {ok:false, code, message}
    codes: no-context · unreadable · parse-error · schema-version · missing-field
         · invalid-context
    Distinct on purpose. `parse-error` is a THIRD state, not "no context": a
    hand-resolved merge conflict degraded to "no context" would re-interview and
    then overwrite the team's file. Refuse and write nothing.
    trust: cwd · ancestor · caller-supplied   (found at the invocation directory,
    at a parent within 3 levels, or at an explicit --path)

connectors.<cap>.source: {kind: "skill"|"mcp"|"cli"|"api", path?}
    What KIND of thing serves this capability. `via` says what the tool is; this
    says whether there is a PROCEDURE behind it. A connector-shaped skill carries a
    repo map and query conventions a raw CLI does not, so a coordinator behaves
    differently when one exists — and `via` being free text made a skill and an MCP
    server named after the same backend indistinguishable.
    `path` is REQUIRED for kind "skill" and refused for the others: a skill is a
    file we must be able to go back to (to re-read, and to notice it changed),
    while an mcp/cli/api is named by `via` and a second name would only drift.
    Optional overall — a connector the agent could not classify is better left
    unmarked than guessed.
contextDestination({from, pluginRoot}) → {ok:true, dir, matchedBy} | refusal
    **The destination is the directory the agent was invoked in.** Nothing else —
    no `homeRepo` lookup, no worktree search, no sibling scan. A customer can
    predict the path before it is written, which the old resolver could not: on a
    workspace holding three clones it silently picked one of them. The directory
    need not be a git repo.
    The ONE refusal is the plugin's own checkout (`plugin-root-destination`, and
    `plugin-root-context` on read): the documented install flow leaves cwd there,
    and a context written there puts the customer's repos, branches and infra scope
    into the plugin repository.
    **What this gave up:** a directory is not necessarily a repo, so the file is no
    longer guaranteed committable and a teammate no longer inherits it by cloning.
    Inside a repo it is still committable and the gitignore refusal still applies.

writeRcaContext({context, from, pluginRoot, path}) → {ok:true, path} | refusal
    codes: invalid-context · no-home-repo · no-git-worktree · ignore-check-failed
         · ignored-destination · would-regress · write-failed
upsertConnector({capability, connector, profile, todayISO, …}) → {ok:true, …} | refusal
recordKnowledge({artifact, artifactPath, part, capability?, note?, judgedAt?, profile, …})
   → {ok:true, …} | refusal
    Records ONE part of one customer artifact as worth using. `artifact` is its declared
    identity and `artifactPath` where it was read — both, because *same path, different
    artifact* (a repurposed file) must read as gone rather than changed. `part` names the
    section or file inside it.
    **`--artifact-path`, never `--path`**: `--path` is a common flag meaning the CONTEXT
    file, and reusing it sent the artifact's path to `readRcaContext` as the document to
    open.
    `capability` is a FIELD and the list is PROFILE-level, deliberately. Coverage is
    tested with `Object.hasOwn(connectors, c)` — presence of the key, whatever it holds —
    so writing knowledge under `connectors.<cap>` would mark an unverified capability
    covered, flip `isProvisioned`, and silence the gate's offer to finish setup. Omit
    `capability` for knowledge about the product as a whole.
    Idempotent on (artifact, part), so a correction at T8 replaces rather than appends.

recordGap({capability, classification, note, target, profile, …}) → {ok:true, …} | refusal
recordWarning({…same…}) → {ok:true, …} | refusal
    Same schema, opposite meaning, and the distinction is load-bearing. A GAP means
    the capability will not be gathered: it degrades evidence and is declared to
    TFA. A WARNING means the capability WORKS and the answer will be thin — an empty
    PR window is the case it exists for. Recording an empty window as a gap would
    declare a working connector unavailable; recording a declined capability as a
    warning would leave the profile unprovisioned forever, so the gate would keep
    offering to resume an interview the customer already finished. A warning never
    satisfies `isProvisioned`.
    Additive, all three of them. They refuse any write that would drop a profile, drop a
    connector, or replace a verified connector with an unverified one. That is what
    makes an abandoned interview cost nothing: whatever verified is already on disk.

isISODate(value) · isEnvVarName(name)    character-class checks, no patterns
```

**The file is git-tracked and deliberately NOT permission-hardened.** Every other
persisted file here is 0600 inside a 0700 directory; git preserves neither, so a
hardened mode on this one is a confusing artifact rather than a protection. Never
point `hardenStateDir` at it.

**`howToQuery` is documentation, not an executable.** It records WHICH call to
make. Re-author and re-quote it at call time from `{tool, args[]}`; never join it
into a string handed to `bin/cached-exec.mjs`, which runs `execSync(cmd, {shell:
true})` — a committed file must not be able to choose what shell command runs.
