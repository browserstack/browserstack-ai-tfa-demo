# Evidence Routing

Load this file **before fulfilling any `NEEDS_INFO` ask** in the per-test RCA
loop (`agents/ai-tfa-coordinator`). It maps each TFA `evidenceType` to a
**capability** (not a hardcoded tool), and defines the **digest** the coordinator
submits on the next turn.

The core contract: **TFA owns logs; the client agent owns everything else.** The
coordinator never seeds logs and never fulfills a `test_logs` ask. Every other
`evidenceType` routes to a capability that is gathered via **whatever skill/tool
the client actually has** for it (discovered once into the capability manifest —
see `SKILL.md` § Pre-compute). There are **no `kubectl` / `chitragupta` /
`bifrost` literals here** — that is the whole point of going generic.

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
   - **gap** — no capability is available. Hand the ask to the injected
     **`resolveGap()`** policy:
     - **auto mode** → emit an `unavailable` block back to TFA (no user prompt).
     - **interactive mode** → return the gap to the main agent, which asks the
       user, then feeds the answer back.
2. Concatenate the per-ask blocks into the next-turn `message` and resubmit on
   the same `threadId`.

An ask that cannot be fulfilled is **never silently dropped** — it becomes a
`not-found` / `unreachable` / `unavailable` block so TFA can reason about the gap.

---

## Routing table (capability, not tool)

`evidenceType` literals are exactly those `tfaRcaTurn` emits: `test_logs`,
`product_code`, `k8s`, `kibana`, `metrics`, `deploy`, `ci`, `other`.

| `evidenceType` | Capability | Gathered via (discovered at runtime) |
|---|---|---|
| `test_logs` | — (TFA, skip) | never gathered; TFA self-serves from its own log access |
| `product_code` | `github` | the client's GitHub capability — **GitHub MCP if present, else `gh`** (see `references/github-evidence.md`) |
| `deploy` | `github` | deploy timeline via the GitHub capability (releases/tags + deploy record) |
| `ci` | `github` | CI config + run history via the GitHub capability |
| `k8s` | `k8s` | whatever k8s/EKS skill the client has — discovered, not assumed |
| `kibana` | `logs` | whatever log-search skill the client has (kibana or other) |
| `metrics` | `metrics` | whatever metrics skill the client has |
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

The single most important discipline: **digested input, not raw dumps.** Every
turn's `message` loads into the agent's context *and* is sent to TFA; a raw log
tail or full PR diff blows both budgets and degrades TFA's reasoning. Supply the
*findings*, not the *haystack*.

### Per-ask block shape — `ask → found → snippet/link`

```
ASK: <verbatim `what` from the TfaAsk, ≤ 120 chars>
TYPE: <evidenceType>
FOUND: <yes | no | partial>
SUMMARY: <1–3 sentences — the finding, in the agent's words. ≤ 400 chars>
SNIPPET:
  <the load-bearing excerpt only — see size caps. Omit if a LINK fully carries it.>
LINK: <permalink to the source — PR/commit/log-search/metrics panel/deploy record. Omit if N/A.>
```

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
- `unavailable` — no capability/skill exists for this `evidenceType` (auto-mode gap result).
- `out-of-scope` — the ask is `test_logs` or otherwise not the agent's to fulfill.

An all-`unavailable` / all-`not-found` turn still resubmits — TFA decides whether
the gap is fatal (→ BLOCKED) or it can converge anyway (best-effort, lower
confidence). The coordinator does not pre-empt that decision.
