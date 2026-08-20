# Example — one full setup (fictional data, matching `tests/fixtures/discovery/full-stack.json`)

Invocation: `/rca-setup`, run from `~/work/api` in a workspace holding `api`,
`e2e-tests` and the plugin checkout side by side.

The environment this walks through is the `full-stack` discovery fixture:
`gh`, `kubectl`, `logcli` and `promtool` on PATH, plus `k8s/deployment.yaml` in the
repo. Keeping the two in step is not cosmetic — `tests/prose-budget.test.mjs`
fails if this example names a capability or route the fixtures do not contain.

---

## 1. Discovery runs first, so the split is concrete

Discovery is fingerprint matching and costs nothing, so it happens before the
greeting. A canned "I have test logs, you have everything else" would be true and
useless; this is the same statement with the machine's actual contents in it.

```
Here's the split before we start.

I already have, through BrowserStack: test logs, traces, screenshots, and the
session for every failed test in a build.

I have none of your side — your code, your app logs, your pipeline, your cluster,
your metrics. That's what this conversation is for.

Looking at this machine, I found:
  gh              → github    (verified in a moment)
  kubectl         → infra
  logcli          → logs
  promtool        → metrics
  k8s/            → infra (a second route to the same capability)

So I don't need to ask what you run. I need to ask what's YOURS inside it —
which repos, which namespace, which index. Four questions, maybe five.

GitHub is the only one I can't proceed without: no code changes and no merged PRs
means no culprit PR to name, which is the whole output. Everything else is
optional and degrades to a recorded gap.
```

## 2. GitHub scope — the mandatory capability

```
Which repos should I treat as yours for this build? (comma-separated)
> acme/api, acme/e2e-tests
```

The repo-context scan sits **inside** this step, not after it — its output is the
owned subpaths, and the only thing that reads those is GitHub's path-overlap
falsification test. Asking it after metrics would put the answer downstream of the
verification that needs it.

```
`acme/api` looks like a monorepo — I see services/billing, services/invoicing and
services/gateway. Which are yours? ("all" is fine, "skip" is fine.)
> services/billing

Which branch does regression run against? I'll use it as the base for the
merged-PR window.
> main
```

## 3. Verification — per target, not per tool

```
Verifying github…
  acme/api          ✅ readable
  acme/e2e-tests    ✅ readable
  main              ✅ 7 PRs merged in the last 30 days
  scope             ⚠️  the token grants admin:org where read is enough
```

A capability valid for one repo and 404 on another stays valid for the one that
passed; the failure is a scoped gap, not a dead capability. The scope note is a
warning **alongside** the pass, never instead of it.

## 4. The optional capabilities

```
infra — I found kubectl. Which namespace should I look in?
> prod

Which workloads own these tests' failures? I use this to route log sweeps.
> billing-consumer

logs — I found logcli. Which index?
> skip

metrics — I found promtool. Namespace to query, or skip?
> skip

Anything else you'd want me to look at that I haven't asked about?
> no
```

`skip` is recorded as a gap and never re-asked this session. It is not a failure
and it does not block anything.

## 5. The gate

```
SETUP GATE — review before I persist anything.

Capabilities:
  github   ✅ verified   (gh, authed)      repos 2/2 · base branch main
  infra    ✅ verified   (kubectl)         namespace prod
  logs     ⚠️  skipped                      → recorded as a gap
  metrics  ⚠️  skipped                      → recorded as a gap

Scope:
  home repo:      acme/api                (answered)   ← the context is committed here
  repos:          acme/api, acme/e2e-tests (answered)
  owned subpaths: services/billing        (answered)
  base branch:    mian                    (answered)
  namespace:      prod                    (answered)
  workloads:      billing-consumer        (answered)
  credentials:    GH_TOKEN                (env-var name only — never the value)

Warnings:
  · the GH_TOKEN credential grants admin:org where read access is enough

Gaps recorded (the run proceeds; these degrade evidence, not the run):
  · logs — skipped at setup
  · metrics — skipped at setup

Destination: /Users/you/work/api/.rca-context.json

Correct any field by name, or confirm to persist.
> base branch
```

## 6. Correction, re-verified

```
Base branch was `mian`, which I couldn't reach. Did you mean `main`?
> main

Re-verifying just that field…
  main   ✅ 7 PRs merged in the last 30 days

base branch:  main  (answered)
Confirm to persist?
> yes
```

Only the corrected field is re-probed. A corrected field that keeps failing
persists as `unverified` after a bounded number of rounds — except GitHub, which
cannot end there: setup stops instead and writes a partial.

## 7. Persist, and the step that makes it worth committing

```
Written: /Users/you/work/api/.rca-context.json

Commit and push it so your teammates inherit this. Without that they get the
whole interview again, which is the one thing this file exists to prevent:

    git add .rca-context.json && git commit -m "chore: add RCA setup context"

It holds no credential values — only GH_TOKEN as a name. Safe to review in a PR.

Next: copy the /rca-build command from the AI Agents Report for any red build.
```

---

## The refusal path, for contrast

Same interview, on a machine with no `gh` and no GitHub MCP:

```
Verifying github…
  gh        ✗ not installed
  MCP       ✗ no GitHub MCP server in this session

GitHub is mandatory and I cannot move ahead without it. Without the code changes
and the PRs merged into the branch under test, there is no culprit PR to name.

  → Install and authenticate the `gh` CLI, or connect a GitHub MCP server, then
    re-run setup. (A credential may also be supplied as GH_TOKEN.)

I've saved what you already answered to
/Users/you/work/api/.rca-context.json as a partial, so when you come back I'll
only need the GitHub part:

  infra    ✅ verified   (kubectl)   namespace prod
  logs     ⚠️  skipped
  metrics  ⚠️  skipped
```

The partial is the point. A refusal costs a re-verify, not a re-interview — and
`complete: false` means every run against it refuses until GitHub is verified, so
the state can never be mistaken for a working setup.
