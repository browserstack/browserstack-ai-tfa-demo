---
name: rca-setup
description: One-time setup conversation for the RCA plugin. Discovers what this machine already has (executables, MCP servers, repo fingerprints), interviews only for the scope discovery cannot resolve, verifies every capability with a live read, confirms at a single gate, and persists a commit-safe context the run skill consumes. GitHub via gh or a GitHub MCP server is mandatory; everything else degrades to a recorded gap. Args: none — run it once per repo.
---

# rca-setup — the one-time setup conversation

Run once per repo. Produces `.rca-context.json`, committed, which `/rca-build`
consumes so the repeat loop asks nothing.

The division this whole flow rests on: **discovery resolves capability, the
interview resolves scope, verification proves both.** Discovery can find that `gh`
is on PATH or that a Prometheus MCP server is in the session. It cannot find which
namespace, which log index, or which subpath of a monorepo is yours. That residue —
and only that — is what a human gets asked about.

## Mandated reading

Files this skill's flow requires loading. The per-skill API guard in
`tests/wiring.test.mjs` asserts that every `lib/` export this skill drives is
documented across this set, and the prose-budget check measures this set plus this
body. Paths are `pluginRoot`-qualified because a subagent starts in an unknown cwd.

- `<pluginRoot>/skills/rca-setup/references/api-reference.md`
- `<pluginRoot>/skills/rca-setup/references/capability-sequence.md`
- `<pluginRoot>/skills/rca-setup/references/verification-failures.md`
- `<pluginRoot>/skills/rca-setup/references/context-resolution.md`

- `<pluginRoot>/skills/rca-setup/templates/gate-digest.md`
- `<pluginRoot>/skills/rca-setup/templates/context-file.md`

## Reference material (not loaded per run)

Read when you want the shape of a whole run, not on the way through one — which is
why it sits outside the mandated set the budget measures.

- `<pluginRoot>/skills/rca-setup/examples/sample-setup.md` — one worked interview,
  pinned to `tests/fixtures/discovery/full-stack.json`.

## Step 0 — mode

**Headless (`claude -p`) does not interview.** Load the context, validate it,
report the result, and end. Fail fast when none exists. There is no synchronous
human to answer a question, so asking one would hang.

Interactive, and a **valid complete** context already exists → this is not a
re-interview. Show the gate, accept per-field correction, persist only if something
changed. "Valid" means schema-valid; see Step 5 for the case where such a
context's GitHub no longer verifies.

## Step 1 — discover, before saying anything

Collect the environment and hand it to `discover()`:

- executables on PATH from the table's fingerprints,
- MCP servers present in this session,
- repo fingerprint paths that exist,
- connector-shaped skills at `.claude/skills/`, `../.claude/skills/`,
  `../../.claude/skills/`, `~/.claude/skills/`.

Discovery is fingerprint matching — nothing is executed, so it is cheap enough to
run before the greeting. Load the table with `loadCapabilityTable`; a non-empty
`violations` array is a bug in the shipped config, not a customer problem — report
it and stop.

Connector skills are a **less-trusted** input, not a more-trusted one: they are
read from four filesystem paths including a home directory, so any scope probe they
declare passes the same gate as a shipped probe, and they may only fill fields the
table declares.

## Step 2 — greet with what you found

Name the split concretely: what BrowserStack already has (test logs, traces,
screenshots, sessions) versus what only they can supply. Then list what discovery
actually found on this machine, and say how many questions remain.

A canned split is true and useless. The concrete one — "you have `gh` and
`kubectl`; I need your namespace and your log index" — is the same statement with
the machine in it, and it tells the customer the interview is short.

Say once, here, that GitHub is the only capability that can stop setup.

## Step 3 — walk the capabilities

Follow `<pluginRoot>/skills/rca-setup/references/capability-sequence.md`. In short:
GitHub first, then logs, pipeline/CI, infra, metrics, then an open "anything else".
One question per turn, only for `unresolvedFields`, only for fields the table
declares. Every optional capability is skippable; a skip is a recorded gap and is
never re-asked. GitHub is not skippable and the refusal is bounded.

The repo-context scan runs **inside** GitHub scope resolution, because its output is
the owned subpaths and GitHub's path-overlap test is their only consumer.

## Step 4 — verify

Follow `<pluginRoot>/skills/rca-setup/references/verification-failures.md`. Live
read per resolved target through `verifyCapability`, and `verifyGithub` for GitHub.
Per target, not per tool. On the MCP route you invoke the tool and hand the result
to the verifier.

If a customer pastes a credential value at any point: refuse it, do not echo it,
give rotation guidance, and continue asking for the variable name instead.

## Step 5 — the gate

Print the digest from `<pluginRoot>/skills/rca-setup/templates/gate-digest.md`.
Tagged fields, gaps, warnings, destination — never raw probe output.

Accept correction **per field**, and re-verify only that field. Bounded: after a
stated number of rounds a still-failing field persists as `unverified`.

**GitHub is exempt from `unverified`.** It is the only mandatory capability, so a
context that closed with GitHub unverified would claim completeness while every run
against it refuses, and the customer would have no signal which rule applies. When
GitHub correction exhausts its rounds, stop with the binary refusal and write a
partial instead of closing.

**An inherited context whose GitHub no longer verifies** gets the gate with GitHub
tagged `failed` and credential correction plus re-verification **only** — never the
interview. A teammate was promised they would be asked for credentials and nothing
else. On continued failure, refuse with the credential named, and do not rewrite
the committed file.

## Step 6 — persist and hand off

`writeRcaContext`. On refusal, report the code and its next action; a
`secret-in-field` refusal also says to rotate the value that was pasted.

On success: name the path, and **tell them to commit and push it**. Without that
step the committed-file design delivers nothing over a local file and the teammate
inherits nothing. Then point at `/rca-build` for a red build.

## Hard rules

- Never ask for a field the capability table does not declare. The table is the
  question list.
- Never re-ask a skipped capability in the same session.
- GitHub is mandatory and the refusal is bounded — decline a skip, re-pose, and
  after three declines stop and write a partial.
- Never echo a pasted credential. Refuse, guide rotation, ask for the variable name.
- Never print raw probe output. Class plus next action.
- Every failure record names a next action.
- GitHub never persists as `unverified` — write a partial instead.
- A teammate is asked for credentials only, never the interview.
- Never point `hardenStateDir` at the context file. It is git-tracked.
- Every reference pointer is `pluginRoot`-qualified, never a bare `references/…`.
