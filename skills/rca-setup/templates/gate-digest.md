# Template — setup gate digest (printed once, before anything is persisted)

Extends `<pluginRoot>/skills/rca-build/templates/gate-summary.md`. That template
tags every intake field `given | assumed | gap`; setup needs a wider vocabulary,
because a field here can have been resolved without asking, answered by a human,
deliberately skipped, or proven broken:

| Tag | Meaning |
|---|---|
| `detected` | Discovery resolved it. No question was asked. |
| `answered` | The human supplied it. |
| `skipped` | The human declined it. Recorded as a gap, never re-asked this session. |
| `failed` | Verification ran and the value is wrong or unreachable. |
| `unverified` | Corrected at the gate, but re-verification did not pass within its round budget. **GitHub can never end here** — see below. |

**The "not available" list comes from `reportableUnavailable`, never from the raw
set.** `unavailableCapabilities(manifest)` takes only the manifest and cannot read a
table field, so `other` — the catch-all, which can never match a fingerprint — would
be reported every single run. Print
`reportableUnavailable(unavailableCapabilities(manifest), table)`; it honours
`exemptFromDiscoveryReport`. The manifest and the TFA-facing declaration still mark
the capability unavailable — only this human-facing line suppresses it.

**A context adopted from outside this repo says so.** `readRcaContext` returns a
`trust` label: `own-worktree` and `origin-match` are evidence, `tracked` means
someone committed it deliberately, and `name-only` means the only link is a
directory name the file itself declared. On `name-only`, print the path and the
label above the digest — adopting a file that drives repos, branch and the overlay
must never be silent.

**Never raw probe output.** A digest is a decision surface. The failure taxonomy
in `<pluginRoot>/skills/rca-setup/references/verification-failures.md` reduces
every provider error to a class plus a next action; that class is what prints.

```
SETUP GATE — review before I persist anything.

Capabilities:
  github   ✅ verified   (gh, authed)          repos 2/2 · base branch main
  infra    ✅ verified   (kubectl)             namespace prod
  logs     ⚠️  skipped                          → recorded as a gap
  metrics  ✅ verified   (prometheus MCP)
  other    –  not applicable

Scope:
  home repo:      <org/repo>              (answered)   ← the context is committed here
  repos:          <org/a>, <org/b>        (answered)
  owned subpaths: <services/billing>      (answered)
  base branch:    <branch>                (detected)
  namespace:      <ns>                    (answered)
  workloads:      <a>, <b>                (answered)
  log index:      —                       (skipped)
  credentials:    GH_TOKEN                (env-var name only — never the value)

Warnings:
  · <branch> has no merged PRs in the last 30 days — culprit-PR attribution will
    have nothing to search. Expected on a quiet branch; worth a look otherwise.

Gaps recorded (the run proceeds; these degrade evidence, not the run):
  · logs — skipped at setup

Not available on this machine:
  · <capability> — <install the CLI | connect the MCP server>

Destination: <abs path>/.rca-context.json   (commit and push it so teammates inherit it)

Correct any field by name, or confirm to persist.
```

## Correction

Per field, not approve-or-reject: one wrong value must not cost the whole
interview. A corrected field is re-verified before it is persisted. If
re-verification keeps failing, the field persists as `unverified` after a stated
number of rounds so the loop is bounded — with one exception.

**GitHub is exempt from `unverified`.** It is the only mandatory capability, so a
context that closed the gate with GitHub unverified would claim completeness while
every run against it refuses — and the customer would have no signal which rule
applies. When GitHub correction exhausts its rounds, setup stops with the binary
refusal and writes a **partial** context (`complete: false`) instead of closing.
Nothing answered so far is lost.
