# Template — SUSPECT packet (one block per candidate PR)

Fill one block per suspect, supported **and** ruled-out (elimination is evidence
too). Only `verdict: supported` suspects may feed `related_prs`. Guidance +
falsification protocol: `<pluginRoot>/skills/rca-build/references/code-evidence.md`.

```
SUSPECT:
  pr: <#number>
  files: <changed files overlapping the failing path>
  hunks: <the load-bearing changed hunks — 1, at most 2; see evidence-routing.md § Size caps>
  author: <login>
  merged_at: <ts>   vs   last_green: <ts>   vs   started_at: <ts>
  verdict: supported | ruled-out (<no-path-overlap | shipped-after | behind-off-flag | unrelated>)
  link: <PR permalink>
```

If the hunt ends empty after a real search (never fabricate):

```
no culprit PR identified after <what was searched: window, repos, paths>
```
