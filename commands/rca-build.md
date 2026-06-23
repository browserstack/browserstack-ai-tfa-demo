---
description: Run collaborative RCA over all failed tests of a BrowserStack build
---

# /rca-build

Entry point for the generic RCA harness. Drives a collaborative root-cause
analysis loop over **every failed test** of a build, generic across product and
infra.

## Input

`$ARGUMENTS` carries the build id (and optional flags). Accepted forms:

- bare build id: `qzqhbfa5bkjakcbxtvy2siwtpcvsvgm9fxfyb03d5`
- `build_id=<id>`
- a build dashboard link (the id is extracted)
- optional `mode=auto` | `mode=interactive` (default: prompt the user)

Parse the build id. If none is present, this is a required input:

- in an interactive session → ask the user for it
- in headless (`claude -p`) → **end immediately** (fail fast), do not hang

## Behavior

Invoke the `rca-build` skill, passing the parsed build id and mode. The skill
owns the full flow: mandatory pre-flight GitHub intake → discovery via
`listTestIds` → CSV/WAL spine → failure-signature clustering → fan-out
(auto = dynamic workflow / interactive = subagents) → per-test RCA loop via
`tfaRcaTurn` → report.

Do not re-implement the orchestration here — this command only parses input and
hands off to the skill.
