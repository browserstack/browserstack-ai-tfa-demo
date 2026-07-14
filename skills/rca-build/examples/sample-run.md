# Example — one full run (fictional data, matches the recorded-turn fixtures)

Invocation: `/rca-build awswx…fw2` (build id given; nothing else passed).

## 1. Gate closes (the only user-visible checkpoint)

```
GATE CLOSED — capability manifest:
  github ✅ valid (gh, authed) · k8s ✅ valid (ctx staging-euc1) · logs ❌ absent · metrics ❌ absent

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
  pr: #7421
  files: src/validators/build.ts
  hunks: `- allowEmpty: true` → `+ allowEmpty: false` (validator schema)
  author: jdoe
  merged_at: 2026-07-01T09:14Z   vs   last_green: 2026-07-01T02:10Z   vs   started_at: 2026-07-01T21:40Z
  verdict: supported
  link: https://github.com/acme/obs-api/pull/7421

SUSPECT:
  pr: #7418
  files: src/routes/builds.ts
  hunks: logging middleware reorder only
  author: asmith
  merged_at: 2026-06-30T18:02Z   vs   last_green: 2026-07-01T02:10Z   vs   started_at: 2026-07-01T21:40Z
  verdict: ruled-out (shipped-after check passed but no-path-overlap — hunks never touch the validator)
  link: https://github.com/acme/obs-api/pull/7418

ASK: Full run logs for test 39
TYPE: test_logs
FOUND: no
SUMMARY: out-of-scope — TFA owns test logs; skipped by contract.
```

## 3. Terminal output (glimpse only — NO local report)

```
RCA batch complete — build awswx…fw2 (7 failed → 3 clusters)

39  → c1 → RESOLVED  (high)  PR #7421 tightened buildName validator; related_prs: #7421
41  → c1 → RESOLVED  (high)  sibling of 39 (cluster confirm)
57  → c2 → RESOLVED  (med)   flaky selector wait; test-side
81  → c3 → PENDING   (—)     soft-pending, resumable (turnId recorded)
…

Full report on the Test Observability UI:
https://observability.browserstack.com/builds/awswx…fw2
```

State file: `<tmpdir>/bstack-rca/rca-state.awswx…fw2.csv` (resume-safe; re-run
the same build id to pick up the PENDING row).
