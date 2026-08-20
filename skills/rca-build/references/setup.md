# Setup — the one-time interview, run inline when no context exists

Loaded for Step 1a. This was a separate `rca-setup` skill; it is a phase of this
one now. Two skills meant a customer whose first red build arrived before they
had heard of setup hit a refusal telling them to go run something else, and it
meant one flow's rules were maintained in two bodies, two API references and two
gate templates that had already drifted.

The division the phase rests on: **you resolve capability, the interview resolves
scope, verification proves both.** You can see that a forge CLI is on PATH or that
a metrics MCP server is in the session. You cannot see which namespace, which log
index, or which subpath of a monorepo is theirs. That residue — and only that — is
what a human is asked about.

**Contents:** [Order](#order) · [Per capability](#per-capability) ·
[Skip](#skip-is-free-except-once) · [The repo scan](#the-repo-context-scan) ·
[What counts as verified](#what-counts-as-verified) ·
[What you report](#what-you-report) · [Gap classes](#gap-classes) ·
[GitHub is binary](#github-is-binary) · [Secrets](#secrets) ·
[Where the context lives](#where-the-context-lives) · [Partials](#partials)

## Order

GitHub → application logs → pipeline/CI → infra runtime → metrics/APM → an open
"anything else".

GitHub is first because it is the only mandatory one and the only one that can stop
setup — discovering that on question five, after four optional answers, wastes the
customer's time and ours. CI is not a separate capability: it routes to `github` in
`evidenceRouting`, so its questions are GitHub's.

`other` is last. It is the catch-all for a stack you could not classify, so
matching it by accident would swallow the very thing it exists to surface.

## Per capability

For each row in `config.capabilities`, in the order above:

1. **Read what is already resolved** — from the context if one exists, from a
   connector skill's pre-fill, from build metadata. Ask only about the rest. Do not
   confirm a resolved field for politeness.
2. **Ask one field at a time.** A prompt carrying four fields means a customer who
   gets one wrong has to untangle which.
3. **Verify the resolved scope**, per target — see below.
4. **Record the outcome** as `detected | answered | skipped | failed`.

A row marked `resolvable: "always-asked"` is never resolved by inspection even when
a tool coincidentally looks right. `"partial"` means its tool can be found and it
still owes its scope.

**Never ask what the table does not declare.** `scopeFields` is the question list,
and every field in it names the step that reads the answer. Wanting something the
table has no field for is a table change with a test, not an improvised question —
an orphan question spends a customer's turn on an answer nothing will ever read.

## Skip is free, except once

Every capability except GitHub is skippable. A skip is recorded as a structured gap
with its class and next action, **never re-asked in this session**, and is not a
failure or a blocker.

**GitHub cannot be skipped.** Decline the skip, state the reason once, re-pose the
same question:

> GitHub is the one thing I can't proceed without — without the code changes and
> the merged PRs there's no culprit PR to name, which is the entire output.

Bounded: after **three** declines, or an explicit "I don't know", stop. State that
setup cannot move ahead, name both routes (`gh` or a GitHub MCP server), and write
a **partial** so nothing already answered is lost. An unbounded re-pose is worse
than a clean refusal — they have told you twice that they cannot answer.

## The repo-context scan

Offered, never imposed, and it runs **inside** GitHub scope resolution rather than
after the walk. Its output is the owned subpaths, and their only consumer is
GitHub's path-overlap falsification test; asking for them after metrics would put
the answer downstream of the check that needs it.

Cheap by construction: a directory listing and a glance at the top level — is this
a monorepo, does it look like an API service, is there a consumer directory. Never
a file-by-file read, never a dependency graph. Three or four questions maximum,
each individually skippable, and the whole scan skippable in one word.

**When the scan is skipped wholesale, path-overlap records a gap.** It must not
fall back to whole-repo overlap: every PR touches the repo, so every PR would
match, and attribution returning everything is worse than returning nothing
because it looks like an answer.

## What counts as verified

A live read against the **resolved scope** — not the presence of a tool, and not
the presence of a credential. A runtime CLI on PATH says nothing about whether the
named scope exists or whether this credential can see it. What counts for a given
capability is stated in that row's `intent`; read it, because it differs per row.

**Per target, not per tool.** A capability valid for one repo and 404 on another
stays valid for the one that passed; the failure is a scoped gap. Collapsing that
into a dead capability is what makes a coordinator degrade to "unavailable" over
one bad value.

**You choose the check.** There are no probe commands in the table. There were —
templates with the customer's scope interpolated in — and that design needed a
command gate, an interpolation guard and a per-runtime probe table to be safe,
produced a shell-injection escape anyway, and still could not verify a stack
nobody had listed. How to read a given app, index or metrics scope is your
judgement, and that is the only reason this works on a stack this repo has never
heard of.

## What you report

Per capability, one record:

```
{ capability, verified, via, targets: [{field, value, ok, checkedBy, gap?}],
  scopes?: [...], warnings: [...] }
```

| Field | Why |
|---|---|
| `via` | the tool or server you used, so a coordinator knows if it is talking to a CLI or an MCP server |
| `field` | which answer to fix — and it must be one the row DECLARES |
| `value` | what you checked it against |
| `ok` | your verdict for this target |
| `checkedBy` | **what you actually ran**, with its scoping arguments |
| `gap.class` | one of the three below, on a failure |
| `gap.nextAction` | non-empty, always — a diagnostic with no next step strands someone |

`checkedBy` is the load-bearing one. **A target reported `ok` with no `checkedBy`
is `unverified`, not verified** — a claim with no named check carries no
information, and this is precisely what stopped a capability probe standing in for
a scope it had never read. `githubGate` enforces it for the mandatory capability;
everywhere else it is on you, because everywhere else the consequence is a
degraded evidence line rather than a wrong culprit.

A target you could reach but could not prove is `{ok: false, state: "unverified"}`
and needs no gap: nothing is wrong, there is simply no evidence. That is a real
state, not a soft failure.

**Raw provider output never reaches a report.** Reduce a failure to its class and
next action; the bytes stay in your context. Not redacted-and-kept — a redacted
string still carries whatever the redactor missed, and this record ends up
committed. No `raw`/`stdout`/`stderr`/`body` anywhere in the shape.

If a value looks like a typo, say so in the `nextAction` — but only when you are
confident. A wrong suggestion sends someone to correct a value that was already
right, which costs more than saying nothing.

## Gap classes

Every gap carries one of `GAP_CLASS`, because the three need **opposite**
responses:

| Class | What happened | Right response |
|---|---|---|
| `absent-on-this-machine` | the tool or server is not here | a local-setup instruction naming what to install |
| `scope-invalid-for-team` | the tool works; the recorded scope does not resolve | a targeted re-ask of that scope |
| `credential-under-scoped-for-target` | the tool works and is authenticated, but this credential lacks rights here | neither of the above |

The third exists because both other responses are wrong for it. Re-asking team
scope invites one person to rewrite the team's shared value to fit their own
credential; a local-setup instruction names a tool they already have.

## GitHub is binary

`gh` or a GitHub MCP server. No degraded-completion class, and no third route —
the dashboard GitHub App is out of scope for this plugin.

On the MCP route you invoke the tool yourself: there is no command string for a
branch's merged-PR list over MCP, so the merged count you obtain **is** the
base-branch evidence on that route. Put the count in `checkedBy`.

```js
const gate = githubGate(report, table.github);
if (gate.blocking) stop(gate.message, gate.nextAction);
```

The gate requires every declared field in `scopeFields` to be COVERED by a proven target, not
merely that some target passed. A verified repo with a FAILED base branch used to
sail through — into the culprit-PR hunt over that branch, with the branch proven
unreachable and nothing said.

Failure wording, said once and plainly:

> GitHub is mandatory and I cannot move ahead without it. Without the code changes
> and the PRs merged into the branch under test, there is no culprit PR to name.

Then the next action, naming both routes. Then write the partial.

**The base-branch window.** `prWindowWarning` over a fixed 30-day lookback,
independent of any build and distinct from the run's per-build suspect window. Zero
merged PRs is a **warning, not a failure**: the branch is reachable, the window is
merely empty. It persists into the context rather than printing once, because it
predicts a dead culprit hunt and whoever reads the eventual "no culprit PR
identified" needs to know.

**Access level.** Report what the provider actually said. If it reports no scopes
at all — `gh` via keyring or device flow — that is its own state,
`not-reportable`, not "narrow" and not "broad"; both would be inventions. An
over-broad scope is a warning **alongside** a pass, never instead of it, and
`overBroadWarning` applies to GitHub only because the syntax it reads is GitHub's.

## Secrets

If a customer pastes a credential value: refuse it inline, do not echo it, give
rotation guidance, and go on asking for the environment-variable name instead. It
is already in the transcript once and repeating it doubles the exposure.

Detection is `looksLikeSecret`, **not** `redact`. `redact` needs a key prefix
(`token=`) or an auth scheme (`Bearer `) and returns text rather than a verdict, so
a bare pasted token comes back unchanged and a check built on it reports clean for
exactly the input that matters most. The same guard runs again at write time over
every field, including the credential-reference field — that is where a pasted
secret most plausibly lands, and the file is committed, where a leak is
effectively permanent.

## Where the context lives

`.rca-context.json`, at the working-tree root of the repo it declares as its
`homeRepo`. **Not under `.rca/`**: that holds per-run state and is gitignored by
convention, so a context there would trip the write-time check-ignore guard and
refuse to persist — correctly, since no teammate would ever inherit it.

Finding it is two stages bounded to three levels: each level from cwd upward,
**plus that level's immediate children**. The children half is the part that
matters — clones sit side by side under a workspace root, so a context committed to
the product repo is invisible from the automation repo if you only walk upward, and
the no-context path would then fire on a machine that is completely set up.

Two guards on acceptance: a candidate is accepted only when its declared `homeRepo`
matches the directory it was found in, nearest match winning; and **the plugin's own
root is always refused**, because the documented install flow leaves cwd inside the
plugin directory on a first run.

Writing resolves the destination separately — the declared home repo's
`git rev-parse --show-toplevel`, chosen from the repos actually verified. If no
verified repo resolves to a git working tree, persist nothing and say so: "run this
from inside the repository the context should be committed to" is actionable, a
file written to the wrong place is not. Then `writeRcaContext` refuses a
credential-shaped value in any field, and a destination the repo's ignore rules
exclude, naming the rule.

**And it is deliberately not hardened.** Every other persisted file here is 0600
inside a 0700 directory. This one is git-tracked, where that mode is neither
preserved nor meaningful. Never point `hardenStateDir` at it.

**After a successful write:** name the path and tell them to commit and push it.
Without that step the committed-file design delivers nothing over a local file and
the teammate inherits nothing.

**Drift fails loud.** Unparseable, wrong `schemaVersion` and missing required field
are three distinct named errors, and none of them is "no context". A hand-resolved
merge conflict silently treated as a missing context triggers a full re-interview,
which reads as the feature forgetting the customer.

## Partials

`complete: false` is first-class, written whenever the gate was reached but setup
could not close. One rule governs it: **a partial runs if and only if GitHub is
verified in it.** Its verified fields are used and its unanswered capabilities are
declared as gaps. A partial without verified GitHub is treated exactly like no
context at all. One rule, no third state, and a partial can never be mistaken for
a working setup.

Re-entering with a **valid complete** context is not a re-interview: show the gate,
allow per-field correction, persist only if something changed. If such a context's
GitHub no longer verifies, offer credential correction and re-verification
**only** — never the interview. A teammate was promised they would be asked for
credentials and nothing else, and on continued failure the committed file is not
rewritten.
