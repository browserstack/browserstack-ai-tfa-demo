# Code evidence — what to gather, and how to rule a suspect OUT

The worst outcome an automated RCA can produce is **confidently blaming an
innocent change**. This is the contract for `product_code` / `deploy` / `ci` asks:
the evidence to gather, and a falsification protocol that tries to *disprove* each
suspect before it reaches `related_prs`.

We ship no forensics harness. We say what is needed and use whatever the team
already has — a forge MCP server, a forge CLI, or neither, in which case the ask
degrades to an `unavailable` block. The gate records which resolved and what it is
reached `via`; route every code ask against that.

**Contents:** [The culprit hunt](#a-product-bug-requires-a-culprit-hunt) ·
[Evidence per ask](#evidence-each-ask-needs) ·
[Project before you pull](#project-before-you-pull) ·
[Falsification](#falsification--rule-out-dont-just-rule-in) ·
[The suspect packet](#the-suspect-packet) · [Digest caps](#digest-caps)

## A product bug REQUIRES a culprit hunt

When TFA's working classification is `PRODUCT_BUG`, code evidence is not optional
context — it is the deliverable:

1. **What shipped** to the run's environment between the last passing run and this
   failure.
2. **Changed paths vs the failure signature** — intersect the window's changed
   files with the failing file or function.
3. **Falsify** each candidate, below.

Feed the surviving change's **link** to TFA so the dashboard RCA populates
`related_prs`. **A product-bug RCA with no code link is incomplete**: keep digging
until the turn cap. If nothing survives, the turn must state
`no culprit identified after <window, repos, paths searched>` and the CSV records
the gap. Never invent one. If the capability is unavailable, that same explicit
statement plus an `unavailable` block goes to TFA.

## Evidence each ask needs

Be specific. Fishing costs a turn and finds nothing.

| Ask intent | Gather exactly |
|---|---|
| "Did `<X>` change since the last passing run?" | the diff of `<X>`'s file or function between the baseline ref and the build's commit — not the whole repo diff |
| "Which changes are suspect?" | changes merged in the window `(baselineRef, build commit]` that **touch the failing code path** |
| "What last changed the failing line?" | blame on the specific failing lines, from the test's `file_path` plus the error |
| "What shipped to this environment before the failure?" | the deploy record for that environment; compare deploy time against the run's `started_at` |
| "Did CI change?" | the pipeline-definition diff plus recent run history for the failing job |

Scope everything by the failing test's `file_path` and error summary. Build-level
evidence — the window, the deploy state — is computed **once** and shared. Reuse
it; never re-fetch per test.

## Project before you pull

The most common way a gather call wastes context is pulling a whole object when
the ask needs one field of it. Filter at the call, not afterwards by reading past
the noise.

This is about projection, not about any particular tool. Whatever resolved for a
capability, the same shape applies:

| Need | Wasteful | Projected |
|---|---|---|
| Does the repo exist / what is its default branch | fetch the whole repo object | ask for that one field |
| Does the branch exist | fetch the whole branch object | ask for its name |
| Commit history for a window | the full commit list with every field | sha, date and subject line only |
| Change metadata | the entire payload | the specific fields this ask reads — state, merged-at, base ref, changed files, author |
| Workload or instance listing | the full description of every one | name and status columns only |
| Deployed version | the whole spec | the image or version field |
| Log sweep | a raw tail dump | filter by the correlation token at the source, never a raw tail |

**Do not run the unfiltered form "to see the shape first."** An exploratory call
costs the same context whether or not its output reaches the digest, and a bare
object routinely carries license, URL and signature metadata no ask consults. If
the field path is genuinely unknown, learn it from one throwaway call against a
cheap target, then filter every real call after that — never repeat the unfiltered
form per repo, per change, or per test.

## Falsification — rule out, don't just rule in

For **each** candidate, try to break the hypothesis:

1. **Path overlap.** Do the changed hunks actually touch the failing code path —
   the function or line in the stack? No overlap → **ruled out**.
2. **Was it live?** Was this code actually running in that environment at
   `started_at`? Shipped after the failure window, or behind an off flag → **ruled
   out**.
3. **Direction.** Does the change plausibly produce *this* error — a validator
   tightened to reject the input the test sends, say? Unrelated to the symptom →
   **weak**, and marked so.

Report **both supporting and disconfirming** evidence. A candidate surviving all
three is real; one failing any is reported ruled-out **with the reason**, never
dropped silently. The elimination is the evidence that the survivor means
something.

## The suspect packet

One structured block per candidate, so `related_prs` populates deterministically.
The fillable format is
`<pluginRoot>/skills/rca-build/templates/suspect-packet.md` — copy it rather than
retyping. A worked example, supported and ruled-out side by side, is in
`<pluginRoot>/skills/rca-build/examples/sample-run.md`.

Only `verdict: supported` reaches `related_prs`. Ruled-out candidates stay in the
thread as disconfirming evidence, so TFA and a human can see the elimination
rather than just the conclusion.

## Digest caps

The caps live in one place —
`<pluginRoot>/skills/rca-build/references/evidence-routing.md` § Size caps — and
this file does not restate them, because three files each carrying their own hunk
number is how they came to disagree (1, 2 and 3 for the same field). Prefer a
**link** over pasting a diff. The packet is findings, not the haystack.
