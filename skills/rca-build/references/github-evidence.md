# GitHub evidence — what to gather, and how to rule a suspect OUT

The worst automated-RCA outcome is **confidently blaming an innocent PR**. This
file is the contract for `product_code` / `deploy` / `ci` asks (the `github`
capability): the **exact** evidence to gather, and a **falsification protocol**
that tries to *disprove* each suspect before it enters `related_prs`.

> We do **not** ship a GitHub forensics harness or MCP tool. We specify what's
> needed and use whatever the client already has — **GitHub MCP if available,
> else `gh`, else degrade** to an `unavailable` block.

## Capability discovery (in order)

1. **GitHub MCP** (`mcp__github__*`) — preferred for structured PR/diff/blame queries.
2. **`gh` CLI** — fall back for git-graph operations (`gh pr list --search`,
   `gh api`, `merge-base`, ancestry) and anything the MCP doesn't cover.
3. **Neither** → emit an `unavailable` block for the ask (do not fabricate a PR).

The orchestrator records which is present in the capability manifest
(`capability: github → { available, via }`); route every github ask against it.

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
populates deterministically:

```
SUSPECT:
  pr: <#number>
  files: <changed files overlapping the failing path>
  hunks: <the 1-3 load-bearing changed hunks — see digest size caps>
  author: <login>
  merged_at: <ts>   vs   last_green: <ts>   vs   started_at: <ts>
  verdict: supported | ruled-out (<reason: no-path-overlap | shipped-after | behind-off-flag | unrelated>)
  link: <PR permalink>
```

Only `verdict: supported` suspects should end up in TFA's `related_prs`. Ruled-out
suspects stay in the thread as disconfirming evidence so TFA (and a human) can see
the elimination, not just the conclusion.

## Digest discipline

Same caps as `references/evidence-routing.md`: prefer a PR **link** over pasting a
diff; at most 1 hunk (3 hard) per `product_code` snippet; never paste a full diff.
The packet is *findings*, not the haystack.
