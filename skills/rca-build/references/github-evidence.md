# GitHub evidence — what to gather, and how to rule a suspect OUT

This file is the contract for `product_code` / `deploy` / `ci` asks (the
`github` capability): the **exact** evidence to gather, and a **falsification
protocol** that tries to *disprove* each suspect before it enters `related_prs`.

> Uses whatever the client already has — **GitHub MCP if available,
> else `gh`, else degrade** to an `unavailable` block.

**Contents:** [Capability discovery](#capability-discovery-in-order) ·
[Culprit-PR hunt](#application-bugs-require-a-culprit-pr-hunt-mandatory) ·
[Batching probes](#batch-every-independent-probe-into-one-message--never-one-call-per-turn) ·
[Evidence per ask](#evidence-each-ask-needs-be-specific--no-fishing) ·
[Field-filtering](#field-filtering--project-before-you-pull-every-call) ·
[Falsification protocol](#falsification-protocol--rule-out-dont-just-rule-in) ·
[Suspect packet](#the-suspect-packet-structured-not-free-text) ·
[Digest discipline](#digest-discipline)

## Capability discovery (in order)

1. **GitHub MCP** (`mcp__github__*`) — preferred for structured PR/diff/blame queries.
2. **`gh` CLI** — fall back for git-graph operations (`gh pr list --search`,
   `gh api`, `merge-base`, ancestry) and anything the MCP doesn't cover.
3. **Neither** → emit an `unavailable` block for the ask (do not fabricate a PR).

The gate records which is present **and probe-validated** (`gh auth status` /
GitHub MCP tools listed) in the capability manifest
(`capability: github → { available, via }`); route every github ask against it.

## Application bugs REQUIRE a culprit-PR hunt (mandatory)

Whenever TFA's working classification is **PRODUCT_BUG / application bug**, the
github connector is not optional evidence — it is the deliverable. The
coordinator MUST hunt the culprit PR:

1. **Deploy timeline vs last-pass window** — what shipped to the run's env
   between the last passing run and this failure.
2. **Changed paths vs failure signature** — intersect the window's PRs' changed
   files with the failing file/function from the signature.
3. Run the falsification protocol below on each candidate.

Feed the surviving PR **link(s)** to TFA in the turn message so the BrowserStack
agent populates `related_prs` in the dashboard RCA. **An application-bug RCA
with no GitHub PR link is INCOMPLETE**: keep digging on subsequent turns until
the turn cap. If still none, the turn must explicitly state
`no culprit PR identified after <what was searched: window, repos, paths>` and
the CSV row records the gap. Never fabricate a PR; if the github connector is
invalid/absent, the same explicit statement plus an `unavailable` block goes to
TFA (a gate-recorded gap).

## Batch every independent probe into one message — never one call per turn

This hunt routinely needs several `gh` calls that don't depend on each
other's output: a commit-history check per candidate file in "changed paths
vs failure signature," each row of the "Evidence each ask needs" table
below, and each candidate PR's falsification check. The only exception is
when one call's output supplies a literal input to the next (e.g., you need
a PR number back from a search before you can `gh pr view` it).

Issue every independent probe as its own tool call **within the same
message**. Plan the full probe list first (every candidate file, every table
row, every falsification check that has no dependency on another probe's
result), then fire all of them together; only serialize the ones with a
genuine input-from-output dependency.

## Evidence each ask needs (be specific — no fishing)

| Ask intent | Gather exactly |
|---|---|
| "Did `<X>` change since the last passing run?" | the diff of `<X>`'s file/function between the **baseline ref** (last-green, or the configured fallback) and the build's commit — not the whole repo diff |
| "Which PRs are suspect?" | Candidates are **the merged-PR set for the window** `(baselineRef, build commit]` **or the set the customer supplied at invocation** — then, either way, the ones that **touch the failing code path**: intersect changed files with the failing file/function |
| "Who/what last changed the failing line?" | `blame` on the specific failing lines (from the test's `file_path` + the error) |
| "What shipped to the run's env before the failure?" | deploy timeline (`gh` releases/tags + the env's deploy record); compare deploy time vs. the run's `started_at` |
| "Did CI change?" | the workflow-file diff + recent `gh run` history for the failing job |

Scope everything by the failing test's `file_path` + the error summary. The
build-level evidence (diff-since-last-green, PR window) is **pre-computed once**
and passed in — reuse it; do not re-fetch per test.

## Field-filtering — project before you pull, every call

Every gather call should already be filtered to the field(s) the ask needs,
not filtered after the fact by reading past the noise. This applies to
whichever connector resolved for `github` and equally to every `infra`, `logs` and
`metrics` gather call, whatever the manifest resolved to.

| Need | Don't — pulls the whole object | Do — projects to the field(s) the ask needs |
|---|---|---|
| Repo exists / default branch | `gh api repos/OWNER/REPO` | `gh api repos/OWNER/REPO --jq '.default_branch'` |
| Branch exists on the shipping branch | `gh api repos/OWNER/REPO/branches/BRANCH` | `gh api repos/OWNER/REPO/branches/BRANCH --jq '.name'` |
| Commit history / PR-window search | `gh api "repos/OWNER/REPO/commits?sha=BRANCH&per_page=100"` | add `--jq '[.[] | {sha: .sha[0:8], date: .commit.committer.date, msg: (.commit.message | split("\n")[0])}]'` |
| PR metadata | `gh pr view N --repo OWNER/REPO` (full payload) | `gh pr view N --repo OWNER/REPO --json state,mergedAt,baseRefName,headRefOid,files,author` — `--json` is itself a field allowlist; list only the fields this ask uses |
| Workload listing | the runtime's full description of every workload | its name-and-status projection, whatever that runtime calls it |
| Deploy / image state | the whole spec or manifest | just the image or version field |
| Log sweep | a raw tail dump | filter by the correlation token **at the source**, with an explicit window and limit — never a raw tail you then read past |
| Metric read | every series the backend will return | the one series the ask needs, over the build's window |

The GitHub rows above are concrete because GitHub is mandatory, so there is exactly
one tool family to be concrete about. The rows in this second group are shapes
rather than commands on purpose: the runtime, log store and metrics backend are
whatever the customer recorded, and naming one here would teach it as the default.
Read the projection flag off `--help` once, then filter every real call.

**Never run the unfiltered form "to see the shape first."** If the exact
field path is genuinely unknown, learn the shape from one throwaway call
against a cheap target, then filter every real call from that point on —
never repeat the unfiltered form per repo, per PR, or per test.

## Falsification protocol — rule out, don't just rule in

For **each** candidate suspect PR, try to **break** the hypothesis:

1. **Path overlap.** Do the PR's changed hunks actually touch the failing code
   path (the function/line in the stack)? No overlap → **ruled out**.
2. **Deployment-state guard.** Was the PR's code actually **live** in the run's
   env at `started_at`? If it shipped *after* the failure window, or sits behind
   an **OFF** flag, it could not have caused this failure → **ruled out**.
3. **Direction.** Does the change plausibly produce *this* error (e.g. a validator
   tightened to reject the input the test sends)? If the change is unrelated to
   the symptom → **weak**, mark accordingly.

Feed **both supporting and disconfirming** evidence back to TFA. A suspect that
survives 1–3 is a real candidate; one that fails any is reported as ruled-out
(with the reason), **not** dropped silently.

## The suspect packet (structured, not free text)

Each surviving/ruled-out suspect is one structured block so `related_prs`
populates deterministically. **The canonical fillable format lives in
[`../templates/suspect-packet.md`](../templates/suspect-packet.md)** (fields:
pr, files, hunks, author, merged_at vs last_green vs started_at, verdict with
rule-out reason, link) — copy it, don't retype it. A worked example (supported
+ ruled-out side by side) is in
[`../examples/sample-run.md`](../examples/sample-run.md).

Only `verdict: supported` suspects should end up in TFA's `related_prs`. Ruled-out
suspects stay in the thread as disconfirming evidence so TFA (and a human) can see
the elimination, not just the conclusion.

## A supplied candidate set

When the invocation carried a PR list it **replaces the enumeration**, not the analysis
(`SKILL.md` § Step 0, § Step 4). It is the superset of merged PRs — good and bad together
— so nothing about the work below changes: intersect, falsify, eliminate. Finding the bad
ones is still the deliverable and still ours.

Three things follow, and they are the whole difference:

- **Never search for more, in any repo.** The set is complete by the customer's statement.
  A repo their list does not name has no candidates, which the gate warns about; it is not
  an invitation to go looking.
- **Report every supplied PR, including the ones you rule out, with the reason.** They
  asked us to consider it, so dropping it silently reads as ignoring them. `prDetails`
  cannot carry a rule-out — its `tag` is `latent|regression`, with no third value — so
  eliminations travel in the turn message, the same place ruled-out suspects already go.
- **No survivor across the whole set is a FINDING, not a weak hunt.** Say so plainly: no
  merged PR explains this failure. The `INCOMPLETE` rule that otherwise sends a coordinator
  digging to the turn cap does not apply, because there is nothing left to enumerate
  (`agents/ai-tfa-coordinator.md` § the culprit-PR mandate).

**Supported suspects travel in `tfaRcaTurn`'s `prDetails`, never in the message text.**
The packet's fields exist to be handed over structured: `repo`, `pr`, `title`, `author`,
`link` and `tag` map one-to-one onto the six `prDetails` requires. `related_prs` is an
optional field in the RCA the BrowserStack agent synthesises, so a PR that arrived as
prose is the one that gets dropped — a sampled run sent `prDetails` zero times across
sixteen coordinators, because the instruction said to put links in the message.
`agents/ai-tfa-coordinator.md` § the culprit-PR mandate holds the contract.

## Digest discipline

Same caps as `references/evidence-routing.md`: prefer a PR **link** over pasting a
diff; at most 1 hunk (3 hard) per `product_code` snippet; never paste a full diff.
The packet is *findings*, not the haystack.
