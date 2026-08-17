# Template — SUSPECT packet (one block per candidate PR)

Fill one block per suspect, supported **and** ruled-out (elimination is evidence
too). Only `verdict: supported` suspects may feed `related_prs`. Guidance +
falsification protocol: `../references/github-evidence.md`.

```
SUSPECT:
  pr: <#number>
  title: <PR title, verbatim>
  files: <changed files overlapping the failing path>
  hunks: <the 1-3 load-bearing changed hunks — see digest size caps>
  author: <login>
  merged_at: <ts>   vs   last_green: <ts>   vs   started_at: <ts>
  verdict: supported | ruled-out (<no-path-overlap | shipped-after | behind-off-flag | unrelated>)
  tag: regression | latent
  link: <PR permalink>
```

`tag` (supported suspects only):
- **`regression`** — the PR merged **within** this run's regression window (`merged_at`
  after `last_green`, before `started_at`) and introduced the failure. A change in the drop.
- **`latent`** — a pre-existing cause surfaced now, **not** newly introduced by a
  windowed PR (e.g. an older merge, a flag flip, or an env/data change). Tag a suspect
  `latent` when its change predates `last_green` yet still explains the failure.

If the hunt ends empty after a real search (never fabricate):

```
no culprit PR identified after <what was searched: window, repos, paths>
```

## The `pr_details` hand-off contract (→ `tfaRcaTurn`)

Every **`verdict: supported`** suspect is passed to `tfaRcaTurn` as one entry of the
`prDetails` array — this is the structured PR context the TFA agent consumes (a bare
link in free text is not enough; incomplete PR context is what previously misled the
agent). All five fields are **required** per entry — never emit a partial PR object:

```
prDetails: [
  {
    title:  <PR title>,          // string, verbatim
    author: <login>,             // string
    link:   <PR permalink>,      // string (URL)
    number: <#number>,           // integer, no "#"
    tag:    regression | latent  // exactly one
  }
]
```

Ruled-out suspects stay in the turn message as disconfirming evidence but do **not**
enter `prDetails`. If no culprit PR was identified, omit `prDetails` (or pass `[]`) —
never fabricate an entry to fill the shape.
