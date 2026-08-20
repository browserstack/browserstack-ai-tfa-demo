# Context resolution

Load this file **before reading or writing the context**. Signatures are in
`<pluginRoot>/skills/rca-setup/references/api-reference.md`; this file is the
behaviour around them.

**Contents:** [Where it lives](#where-it-lives) · [Finding it](#finding-it) ·
[Writing it](#writing-it) · [Drift](#drift-fails-loud) ·
[Partials](#partials) · [Sessions](#what-session-means)

## Where it lives

`.rca-context.json`, at the working-tree root of the repo it declares as its
`homeRepo`.

**Not under `.rca/`.** That directory holds per-run state and is gitignored by
convention, so a context placed there would trip the write-time check-ignore guard
and refuse to persist — correctly, since it would never be committed and no
teammate would inherit it.

## Finding it

Two stages, bounded to three levels: each level from cwd upward, **plus that
level's immediate children**.

The children half is the part that matters. Clones sit side by side under a
workspace root, so a context committed to the product repo is invisible from the
automation repo if you only walk upward — and the run's no-context refusal would
then fire on a machine that is completely set up. That reads to a customer as the
feature being broken.

Two guards on acceptance:

- A candidate is accepted only when its declared `homeRepo` matches the directory
  it was found in. Nearest match wins.
- **The plugin's own root is always refused.** The documented install flow is
  `git clone <plugin> && cd <plugin> && claude --plugin-dir ./`, so cwd IS the
  plugin directory on a first run. A context there is inherited by nobody.

## Writing it

Read-side resolution does not prevent a bad write, so the destination is resolved
separately: the declared home repo's `git rev-parse --show-toplevel`, chosen from
the repos setup actually verified. If no verified repo resolves to a git working
tree, persist nothing and say so — "run setup from inside the repository the
context should be committed to" is actionable; a file written to the wrong place is
not.

Then two refusals before anything lands:

1. **A credential-shaped value in any field**, including the credential-reference
   field. It is committed, where a leak is effectively permanent, and unlike the
   run's temp files it has no permission backstop — this guard is the only control.
2. **A destination the repo's ignore rules exclude**, with the rule named.

**And it is deliberately not hardened.** Every other persisted file in `lib/` is
0600 inside a 0700 directory. This one is git-tracked, where that mode is neither
preserved nor meaningful. Never point `hardenStateDir` at it.

## After a successful write

Name the path, and tell the engineer to commit and push it. This step is not
optional politeness — without it the committed-file design delivers nothing over a
local file, and the teammate inherits nothing.

## Drift fails loud

Unparseable, wrong `schemaVersion`, and missing required field are **three distinct
named errors**. None of them is "no context".

That distinction is the whole point. A hand-resolved merge conflict silently
treated as a missing context triggers a full re-interview, which reads as the
feature forgetting the customer. The repo's own precedent is the same: `readRows`
in `lib/csv-state.mjs` throws on a foreign header rather than dropping columns.

## Partials

`complete: false` is first-class, written whenever the gate was reached but setup
could not close. One rule governs it downstream:

**A partial runs if and only if GitHub is verified in it.**

GitHub is the mandatory capability, so a partial carrying verified GitHub is
genuinely runnable — its verified fields are used and its unanswered capabilities
are declared as gaps. A partial without verified GitHub refuses exactly like no
context at all. One rule, no third state, and the run can never mistake a partial
for a working setup.

## What "session" means

A skip is never re-asked "in this session" — meaning one invocation of this skill.
A later invocation reads the persisted context and asks only about what is
unresolved there, so a recorded skip stays a skip until someone edits the file or
re-runs setup deliberately.

Re-invoking with a **valid complete** context is not a re-interview: show the gate,
allow per-field correction, persist only if something changed. Valid means
schema-valid — if that context's GitHub no longer verifies, offer credential
correction and re-verification **only**, never the interview. A teammate was
promised they would be asked for credentials and nothing else.
