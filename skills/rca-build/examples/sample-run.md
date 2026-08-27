# Example — one full run (fictional data, matches the recorded-turn fixtures)

Invocation: `/rca-build awswx…fw2` (build id given; nothing else passed).

This run has a `.rca-context.json` already, so first contact does not run — the gate
is the only user-visible checkpoint **on a repeat run**. The first run in a repo
looks different: it interviews, then falls through into this same gate. See
`<pluginRoot>/skills/rca-build/references/interview.md`.

## 1. Gate closes (the only user-visible checkpoint on a repeat run)

```
GATE CLOSED — capability manifest:
  github ✅ valid (<forge cli>) · infra ✅ valid (<runtime cli>, <scope>) · logs ❌ gap · metrics ❌ gap

Intake:
  build id:        awswx…fw2            (given)
  product repo:    acme/obs-api         (assumed — from git remote)
  automation repo: acme/obs-e2e         (assumed — cwd holds the tests)
  working branch:  main                 (assumed — current branch)
  default branch:  main                 (assumed — origin HEAD)
  PRs in play:     none                 (gap)

Gaps declared to TFA: logs, metrics
Proceeding autonomously: discovery → clustering → fan-out (concurrency 5, turn-cap 6).
```

## 2. A NEEDS_INFO turn answered (what the coordinator sends back)

TFA asked: *"Did request-validation on POST /builds change since last green?"*
(`evidenceType: product_code`, priority high). The coordinator replies on the
same `threadId`:

```
ASK: Did request-validation on POST /builds change since last green?
TYPE: product_code
FOUND: yes
SUMMARY: Yes — the buildName validator was tightened to reject empty strings in the
suspect window. One PR touches the failing path; falsification below.
LINK: https://github.com/acme/obs-api/pull/7421

SUSPECT:
  repo: acme/obs-api
  pr: #7421
  files: src/validators/build.ts
  hunks: `- allowEmpty: true` → `+ allowEmpty: false` (validator schema)
  author: jdoe
  merged_at: 2026-07-01T09:14Z   vs   last_green: 2026-07-01T02:10Z   vs   started_at: 2026-07-01T21:40Z
  verdict: supported
  tag: regression (the payload validated before this hunk and stops after it)
  link: https://github.com/acme/obs-api/pull/7421

SUSPECT:
  repo: acme/obs-api
  pr: #7418
  files: src/routes/builds.ts
  hunks: logging middleware reorder only
  author: asmith
  merged_at: 2026-06-30T18:02Z   vs   last_green: 2026-07-01T02:10Z   vs   started_at: 2026-07-01T21:40Z
  verdict: ruled-out (shipped-after check passed but no-path-overlap — hunks never touch the validator)
  link: https://github.com/acme/obs-api/pull/7418
  (no tag — only a supported verdict carries one)

ASK: Full run logs for test 39
TYPE: test_logs
FOUND: no
SUMMARY: out-of-scope — TFA owns test logs; skipped by contract.
```

## 3. Terminal output (glimpse only — NO local report)

```
RCA analysis complete — build awswx…fw2
7 test(s) · 6 resolved · 1 pending

Full report on the Test Observability UI:
https://automation.browserstack.com/builds/awswx…fw2?tab=ai_report&subTab=aitfa
```

That is the **entire** in-Claude output. No root causes, no culprit PRs, no
per-test table — those are on the dashboard, authored by the BrowserStack agent.
The RESOLVED turn shown earlier is the coordinator↔TFA exchange (internal to the
loop), not something re-printed to the user at the end.

State file: `<tmpdir>/bstack-rca/rca-state.awswx…fw2.csv` (resume-safe; re-run
the same build id to pick up the PENDING row).
