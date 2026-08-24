# Evidence Routing

Load this file **before fulfilling any `NEEDS_INFO` ask** in the per-test RCA
loop (`agents/ai-tfa-coordinator`). It maps each TFA `evidenceType` to a
**capability** (not a hardcoded tool), and defines the **digest** the coordinator
submits on the next turn.

The core contract: **TFA owns logs; the client agent owns everything else.** The
coordinator never seeds logs and never fulfills a `test_logs` ask. Every other
`evidenceType` routes to a capability gathered via **whatever the customer actually
has** for it — recorded in `.rca-context.json` by first contact and re-validated
once into the capability manifest (see `SKILL.md` § Gate Part A).

**Contents:** [How asks are processed](#how-a-turns-asks-are-processed) ·
[Routing table](#routing-table-capability-not-tool) ·
[Digest format](#digest-format) ·
[Unfulfillable asks](#unfulfillable-asks--report-dont-drop) ·
[Capability manifest](#capability-manifest-built-once-at-the-gate) ·
[Build-level evidence cache](#build-level-evidence-cache-compute-once)

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
`product_code`, `infra` (TFA may still spell it `k8s` — both route the same),
`kibana`, `metrics`, `deploy`, `ci`, `other`.

| `evidenceType` | Capability | Gathered via (discovered at runtime) |
|---|---|---|
| `test_logs` | — (TFA, skip) | never gathered; TFA self-serves from its own log access |
| `product_code` | `github` | the client's GitHub capability — **GitHub MCP if present, else `gh`** (see `references/github-evidence.md`) |
| `deploy` | `github` | deploy timeline via the GitHub capability (releases/tags + deploy record) |
| `ci` | `ci` | the customer's CI system. Falls back to the `github` capability when they have no separate one — resolved in `buildManifest`, so `ci` is not declared missing to TFA while the forge serves it |
| `infra` / `k8s` | `infra` | **whatever runtime the customer recorded** at first contact. The manifest carries its `via`; never infer a runtime from a name you did not read in the context. (`k8s` is an evidenceType KEY — the sender's wire vocabulary, not ours, and not a claim about their stack.) |
| `kibana` | `logs` | whatever log store the customer recorded. (`kibana` is likewise a wire key, not a requirement.) |
| `metrics` | `metrics` | whatever metrics backend the customer recorded |
| `other` | `other` | best-effort by ask text; else a `not-found` block |

The mapping is data in `config/rca.config.json` (`evidenceRouting`), so a
different deployment can remap `evidenceType → capability` without code changes.

**Deployment-state guard:** a suspect PR only matters if its code was actually
live in the run's env at the failure window. If you can cheaply confirm it was
not deployed / behind an OFF flag, say so in the digest rather than feeding TFA a
suspect that could not have caused the failure. (Full protocol: U9 /
`references/github-evidence.md`.)

---

## Digest format

**Digested input, not raw dumps.** Every turn's `message` loads into the agent's
context *and* is sent to TFA. Supply the *findings*, not the *haystack*.

### Per-ask block shape — `ask → found → snippet/link`

**The canonical fillable format lives in
[`../templates/evidence-block.md`](../templates/evidence-block.md)** (fulfilled
and unfulfillable variants) — copy it, don't retype it. Shape:
`ASK / TYPE / FOUND: yes|no|partial / SUMMARY ≤400 / SNIPPET (caps below) / LINK`.

- `SUMMARY` is the answer. `SNIPPET` is the *minimum* evidence backing it. `LINK`
  lets TFA (or a human) verify without the bytes living in the message.
- Prefer **LINK over SNIPPET** whenever a permalink fully carries the evidence.

### Size caps (hard ceilings — truncate, never exceed)

| Field / scope | Soft target | Hard ceiling | On exceed |
|---|---|---|---|
| `SUMMARY` | ≤ 300 chars | 400 chars | Tighten to the finding; drop restatement of the ask |
| `SNIPPET` per ask | ≤ 20 lines | 40 lines | Keep the load-bearing lines; replace the rest with `… (N lines elided — see LINK)` |
| Code diff in a `product_code` snippet | ≤ 1 hunk | 3 hunks | Show changed lines + 3 lines context; link the full PR |
| Whole next-turn `message` | ≤ 200 lines | 400 lines (and ≤ `turnMessageMaxChars`) | Drop `low`-priority asks first; keep every `high` ask's block |
| Asks fulfilled per turn | all `high` + `medium` | — | Defer `low` asks to a later turn rather than truncating a `high` ask |

Truncation rule of thumb: **never truncate a `high`-priority ask's block to fit a
`low`-priority one.** Drop the low block whole; keep the high block intact. The
whole-message ceiling also honors `turnMessageMaxChars` from
`config/rca.config.json` (the tool caps `message` at 5000 chars).

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

Gate Part A **re-validates** the capabilities `.rca-context.json` recorded — it
replays each one's stored `verifiedBy` read — **once** up front into a manifest
(`lib/routing.mjs` → `buildManifest`). `valid` maps to `available: true`;
`invalid`/`absent` map to `available: false` (a recorded gap):

```
{ github: {available: true, via: "<forge tool>"},
  ci:     {available: true, via: "<forge tool>", viaFallback: "github"},
  infra:  {available: true, via: "<runtime tool>"},
  logs:   {available: false}, ... }
```

`via` values come from the customer's context. There is no set of tool names this
file knows about.

- Every ask routes against this manifest — reproducible, no per-ask discovery.
- The gate summary **declares the gaps to the user** ("infra + metrics not
  available") and the first turn declares them to TFA so it plans asks around
  what's obtainable.
- Frozen at gate close. A skill appearing mid-run is not picked up until the next run.
- A `github` gap is reachable here only when the capability broke **after** the gate
  closed — the gate itself refuses the run on an unverifiable GitHub. Mid-run it is
  still a gap and never a refusal: a coordinator that refused would sink the batch.

## Build-level evidence cache (compute once)

"Diff since last green", "deploy timeline", and "PRs in the suspect window" are
properties of the **build**, not the test. The orchestrator computes the
last-green→this-build delta **once** (`lib/evidence-cache.mjs`), caches it by
`(repo, commit-range, evidenceType)`, and pre-seeds every coordinator with the
same grounded suspect window — collapsing N×M redundant git/infra calls to ~M and
front-loading the highest-signal evidence so many tests RESOLVE before any infra
ask fires. No "last green" (never-green suite) → fall back to a configured
baseline ref and note the weaker grounding in the turn digest (it lands in the
dashboard RCA).
