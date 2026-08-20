# Capability sequence

Load this file **before asking the first question**. It defines the order, what
each capability owes, and the rules that keep the interview short.

**Contents:** [The one rule](#the-one-rule-every-question-names-its-consumer) ·
[Order](#order) · [Per capability](#per-capability) ·
[Skip](#skip-is-free-except-once) · [The repo scan](#the-repo-context-scan)

## The one rule: every question names its consumer

A question may only be asked if something downstream reads its answer. This is not
a guideline — `lib/capability-table.mjs` refuses to load a table whose scope field
carries no `consumer` string, so an orphan question cannot reach a customer without
failing the suite first.

Practically: **never ask what the table does not declare.** The table is the
question list. If you find yourself wanting something it has no field for, that is
a table change with a test, not an improvised question.

## Order

GitHub → application logs → pipeline/CI → infra runtime → metrics/APM → an open
"anything else".

GitHub is first because it is the only mandatory one and the only one that can stop
setup — discovering that on question five, after the customer has answered four
optional ones, wastes their time and ours. CI is not a separate capability: it
routes to `github` in `evidenceRouting`, so its hints live on the GitHub row
and its questions are GitHub's.

`other` is last and never recognised by a hint. It is the catch-all for a stack
could not classify; matching it by accident would swallow the very thing it exists
to surface.

## Per capability

For each row in the table, in the order above:

1. **Read what is already resolved.** `planInterview()` returns `resolvedScope`
   and `unresolvedFields` per capability, plus the `questions` list itself. Ask only
   about those. If a connector skill pre-filled a field it is already resolved —
   do not confirm it for politeness.
2. **Ask one field at a time.** Each question names the field and, when it helps,
   why it is needed. Do not batch four fields into one prompt; a customer who gets
   one wrong then has to untangle which.
3. **Verify the resolved scope**, per target, through
   `<pluginRoot>/skills/rca-setup/references/verification-failures.md`.
4. **Record the outcome** as `detected | answered | skipped | failed`.

A capability marked `always-asked` in the table is never resolved by discovery even
when a hint coincidentally matches. A capability marked `partial` had its
tool found and still owes its scope.

## Skip is free, except once

Every capability except GitHub is skippable. A skip is:

- recorded as a structured gap with its classification and next action,
- **never re-asked in this session**,
- not a failure, and not a blocker.

**GitHub cannot be skipped.** A skip attempt is declined, the reason stated once,
and the same question re-posed:

> GitHub is the one thing I can't proceed without — without the code changes and
> the merged PRs there's no culprit PR to name, which is the entire output.

This is bounded. After **three** declines, or an explicit "I don't know", stop:
state that setup cannot move ahead, name both routes (`gh` or a GitHub MCP
server), and write a **partial** context so nothing already answered is lost. An
unbounded re-pose loop is worse than a clean refusal — the customer has told you
twice they cannot answer.

## The repo-context scan

Offered, never imposed, and it runs **inside** GitHub scope resolution rather than
after the full walk. Its output is the owned subpaths, and the only consumer of
those is GitHub's path-overlap falsification test — asking for it after metrics
would place the answer downstream of the verification that needs it.

Cheap by construction. A directory listing and a glance at the top level: is this a
monorepo, does it look like an API service, is there a consumer directory. Never a
file-by-file read, never a dependency graph. Three or four questions maximum, each
individually skippable, and the whole scan skippable in one word.

**When the scan is skipped wholesale, path-overlap records a gap.** It must not
fall back to whole-repo overlap: every PR touches the repo, so every PR would match
and attribution would return everything, which is worse than returning nothing
because it looks like an answer.
