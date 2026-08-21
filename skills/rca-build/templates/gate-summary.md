# Template — THE gate (printed once, when the gate closes)

One terse screen before autonomous execution starts. After it prints, the run never
asks the user anything.

When first contact ran this session, it printed its own confirm-and-write digest
just before this one (`references/interview.md`). On a repeat run this is the only
user-visible checkpoint.

## Tags

Every field carries how it was resolved. One vocabulary, because a field can be
resolved without asking, answered, deliberately skipped, or proven broken:

| Tag | Meaning |
|---|---|
| `given` | supplied in the invocation, or read from build metadata |
| `detected` | resolved without asking — the profile already held it, or a tool answered |
| `assumed` | inferred, and the inference is named |
| `answered` | the human supplied it at this gate |
| `skipped` | declined. A recorded gap, never re-asked |
| `failed` | replay ran and the value is wrong or unreachable |
| `stale` | verified, but longer ago than `context.staleAfterDays`. Not a failure and not a question — it is repaired lazily, at first use |
| `gap` | absent, and declared to TFA as such |

**Never print raw provider output.** A gate is a decision surface: a failure prints
as its class plus its next action, never as bytes.

**Name the profile and the file.** A run driven by the wrong profile is the worst
silent failure this design has, so both are always on screen. When selection had to
break a tie on specificity, print what else matched — that is how a bad
`buildMatch` gets fixed instead of quietly mis-routing every night.

**Do not list a capability that can never be recognised.** `other` is the
catch-all; it would otherwise appear as a missing connector on every single run.

**A `viaFallback` is shown, not hidden.** `ci` served by the git forge is a correct,
common outcome — but a reader comparing two runs needs to see which one had a real
CI connector.

## The screen

```
GATE CLOSED
  profile: <label>   matched <pattern>   [also matched: <label>, … — narrow buildMatch]
  context: <abs path>/.rca-context.json

Capabilities:
  github   ✅ valid    (<what the profile records>)   repos 2/2 · base <branch>
  ci       ✅ valid    (<connector>, via github)       ← fallback: no separate CI connector
  infra    ✅ valid    (<connector>)                   <scope>
  logs     ⚠️  stale    (<connector>)                  last verified <date>
  metrics  ❌ gap                                      → declared to TFA

Intake:
  build id:        <id>                   (given)
  product repo:    <org/repo>             (detected — from the profile)
  automation repo: <org/repo>             (detected — from the profile)
  working branch:  <branch>               (given — build metadata, overrides profile <other>)
  default branch:  <branch>               (detected)
  PRs in play:     <#123, #456 | none>    (given | gap)

Warnings:
  · <branch> has no merged PRs in the last 30 days — culprit-PR attribution will
    have nothing to search. Expected on a quiet branch; worth a look otherwise.

Gaps declared to TFA (the run proceeds; these degrade evidence, not the run):
  · metrics — no connector recorded

Proceeding autonomously: discovery → clustering → fan-out (concurrency <N>, turn-cap <M>).
```

The `via` column names **whatever the profile records** for that capability. There
is no fixed set of runtimes or log stores to choose from. This template used to
enumerate several by name, which taught a default in one of the few files an agent
reads at gate time — outliving every deletion made elsewhere.

## The one question

At most one, and only for a field that is both non-assumable and load-bearing.
In practice: the build id; the product repo when the profile's repos cannot be
corroborated against this build's failures and no PRs were supplied; and the
profile itself when the build name matched zero or more than one `buildMatch`.

If more than one survives, they are parts of ONE question. There is no second gate
question — see SKILL.md § The question budget.

**A runnable but not provisioned profile spends the question differently.** If
GitHub is verified but some capabilities have neither a connector nor a recorded
gap, setup was abandoned partway. Ask: *finish setup now, or run GitHub-only and
record the rest as gaps?* Choosing GitHub-only **writes those gaps**, so the profile
becomes provisioned and this is never asked again. Without that, a customer who
stopped after GitHub is silently locked into a GitHub-only setup forever.
