# Template — SUSPECT packet (one block per candidate PR)

Fill one block per suspect, supported **and** ruled-out (elimination is evidence
too). Only `verdict: supported` suspects may feed `related_prs`. Guidance +
falsification protocol: `../references/github-evidence.md`.

```
SUSPECT:
  repo: <owner/name>
  pr: <#number>
  files: <changed files overlapping the failing path>
  hunks: <the 1-3 load-bearing changed hunks — see digest size caps>
  author: <login>
  merged_at: <ts>   vs   last_green: <ts>   vs   started_at: <ts>
  verdict: supported | ruled-out (<no-path-overlap | shipped-after | behind-off-flag | unrelated>)
  tag: regression | latent          # only on a supported verdict — see below
  link: <PR permalink>
```

**`repo` is not optional and a number alone will not do.** A PR's identity is
`repo + number` — `tfaRcaTurn`'s `prDetails` says so in as many words — and a real
profile commonly carries four product repos, where `#7900` names four different PRs.
This template had `pr` and `link` and no `repo`, so the field the structured hand-off
requires had to be re-derived from the permalink by every reader.

**`tag` is a different axis from `verdict`, and it is a judgement.** `verdict` says
whether the PR survived falsification. `tag` says what kind of fault it is, and only a
`supported` suspect has one:

- **`regression`** — the PR introduced the broken behaviour. The failing path worked
  before it merged and stopped after.
- **`latent`** — the fault predates the PR and the PR exposed it: a flag flipped, a
  timeout tightened, a caller newly reached code that was always wrong, load shifted
  onto an unguarded branch.

**Say which, and why, in the hunks line.** The distinction changes what a human does
next — a regression is reverted, a latent bug is fixed where it actually lives, and
reverting a latent-exposing PR restores the symptom while leaving the bug. When the
evidence genuinely does not separate them, write `tag: regression` and say in the
verdict that the classification is unconfirmed: an honest default beats a coin toss on
an enum, and `regression` is the one that gets the PR looked at.

**Never guess it to fill the field.** `prDetails` requires `tag` per entry, so a suspect
you cannot classify at all is a suspect you cannot send structured — say so in the turn
message instead of inventing a value.

If the hunt ends empty after a real search (never fabricate):

```
no culprit PR identified after <what was searched: window, repos, paths>
```
