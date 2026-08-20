# GitHub evidence — what to gather, and how to rule a suspect OUT

The worst automated-RCA outcome is **confidently blaming an innocent PR**. This
file is the contract for `product_code` / `deploy` / `ci` asks (the `github`
capability): the **exact** evidence to gather, and a **falsification protocol**
that tries to *disprove* each suspect before it enters `related_prs`.

> We do **not** ship a GitHub forensics harness or MCP tool. We specify what's
> needed and use whatever the client already has — **GitHub MCP if available,
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
below, and each candidate PR's falsification check. **None of these need to
see a prior result before running** — the only exception is when one call's
output supplies a literal input to the next (e.g., you need a PR number
back from a search before you can `gh pr view` it).

Issue every independent probe as its own tool call **within the same
message** — the same discipline `ai-tfa-coordinator.md`'s NEEDS_INFO step
already requires across multiple asks (`Promise.all` / concurrent gather)
applies here too, one level down, across multiple probes inside a single
ask. One call per file path, fired one message at a time, waiting for each
result before issuing the next, spends a full turn's think-time on every
individual `gh api` round trip even though the call itself finishes in
under two seconds — for a five-file changed-paths check that is the
difference between one batched message and five serialized ones. Plan the
full probe list first (every candidate file, every table row, every
falsification check that has no dependency on another probe's result), then
fire all of them together; only serialize the ones with a genuine
input-from-output dependency.

## Evidence each ask needs (be specific — no fishing)

| Ask intent | Gather exactly |
|---|---|
| "Did `<X>` change since the last passing run?" | the diff of `<X>`'s file/function between the **baseline ref** (last-green, or the configured fallback) and the build's commit — not the whole repo diff |
| "Which PRs are suspect?" | PRs **merged in the window** `(baselineRef, build commit]` that **touch the failing code path** — intersect changed files with the failing file/function |
| "Who/what last changed the failing line?" | `blame` on the specific failing lines (from the test's `file_path` + the error) |
| "What shipped to the run's env before the failure?" | deploy timeline (`gh` releases/tags + the env's deploy record); compare deploy time vs. the run's `started_at` |
| "Did CI change?" | the workflow-file diff + recent `gh run` history for the failing job |

Scope everything by the failing test's `file_path` + the error summary. The
build-level evidence (diff-since-last-green, PR window) is **pre-computed once**
and passed in — reuse it; do not re-fetch per test.

## Field-filtering — project before you pull, every call

The single most common way a gather call wastes context: pulling a full
object when the ask only needs one or two fields from it. This applies to
whichever connector resolved for `github` (most commonly the `gh` CLI today,
or a GitHub MCP tool) — every call should already be filtered to the field(s)
the ask needs, not filtered after the fact by reading past the noise. The
same discipline applies to `infra` gather calls (`kubectl` or whatever the
manifest resolved to), since the failure mode is identical.

| Need | Don't — pulls the whole object | Do — projects to the field(s) the ask needs |
|---|---|---|
| Repo exists / default branch | `gh api repos/OWNER/REPO` | `gh api repos/OWNER/REPO --jq '.default_branch'` |
| Branch exists on the shipping branch | `gh api repos/OWNER/REPO/branches/BRANCH` | `gh api repos/OWNER/REPO/branches/BRANCH --jq '.name'` |
| Commit history / PR-window search | `gh api "repos/OWNER/REPO/commits?sha=BRANCH&per_page=100"` | add `--jq '[.[] | {sha: .sha[0:8], date: .commit.committer.date, msg: (.commit.message | split("\n")[0])}]'` |
| PR metadata | `gh pr view N --repo OWNER/REPO` (full payload) | `gh pr view N --repo OWNER/REPO --json state,mergedAt,baseRefName,headRefOid,files,author` — `--json` is itself a field allowlist; list only the fields this ask uses |
| Pod / workload listing | `kubectl get pods -n NS -o wide` | `kubectl get pods -n NS -o custom-columns='NAME:.metadata.name,STATUS:.status.phase'` |
| Deploy / image state | `kubectl get deploy -n NS -o yaml` | `kubectl get deploy -n NS -o custom-columns='NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image'` |
| Log sweep | a raw `--tail` dump | `kubectl logs POD --since=<window> --tail=2000 \| grep -E '<correlation token>\|ERROR\|Exception'` — filter by the correlation token, never a raw tail |

**Never run the unfiltered form "to see the shape first."** An exploratory
raw call costs the same context whether or not its output ends up in the
digest — a bare repo or commit object routinely carries license/URL metadata
and a multi-hundred-character signature block that no evidence ask ever
consults. If the exact field path is genuinely unknown, learn the shape from
one throwaway call against a cheap target, then filter every real call from
that point on — never repeat the unfiltered form per repo, per PR, or per
test.

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
repo, pr, title, files, hunks, author, merged_at vs last_green vs started_at, verdict
with rule-out reason, tag, link) — copy it, don't retype it. A worked example (supported
+ ruled-out side by side) is in
[`../examples/sample-run.md`](../examples/sample-run.md).

Only `verdict: supported` suspects should end up in TFA's `related_prs`. Ruled-out
suspects stay in the thread as disconfirming evidence so TFA (and a human) can see
the elimination, not just the conclusion.

**Hand-off to TFA — the `pr_details` contract.** Every supported suspect is passed
to `tfaRcaTurn` via its `prDetails` param as a structured object with **all six**
required fields — `repo`, `number`, `title`, `author`, `link`, `tag`
(`regression | latent`). Identity is `repo`+`number` (a number is unique only within
its repo), and `link` must be the canonical `https://github.com/<repo>/pull/<number>`.
This is what keeps the PR context correct end-to-end; a bare link/number in free text
is not enough (that is what let the same `#861` collide across repos and 404 in
AIR-607). A case with no causal PR emits no entry — never fabricate one.

**`title` and `author` are mandatory-resolved from the PR, not the window scan.**
Run `gh pr view <number> --repo <repo> --json title,author` (the same call already in
the field-filtering table, batched with the falsification probes) and take `title` from
`.title` and `author` from `.author.login`. Never pass the git merge-commit subject as
the title, and never pass a placeholder such as `"unknown"` for author — both defeat the
point (the dashboard `related_prs.author`/title would render the placeholder). If the
field genuinely can't be resolved, state the gap; don't invent a value.

The exact shape + the `regression`-vs-`latent` rule are in `../templates/suspect-packet.md`.

## Digest discipline

Same caps as `references/evidence-routing.md`: prefer a PR **link** over pasting a
diff; at most 1 hunk (3 hard) per `product_code` snippet; never paste a full diff.
The packet is *findings*, not the haystack.
