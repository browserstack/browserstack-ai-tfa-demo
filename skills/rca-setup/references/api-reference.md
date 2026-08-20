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

`lib/capability-table.mjs` — not yet created. U1 documents its exports here.

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
