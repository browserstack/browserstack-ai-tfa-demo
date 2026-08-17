# Template — SUSPECT packet (one block per candidate PR)

Fill one block per suspect, supported **and** ruled-out (elimination is evidence
too). Only `verdict: supported` suspects may feed `related_prs`. Guidance +
falsification protocol: `../references/github-evidence.md`.

```
SUSPECT:
  repo: <owner/name, e.g. browserstack/ai-sdk>
  pr: <#number>              # unique only WITHIN repo — identity is repo+number
  title: <real PR title from `gh pr view --json title` — NOT the merge-commit subject>
  files: <changed files overlapping the failing path>
  hunks: <the 1-3 load-bearing changed hunks — see digest size caps>
  author: <login from `gh pr view --json author` (.author.login) — NOT a placeholder>
  merged_at: <ts>   vs   last_green: <ts>   vs   started_at: <ts>
  verdict: supported | ruled-out (<no-path-overlap | shipped-after | behind-off-flag | unrelated>)
  tag: regression | latent
  link: <canonical URL: https://github.com/<repo>/pull/<number>>
```

**Identity is `repo` + `number`, never the bare number.** A PR number is unique only
within its repo, so `ai-sdk#861` and `nl2steps#861` are different PRs; keying on the
number alone collapses them into one card. `link` MUST be the canonical
`https://github.com/<repo>/pull/<number>` — never a hand-assembled or guessed URL, or
it 404s / points at the wrong repo.

**Resolve `title` and `author` from the PR itself, not the window scan.** Before
emitting a suspect, run one `gh pr view <number> --repo <repo> --json title,author`
(batch it with the falsification probes) and take `title` from `.title` and `author`
from `.author.login`. Do **not** use the git merge-commit subject as the title (that is
how `"Merge EA-…"` leaked in) and do **not** write a placeholder like `"unknown"` for
author. If the connector can't resolve the field (GitHub unavailable / PR not found),
state that gap in the turn — never fabricate a title or invent an author.

`tag` — describes the **window-position of the supported causal change**, so it only
applies to a PR that is actually the cause (`verdict: supported`):
- **`regression`** — the causal PR merged **within** this run's window (`merged_at`
  after `last_green`, before `started_at`). A change in the drop *introduced* the
  failure → readiness-blocking.
- **`latent`** — the causal PR is a **pre-window** change (`merged_at` ≤ `last_green`)
  whose defect only surfaced now (env/data change, a newly-taken code path, dependency
  bump exposing it). The bug is real but *not introduced by this drop*.
- **No causal PR at all** (pure env/flake/data, or the hunt ended empty) → emit **no
  entry**. Do NOT attach a pre-window PR just to have something, and do NOT invent a
  `latent` tag to fill the shape — that mis-attribution is exactly the AIR-607 bug.

If the hunt ends empty after a real search (never fabricate):

```
no culprit PR identified after <what was searched: window, repos, paths>
```

## The `pr_details` hand-off contract (→ `tfaRcaTurn`)

Every **`verdict: supported`** suspect is passed to `tfaRcaTurn` as one entry of the
`prDetails` array — this is the structured PR context the TFA agent consumes (a bare
link in free text is not enough; incomplete PR context is what previously misled the
agent). All six fields are **required** per entry — never emit a partial PR object,
and never fill `title`/`author` with a placeholder (resolve them via `gh pr view` first):

```
prDetails: [
  {
    repo:   <owner/name>,        // string, e.g. browserstack/ai-sdk
    number: <#number>,           // integer, no "#"  (identity = repo + number)
    title:  <PR title>,          // string, from `gh pr view --json title`
    author: <login>,             // string, from `gh pr view --json author` (.author.login)
    link:   https://github.com/<repo>/pull/<number>,  // canonical URL only
    tag:    regression | latent  // exactly one; supported causal PR only
  }
]
```

Ruled-out suspects stay in the turn message as disconfirming evidence but do **not**
enter `prDetails`. If no culprit PR was identified, omit `prDetails` (or pass `[]`) —
never fabricate an entry to fill the shape.
