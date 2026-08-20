# Template — THE gate (printed once, and it closes)

One screen before autonomous execution starts. After it prints, the run never asks
the user anything.

There used to be two of these: a setup digest and a run summary, in two skills,
with two tag vocabularies that had already drifted. Setup is a phase of this skill
now, so there is one gate — and when setup ran inline, the persist confirmation and
the run's intake confirmation are the same screen rather than two consecutive ones.

## Tags

Every field carries how it was resolved. The vocabulary is one list because a field
can be resolved without asking, answered, deliberately skipped, or proven broken:

| Tag | Meaning |
|---|---|
| `given` | supplied in the invocation, or read from build metadata |
| `detected` | resolved without asking — a tool answered, or the context already held it |
| `assumed` | inferred, with the inference named |
| `answered` | the human supplied it at this gate |
| `skipped` | the human declined it. A recorded gap, never re-asked this session |
| `failed` | verification ran and the value is wrong or unreachable |
| `unverified` | reachable but unproven, or corrected here and still failing after its round budget. **GitHub can never end here** |
| `gap` | absent, and declared to TFA as such |

**Never print raw provider output.** A gate is a decision surface: a failure prints
as its class plus its next action, never as bytes.

**A context adopted from outside this repo says so.** `readRcaContext` returns a
`trust` label — `own-worktree` and `origin-match` are evidence, `tracked` means
someone committed it deliberately, and `name-only` means the only link is a
directory name the file itself declared. On `name-only`, print the path and the
label above everything else: adopting a file that drives repos, branch and scope
must never be silent.

**Do not list a capability that can never be recognised.** The `other` row is the
catch-all; it is `exemptFromDiscoveryReport` precisely so it does not appear as a
missing connector on every single run. The manifest and the TFA-facing declaration
still mark it unavailable — only this human-facing screen suppresses it.

## The screen

The `Scope` and `Destination` blocks appear **only when setup ran inline this
session**. With a context already on disk they are already settled, and reprinting
them turns a decision surface into a wall.

```
GATE — review before I start.                    [context: <path> · trust: <label>]

Capabilities:
  github   ✅ verified   (<tool>)              repos 2/2 · base branch <branch>
  infra    ✅ verified   (<tool>)              <scope>
  logs     ⚠️  skipped                          → recorded as a gap
  metrics  ✅ verified   (<mcp server>)

Scope:                                          (only when setup ran inline)
  home repo:      <org/repo>              (answered)   ← the context is committed here
  repos:          <org/a>, <org/b>        (answered)
  owned subpaths: <services/billing>      (answered)
  base branch:    <branch>                (detected)
  credentials:    <VAR_NAME>              (env-var name only — never the value)

Intake:
  build id:        <id>                   (given)
  product repo:    <org/repo>             (detected — from the context | assumed — corroborated vs failures | answered | unknown (gap))
  automation repo: <org/repo>             (assumed — cwd holds the tests)
  working branch:  <branch>               (given — build metadata)
  default branch:  <branch>               (detected)
  PRs in play:     <#123, #456 | none>    (given | gap)

Warnings:
  · <branch> has no merged PRs in the last 30 days — culprit-PR attribution will
    have nothing to search. Expected on a quiet branch; worth a look otherwise.

Gaps declared to TFA (the run proceeds; these degrade evidence, not the run):
  · logs — skipped at setup
  · <capability> — <install the CLI | connect the MCP server>

Destination: <abs path>/.rca-context.json   (only when setup ran inline —
                                             commit and push it so teammates inherit it)

Proceeding autonomously: clustering → fan-out (concurrency <N>, turn-cap <M>).
```

## Correction, and the one question

**Per field, not approve-or-reject** — one wrong value must not cost the whole
interview. A corrected field is re-verified before anything is persisted. If
re-verification keeps failing, the field persists as `unverified` after a stated
number of rounds, so the loop is bounded. With one exception.

**GitHub is exempt from `unverified`.** It is the only mandatory capability, so a
context that closed with GitHub unverified would claim completeness while every run
against it refuses, and the customer would have no signal which rule applies. When
GitHub correction exhausts its rounds, stop with the binary refusal and write a
**partial** (`complete: false`) instead of closing. Nothing answered so far is lost.

**At most one question here, and only for a field that is both non-assumable and
load-bearing** — in practice the build id, and the product repo when it could not
be corroborated and no PRs were supplied. If more than one survives, they are parts
of ONE question. Headless asks nothing: it prints `product repo: unknown (gap)` and
proceeds.
