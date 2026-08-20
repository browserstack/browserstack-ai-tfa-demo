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

`lib/discovery.mjs` — not yet created. U2 documents its exports here.

## Verification

`lib/verify.mjs` — not yet created. U3 documents its exports here.

## Context artifact

`lib/rca-context.mjs` — not yet created. U4 documents its exports here.

This module is owned by **both** skills: the setup flow writes the context, and `rca-build`'s gate
reads it. The guard therefore requires its exports documented in this file **and** in
`skills/rca-build/SKILL.md`'s mandated reading. Documenting it in only one is a failure — an
at-least-one rule would let the adapter's agent grep `lib/` at runtime, which is the cost this guard
exists to prevent.
