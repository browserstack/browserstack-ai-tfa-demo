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
(read and parse `config/rca.config.json` yourself — one `JSON.parse`, no helper) and an optional overlay.

```
loadCapabilityTable(config, overlay=null) → {table, violations}
    merge the overlay over the shipped table, then validate the RESULT.
    An empty `violations` array is the only success signal.
validateTable(config, table)              → violations[]   every violation, not just the first
mergeOverlay(shipped, overlay)            → {table, violations}   never mutates `shipped`
capabilitiesFromRouting(config)           → string[]   applies buildManifest's own skip rule
reportableUnavailable(unavailable, table) → the subset worth showing a human
    honours `exemptFromDiscoveryReport`. unavailableCapabilities() takes only the
    manifest and cannot read a table field, so suppression happens here — and only
    for the human-facing line; the manifest and the TFA declaration are unchanged.
RESOLVABLE                                Set: partial | always-asked
OVERLAY_FORBIDDEN                         structure a row may not decide about itself
```

Violation shape: `{code, capability?, field?, message}`. Codes:
`unseeded-capability` · `orphan-row` · `bad-resolvable` · `mandatory-count` ·
`missing-intent` · `bad-seed-hint` · `always-asked-with-hints` · `missing-consumer` ·
`overlay-forbidden-field` · `overlay-unsafe-key` · `overlay-malformed-row`

A violation naming a capability the CUSTOMER supplied in their overlay is their
input to fix; one naming a shipped row is our bug. Say which — telling a customer
their typo is "a bug in the shipped config" is how a fixable mistake becomes a
support ticket.

**What an overlay may and may not set.** `OVERLAY_FORBIDDEN` is `mandatory`,
`resolvable`, `intent`, `exemptFromDiscoveryReport` — the structure a row must not
decide about itself. Notably NOT forbidden: `seedHints` and `scopeFields`. A
customer may seed hints for a stack the shipped table does not name, and may add a
scope field that declares a consumer; that is how the product covers an unlisted
stack without a code change.

That is only safe because a hint no longer authorises anything. There are no probe
commands in the table at all, so the worst a bad hint does is propose a route which
then has to be verified by a reported check. When probes WERE data, the same overlay
freedom would have let a row certify its own probe leader.

## Interview planning — `lib/discovery.mjs`

```
planInterview({table, env, assigned, connectorSkills})
    → {routes, relevant, questions, unassigned, violations}
    `assigned` is YOUR judgement: {capability: {via, kind, why}}. It beats the
    table's seedHints unconditionally, which is the whole point — a hint list only
    knows the vendors someone wrote down, and the customer's stack usually is not
    one of them.
    `relevant` = the repo shows evidence for it but this machine cannot reach it.
    Its questions are STILL asked: a teammate who can reach it inherits the answer.
    `unassigned` = a tool present that nothing claimed. You judge whether it matters.

matchHint(row, env) → {via, kind, name} | null
    Convenience for the common cases. Never authoritative. A `file` kind is
    relevance, not a route — a directory in the tree cannot prove machine access.

preFillFromConnectorSkills(table, skills) → {scopeByCapability, violations}
    Fills only fields the table DECLARES, so a connector cannot invent scope
    nothing downstream reads.
```

## Verification policy — `lib/verify.mjs`

It validates what you report. It never probes, never builds a command, and never
decides how to reach anything.

```
validateVerification({capability, row, result}) → {result, violations}
    you report: {verified, via, targets:[{field, value, ok, checkedBy, gap?}], scopes?}
    A target `ok` with no `checkedBy` is normalised to UNVERIFIED. A claim with no
    named check carries no information, so it is not accepted as one — this is why
    a capability probe can no longer "verify" a scope value it never read.
    A failing target needs gap.class ∈ GAP_CLASS and a non-empty gap.nextAction.
    Raw provider output and credential-shaped strings are refused outright: the
    artifact is committed, so a leak there is permanent.

githubGate(validated) → {blocking, message?, nextAction?}
    GitHub is binary. Without the code and the merged PRs there is no culprit PR,
    which is the run's entire output.

looksLikeSecret(value) → {secret, kind?, rotationGuidance?}
    Never echoes what it refuses. The entropy fallback applies to whitespace-free
    values only — applied to prose it flagged this library's own warning text.
prWindowWarning({mergedCount, windowDays, branch}) → warning | null
overBroadWarning(capability, scopes) → warning | null    GitHub scopes only
GAP_CLASS  absent-on-this-machine · scope-invalid-for-team · credential-under-scoped
ACCESS_LEVEL  reported · not-reportable    UNVERIFIED    PR_WINDOW_DAYS  30
MANDATORY_CAPABILITY  "github"
```

## Context artifact

`lib/rca-context.mjs` — the only module here that touches the filesystem and git.
Uses `execFileSync("git", [...])` with an argument array, never a shell string.

```
readRcaContext({from, pluginRoot, path})   → {ok, context, path, complete} | {ok:false, code, message}
    codes: no-context · parse-error · schema-version · missing-field · unreadable
writeRcaContext({context, verifiedRepos, from, pluginRoot}) → {ok, path} | {ok:false, code, message}
    codes: missing-field · schema-version · secret-in-field · incomplete-github ·
           home-repo-unverified · no-git-worktree · ignored-destination
findContextFile({from, pluginRoot})        → path | null
contextHomeDir({homeRepo, verifiedRepos, from, pluginRoot}) → {ok, dir} | {ok:false, code, message}
findSecretFields(context)                  → [{path, kind}]
startOfRunRefusal(readResult)               → {refuse, code?, message?, nextAction?, partial?}
    the run's whole refusal policy: no-context · unreadable-context · github-unverified
    `refuse:false` carries `partial`, so the caller knows to declare unanswered gaps
intakeFromContext(context) → the RUN's intake vocabulary, translated from the
    artifact's own. `repo` ← homeRepo (the repo the context is committed to IS the
    product repo); `automationRepo` ← the one other verified repo when unambiguous.
    The two vocabularies are not interchangeable and resolveIntake matches keys
    exactly, so the run must translate before resolving.
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
