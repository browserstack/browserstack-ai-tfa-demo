# Evidence Routing

Load this file **before fulfilling any `NEEDS_INFO` ask** in the per-test RCA
loop (`agents/ai-tfa-coordinator`). It maps each TFA `evidenceType` to a
**capability** (not a hardcoded tool), and defines the **digest** the coordinator
submits on the next turn.

The core contract: **TFA owns logs; the client agent owns everything else.** The
coordinator never seeds logs and never fulfills a `test_logs` ask. Every other
`evidenceType` routes to a capability that is gathered via **whatever skill/tool
the client actually has** for it (discovered **and validated** once into the
capability manifest — see `SKILL.md` § Gate Part A). **No product name appears in
this table's right-hand column** — not a runtime, not a log store, not a metrics
backend. Naming one there would be a statement about the customer's stack, which
is exactly what routing by capability exists to avoid.

**Contents:** [How asks are processed](#how-a-turns-asks-are-processed) ·
[Routing table](#routing-table-capability-not-tool) ·
[Digest format](#digest-format) ·
[Unfulfillable asks](#unfulfillable-asks--report-dont-drop) ·
[Capability manifest](#capability-manifest-built-once-at-the-gate) ·
[Build-level evidence](#build-level-evidence-compute-once)

The registry logic lives in `lib/routing.mjs` (`routeAsk` / `routeAsks`); this
file is the human/agent-facing contract for the digest and the size caps.

---

## How a turn's asks are processed

A `NEEDS_INFO` turn returns `asks: TfaAsk[]`, each `{ what, why, evidenceType,
priority }`. For each ask, in descending `priority` (`high` → `medium` → `low`):

1. Route the `evidenceType` (via `lib/routing.mjs` → the config registry +
   capability manifest). The result is one of three actions:
   - **skip** — `test_logs` (TFA-owned). Gather nothing; record in `asks_skipped`.
   - **gather** — a capability is available. Run its discovered skill/tool scoped
     by `what` / `why`, then digest the result into one ask block.
   - **gap** — no valid connector for that `evidenceType` (the gate recorded it
     as `invalid`/`absent`). Emit an `unavailable` block back to TFA — **never
     prompt the user** (the gate is closed; the run is autonomous).
2. Concatenate the per-ask blocks into the next-turn `message` and resubmit on
   the same `threadId`.

An ask that cannot be fulfilled is **never silently dropped** — it becomes a
`not-found` / `unreachable` / `unavailable` block so TFA can reason about the gap.

---

## Routing table (capability, not tool)

`evidenceType` literals are exactly those `tfaRcaTurn` emits: `test_logs`,
`product_code`, `infra`, `k8s`, `kibana`, `metrics`, `deploy`, `ci`, `other`.

Two of those keys carry a product name — `k8s` and `kibana`. They are the SENDER's
vocabulary, arriving over the wire, and they route to the generic `infra` and
`logs` capabilities. That indirection is the entire reason this table exists: a
team running neither Kubernetes nor Kibana still answers both asks.

| `evidenceType` | Capability | Gathered via (discovered at runtime) |
|---|---|---|
| `test_logs` | — (TFA, skip) | never gathered; TFA self-serves from its own log access |
| `product_code` | `github` | whatever forge access the team has — an MCP server or a CLI, recorded as `via` (see `<pluginRoot>/skills/rca-build/references/code-evidence.md`) |
| `deploy` | `github` | the deploy record for the run's environment, via the same capability |
| `ci` | `github` | pipeline definition + run history, via the same capability |
| `infra` / `k8s` | `infra` | **whatever runtime the team actually runs on.** Never assumed: identified at the gate and recorded as `via`. `k8s` is TFA's wire literal for this type, not a statement about the runtime |
| `kibana` | `logs` | whatever log store the client has — the key is TFA's wire literal, not a product requirement |
| `metrics` | `metrics` | whatever metrics backend the team has, recorded as `via` |
| `other` | `other` | best-effort by ask text; else a `not-found` block |

The mapping is data in `config/rca.config.json` (`evidenceRouting`), so a
different deployment can remap `evidenceType → capability` without code changes.

**Deployment-state guard:** a suspect PR only matters if its code was actually
live in the run's env at the failure window. If you can cheaply confirm it was
not deployed / behind an OFF flag, say so in the digest rather than feeding TFA a
suspect that could not have caused the failure. (Full protocol: U9 /
`<pluginRoot>/skills/rca-build/references/code-evidence.md`.)

---

## Digest format

The single most important discipline: **digested input, not raw dumps.** Every
turn's `message` loads into the agent's context *and* is sent to TFA; a raw log
tail or full PR diff blows both budgets and degrades TFA's reasoning. Supply the
*findings*, not the *haystack*.

### Per-ask block shape — `ask → found → snippet/link`

**The canonical fillable format lives in
`<pluginRoot>/skills/rca-build/templates/evidence-block.md`** (fulfilled
and unfulfillable variants) — copy it, don't retype it. Shape:
`ASK / TYPE / FOUND: yes|no|partial / SUMMARY / SNIPPET / LINK` — every cap in
§ Size caps below, and stated only there.

- `SUMMARY` is the answer. `SNIPPET` is the *minimum* evidence backing it. `LINK`
  lets TFA (or a human) verify without the bytes living in the message.
- Prefer **LINK over SNIPPET** whenever a permalink fully carries the evidence.

### Size caps (hard ceilings — truncate, never exceed)

| Field / scope | Soft target | Hard ceiling | On exceed |
|---|---|---|---|
| `SUMMARY` | ≤ 60 chars | 80 chars | Tighten to the finding; drop restatement of the ask |
| `SNIPPET` per ask | ≤ 4 lines | 8 lines | Keep the load-bearing lines; replace the rest with `… (N lines elided — see LINK)` |
| Code diff in a `product_code` snippet | ≤ 1 hunk | 2 hunks | Show changed lines only, no context lines; link the full PR |
| Whole next-turn `message` | ≤ 40 lines | 80 lines (and ≤ `turnMessageMaxChars`) | Drop `low`-priority asks first; keep every `high` ask's block |
| Asks fulfilled per turn | all `high` + `medium` | — | Defer `low` asks to a later turn rather than truncating a `high` ask |

Truncation rule of thumb: **never truncate a `high`-priority ask's block to fit a
`low`-priority one.** Drop the low block whole; keep the high block intact. The
whole-message ceiling honors `turnMessageMaxChars` from
`config/rca.config.json`, now set to **1000 chars** — a plugin-configured
self-limit, tighter than the underlying tool's actual hard cap (the
`tfaRcaTurn` MCP tool itself allows up to 5000 chars per `message`; the plugin
just chooses not to use all of it). At this budget, expect at most 2-3 ask
blocks per turn before hitting the ceiling — defer lower-priority asks to a
follow-up turn rather than cramming everything into one.

### What never goes in a digest

- Raw log tails, full log output, full file contents, full PR diffs — link or excerpt.
- `test_logs` content of any kind (TFA owns it).
- Credentials, tokens, internal hostnames, or any secret surfaced by an env/secret dump.
- Speculation dressed as a finding. If `FOUND: no`, say what was checked; do not invent a cause.

---

## Unfulfillable asks — report, don't drop

```
ASK: <verbatim what>
TYPE: <evidenceType>
FOUND: no
SUMMARY: not-found | unreachable | unavailable | out-of-scope — <one line: what was checked or why blocked>
```

- `not-found` — the skill/tool ran but the signal isn't there. State the search performed.
- `unreachable` — the surface was not reachable from this agent context. State which.
- `unavailable` — no valid connector exists for this `evidenceType` (a gate-recorded gap).
- `out-of-scope` — the ask is `test_logs` or otherwise not the agent's to fulfill.

An all-`unavailable` / all-`not-found` turn still resubmits — TFA decides how to
converge (best-effort, lower confidence) or what else to ask. The coordinator
does not pre-empt that decision.

---

## Capability manifest (built once, at the gate)

Rather than re-discover "do we have a log store?" on every ask across every
test, Gate Part A enumerates **and probe-validates** the client's connectors
**once** up front into a manifest (`lib/routing.mjs` → `buildManifest`).
`valid` maps to `available: true`; `invalid`/`absent` map to `available: false`
(a recorded gap):

```
{ github: {available: true, via: "gh"}, infra: {available: true, via: "flyctl"}, logs: {available: false}, ... }
```

- Every ask routes against this manifest — reproducible, no per-ask discovery.
- The gate summary **declares the gaps to the user** ("infra + metrics not
  available") and the first turn declares them to TFA so it plans asks around
  what's obtainable.
- Frozen at gate close. A skill appearing mid-run is not picked up until the next run.

## Build-level evidence (compute once)

"Diff since last green", "deploy timeline", and "PRs in the suspect window" are
properties of the **build**, not the test. The orchestrator computes the
last-green→this-build delta **once**, shares it via the evidence file keyed by
`(repo, commit-range, evidenceType)`, and pre-seeds every coordinator with the
same grounded suspect window — collapsing N×M redundant git/infra calls to ~M and
front-loading the highest-signal evidence so many tests RESOLVE before any infra
ask fires. No "last green" (never-green suite) → fall back to a configured
baseline ref and note the weaker grounding in the turn digest (it lands in the
dashboard RCA).
