---
name: rca-build
description: Autonomous batch RCA over every failed test of a BrowserStack build via tfaRcaTurn. First contact interviews you once and writes .rca-context.json; every run after that is one gate (context validation + resolved intake) then fully autonomous — clusters failures, routes evidence, triggers the dashboard report. Args: build id, optional PR URLs / repo hints.
---

# rca-build — single-gate autonomous RCA over a build

Drives the `tfaRcaTurn` collaborative loop over **every failed test** of a build
and lands a per-test RCA in the TRA (Test Observability) dashboard. **TFA owns
logs; the client agent owns everything else** (product code, infra/runtime, logs,
metrics, deploy, ci) — routed by capability, generic over product and infra.

This skill is the **build-level orchestrator** (`ai-tfa-orchestrator` role). It
dispatches the `ai-tfa-coordinator` (test-level) per test/cluster member, which
drives the loop and lets TFA author the dashboard RCA — the one narrow
exception is Step 4b's turn-1 pre-dispatch, a single direct `tfaRcaTurn` call
per cluster representative, concurrent with Step 4. **The full RCA report
lives on the Test Observability UI, not in Claude** — this run's job is to feed it, then surface a terse glimpse and the
link.

There are two lifecycles. **First contact** (Step 0b) runs once per repo: it
interviews you and writes `.rca-context.json`. **Every run after that** has exactly
one mode — autonomous — and exactly one gate (Step 1) before execution; after that
gate closes, the run never asks the user anything again.

Which lifecycle you are in is decided by a file, not by judgement — see
§ The question budget.

Config (concurrency, turn-cap, paths, evidence registry) lives in
`config/rca.config.json`. State lives in the CSV/WAL spine (`lib/csv-state.mjs`).

<use_parallel_tool_calls>
Fan out independent work in one message — connector probes, per-repo
evidence fetches, per-workload log sweeps. Only chain calls when one's
output is a literal input to the next.
</use_parallel_tool_calls>

## The question budget

The condition that separates the two lifecycles is a **file**, not a feeling.
`.rca-context.json` (see `references/context-file.md`) either resolves to a profile
whose `connectors.github` carries a `verifiedBy` with a `count` or an `observedAt`,
or it does not.

| Phase | Precondition | `AskUserQuestion` budget |
|---|---|---|
| FIRST CONTACT (Step 0b) | no context file, or the selected profile has no verified GitHub connector | **8**, plus at most 2 further T8 passes = **10** hard |
| THE GATE (Step 1) | a runnable profile exists | **1**, consolidated, plus at most 2 review passes = **3** hard |
| AFTER GATE CLOSE (Steps 2–6, Resume) | always | **0. Forever. No exception.** |

Before any `AskUserQuestion` call, state which row you are in **by naming the
file's state** — not by asserting a phase. If you cannot point at the file state
that puts you in a row, you are in the row below it.

The arithmetic, because a ceiling nobody can compute is not a ceiling:
T1(≤1) + T3(≤1) + T4(≤2) + T5(1) + T6(1) + T7(≤1) + T8(1) = 8, and T8 may be
re-entered **at most twice more** — for a correction, or for the one place the
customer may deliberately spend more: closing a named gap. On the third T8 entry
the extension option is gone, so the loop terminates by construction rather than by
judgement. A customer who wants to go further re-runs `/rca-build`, which resumes at
the first capability with neither a connector nor a gap — the profile is already on
disk.

The GitHub retry loop in Step 0b is never cut short by this ceiling: GitHub is the
one capability a run cannot proceed without, so its re-asks are inside the budget
by construction, not competing with it.

T1 and T3 are `≤1` because either can cost **nothing**: a build id supplied in the
args needs no question, and a part the pre-read settled is stated rather than asked.
Coming in under the ceiling is the goal, not a shortfall.

**The gate's 3 is the same shape as first contact's 10** — one question plus a bounded
correction loop — and for the same reason: a screen the customer can read but not
correct is a screen they learn to ignore. Part C shows the whole persisted setup and
takes a change to it, so it needs a pass to show the result. The bound is two, the
third screen drops the change option, and the loop ends by construction. A repeat run
that is simply right still costs exactly one question, which is the common case and
the promise.

The gate's question is spent on Part C's review whenever there is a persisted setup to
review, and on Part B's non-assumable field otherwise. It is never both: Part B folds
its field into Part C's call as an extra part.

`AskUserQuestion` renders at most **4 parts per call and 4 options per part**, and
requires **at least 2 options per part** — a one-option part is rejected and the whole
call fails, so the parts that genuinely needed asking are lost with it. That is why
the interview turns MERGE parts sharing an identifier rather than splitting into more
calls, and why a settled part is dropped rather than sent as a confirmation
(`references/interview.md` § Question mechanics). Splitting T6 into one question per
capability would be the obvious-looking edit and would blow this budget on the first
customer who selects five.

Every other mention of asking — in this file, in its references, and in
`agents/ai-tfa-coordinator.md` — points here rather than re-deriving the rule.
Restating it is what failed before: commit `164962f` added 52 lines enforcing a
rule and `395960c` added 82 more because the same rule was violated again.

## API reference — read `references/api.md`, don't grep the source

The `lib/`+`bin/` signatures the coordinator calls live in
[`references/api.md`](references/api.md). Load it the first time you need a
signature (Step 2 onward) — not at gate time. Grepping `lib/` at runtime to
relearn the API is the drift this file exists to prevent.

## Step 0 — input, greeting, and context load

Parse the build id from the invocation args. Accepted forms: a bare build id, a
`build_id=<id>` token, or a build dashboard link (extract the id).

**The args are pasted prose, not flags.** In practice they arrive as a regression-bot
message — owner, ticket, `PR(s)`, a CI link — so read them with judgement. There is no
grammar to match and no parser to satisfy.

Two things in them change the run, and both are **explicit statements by the person
invoking it**, which is what earns them precedence over anything derived:

- **A PR list IS the candidate set.** Not a hint and not just pre-answered intake: the
  customer's list is the superset of merged PRs, good and bad together, and finding the
  bad ones is still ours. It replaces *enumeration* — no window search runs, for any repo
  (§ Step 4). `references/interview.md` § Provenance explains why a human supplying this
  is admitted where an artifact asserting it is refused.

  **Resolve each to `repo + number`.** A `/pull/<n>` URL is unambiguous. A bare `#<n>`
  resolves against `profile.repos.product` — say which repo it matched. A number present
  in more than one product repo is the gate's single consolidated question, because a PR
  number is unique only within a repo and a profile commonly holds four.

- **Any other value they pin is an override** — a CI run, an environment, a branch, a
  ticket. It outranks what the run would have derived (§ Part B, precedence).

Carry both into Gate Part B, and print them at the gate as `given` so the customer can
see what their paste did.

**Then read the build's insights, before selecting anything.** The invocation carries
a build **id**; profile selection matches on the build **NAME** and the **project**,
neither of which an id tells you. Skipping this leaves `--build-name` empty, and an
empty name cannot match any `buildMatch` — so selection silently falls through to
`defaultProfile` and every multi-profile context resolves to whichever profile
happens to be the default. That is the wrong-context run this file's refusals exist
to prevent, arrived at without a single refusal firing.

```
fetchBuildInsights(buildId=<id>)          → the build's name and its project
node <pluginRoot>/bin/rca-context.mjs select \
  --build-name "<name from insights>" --project-name "<project from insights>"
```

No id, or insights unavailable? Pass what you have and let selection degrade
honestly: `matchedBy: "default-profile"` says out loud that nothing was matched, and
`projectUnchecked: true` says the file asked for a project check that could not be
made. Both belong on the gate screen. Never invent a name to fill the flag.

**Run both silently — emit nothing about either.** No "checking for a context file",
no "none found near the plugin root", no path resolution, and no build summary. That
is plumbing; the customer's first screen should not be spent on it, and the greeting
below has to be the first thing they read.

`select`, not `read`: `read` returns the document and does no selection, so it
cannot tell you whether this run may proceed. `select` returns the chosen profile
plus `runnable`, `provisioned`, `resumeAt` and `stale`, or exits non-zero with a
refusal naming what it would otherwise have had to guess. Four outcomes:

| Outcome | What it means | What you do |
|---|---|---|
| runnable **and** provisioned | GitHub verified, every capability answered | skip to Step 1 |
| runnable, **not** provisioned | GitHub verified but setup was abandoned partway | Step 1, and the gate's single question offers to finish — see `templates/gate-summary.md` |
| no context, or not runnable | never set up here, or GitHub never verified | **Step 0b** |
| `no-matching-profile` | a setup exists, and none of its profiles claims a build with this name | **Step 0b, in adopt-or-extend mode** (below). Not a dead end, and **never** re-run with `--profile` to get past it |
| `no-matching-project` | same, for the project — the coarse bound disagrees | same as above |
| `parse-error` | the file exists and is unreadable (a hand-resolved merge conflict is the common cause) | print the path and stop. **Write nothing.** Never treat this as "no context" — that would overwrite the team's file and throw away every answer already given |

**A refusal is a routing decision, not a failure.** `no-matching-profile` means the
file describes some builds and not this one — which is a *question for the customer*,
and the interview is where questions live. Print nothing raw, go to Step 0b, and let
them choose (see § Step 0b, adopt-or-extend).

**Never launder a refusal with `--profile`.** Re-running `select --profile <label>`
after it refused overrides the exact check that just fired, and it is the agent
deciding what only the customer can. `--profile` carries a choice a **human just
made**; it is never how you get past a no. A live run did this — refused, re-ran with
`--profile`, replayed five connectors green, and reported the setup as valid for a
suite the profile does not name. `matchedBy: "requested"` in the output is the tell,
and `overriddenBuildMatch` names the patterns that were ignored: if either appears
without a human answer behind it, stop and ask.

**No build id?** It becomes the interview's first question at Step 0b (T1), or the
gate's single consolidated question on a repeat run. It is the one genuinely
load-bearing field.

### Step 0a — greeting (the ownership split), first contact only

**This is your first output to the customer — the first thing they read, not the
first thing before a question.** In a real run this arrived seventh, after five tool
calls, quoted inside a status update that opened with "No context file anywhere near
either the plugin root or the working directory". The copy was complete and the
customer still experienced it as missing, because it was buried in a wall of `ls`
and `cat` output and framed as a footnote to a diagnostic.

So: nothing precedes it on screen. Do not prefix it with what you looked for or
where. Do not follow it with internal vocabulary — "session inventory", "write
target", "T2b" mean nothing to them.

Say what each side owns:

> Through BrowserStack I already have the test logs, traces, screenshots and the
> session for every failed test in this build — and the BrowserStack agent authors
> the RCA itself. What I have none of is your side: the product code, your
> application logs, your pipeline, whatever runs your services, your metrics.
> I need to learn where your half lives. That takes a few questions, once, and
> then never again.

A canned split is true and useless. Name what you can actually see in this session,
so the customer can tell the interview is short.

Say once, here, that **GitHub is the only thing that can stop setup.**

### Step 0b — FIRST CONTACT: the interview

Follow `<pluginRoot>/skills/rca-build/references/interview.md`. It owns the turn
order (T0–T8), the exact question shapes, the pre-read budget, the
procedure-authoring template and the refusal wording.
`<pluginRoot>/skills/rca-build/references/capabilities.md` owns what to ask per
capability and what "verified" means for each.

**Adopt-or-extend mode** — entered from a `no-matching-profile` or
`no-matching-project` refusal, not from an empty file. A verified setup already exists;
what is missing is whether it covers *this* build. So the interview does not start over:

- **T0 says what was found**, naming the profile, what it binds, and that this build's
  name is not in it. Then **one** question, whose options are the three real answers:
  a **new profile** for this build; **add this build's pattern** to the existing one; or
  **use the existing profile for this run only**, changing nothing on disk.
- **Connectors are inherited, never re-authored.** A new profile in the same
  environment reuses the verified `ci`, `infra`, `logs` and `metrics` procedures —
  copy them and **re-verify**, exactly as Gate Part A replays them. Asking a customer
  again for a log store, a cluster or a metrics surface they already named is the
  failure this mode exists to avoid.
- **Ask only what genuinely differs.** For a sibling suite that is usually the repos,
  the subpaths and the base branches — nothing else. T2/T2c still run, because which
  repos a *different* suite exercises is a question the pre-read can often answer.
- **Extending is a write like any other**: read, amend `buildMatch` (or add the
  profile), `write`. The writer refuses to drop a profile or downgrade a verified
  connector (`code: "would-regress"`), so adding a sibling profile cannot cost the
  existing one.
- **"This run only" writes nothing** and must say so on screen, or the customer will
  reasonably expect the next run to remember.

Six rules that live here because they are not negotiable:

- **The context lands in the directory you were invoked in** (T2b). Not in a repo
  chosen by lookup — the directory itself, whether or not it is a git repo. The one
  refusal is the plugin's own checkout: the documented install flow leaves cwd there
  and a context written there puts the customer's scope into the plugin repository.
  If that is where you are, say so and ask which directory is theirs; it costs part
  of T3's question rather than a failed write after the whole interview.

- **The build's insights are the interview's first tool call** (T1b), before the
  artifact pass and before any scope question. They are the only source describing
  *this run* rather than the setup in general — the branches per role, the
  environment label that is frequently a grouping's literal name, the CI run URL that
  identifies the pipeline. Read them late and the interview asks for what the build
  already stated.

- **Nothing is asked before the artifact pass** (T2, and T2c for what lives inside
  their repos). The build id at T1 is the only question that may precede it, and only
  when the invocation carried none. A customer asked for something they had already
  written down reads as not having been listened to.

- **The repo pre-read runs against the CUSTOMER's worktree, never this plugin's**
  (T2c, *before* T3 asks for the repos — its options are what the pre-read found,
  each cited to the file it came from). Our own repo names tools we do not want to
  suggest as their stack, and a listing of theirs is not a finding about them.
- **GitHub is mandatory**, bounded at 2 re-asks / 3 attempts, each re-ask narrowed
  by failure class. After the bound: refuse, start no RCA work, and write nothing
  extra — whatever verified is already on disk, because writes are per-connector.
- **Persist as you go, never in one batch at the end.** The first `write` fires as
  soon as T4 passes — the first moment the home repo, the repos, the branches and one
  verified connector are all known. After that every capability lands through
  `upsert-connector` or `record-gap` as it resolves. Abandonment then costs the
  customer nothing and there is no partial state to model. (T8 is a confirmation and
  a final additive write for corrections, not the first write.)

It ends by writing the context and **falling through into Step 1** — first contact
never ends the session and never starts RCA work of its own.

## Step 1 — THE GATE (opens once per run, three parts, closes once)

Everything **this run** could possibly need from the user is settled here, in one
pass — because first contact already settled everything that is stable across runs.
The gate has three parts; all run before any RCA work starts. Part C is the repeat
run's review of what a previous run persisted, and it is skipped when first contact
just did that job.

### Part A — capability validation from the persisted context

Part A does not discover. **It replays.** The selected profile already records, per
capability, what the connector is, how to query it, and the read that proved it —
so the probe is data the interview wrote, not prose this file carries. That single
reframing is why there is no probe table here any more.

There was one: six named commands for six named products, and a `via:` field whose
allowed values were those products. A customer running something not on that list
was second-class, and no such list can ever be complete. Deciding that a given CLI is this
team's runtime, or that a given MCP server is their metrics, is a judgement about
what a tool is FOR — which you make, and which generalises to a stack nobody here
has heard of.

**Re-run every capability's stored `verifiedBy` read, all of them in ONE batch of
parallel tool calls.** They are independent; nothing waits on anything else. Then:

- pass → `valid`
- fail, and the capability is **github** → the run refuses (below)
- fail, anything else → a **scoped gap**. A per-target failure is not a
  connector-wide failure: the capability stays `valid` for the targets that passed.
  Collapsing that into a dead capability is what makes a coordinator degrade to
  "unavailable" over one bad value.

Build the manifest with `buildManifest(config, discovered)` from the capabilities
the profile records — `discovered` is `[{capability, via}]`. It also resolves
`fallbackCapability`, which is how a team whose CI *is* their git forge keeps
gathering `ci` evidence without declaring a phantom gap to TFA.

A connector-shaped skill under `.claude/skills/` is a **procedure**, not a hint: it
carries the repo map, branch conventions and query conventions its author wrote
down, which is the knowledge that makes attribution accurate and that no probe can
recover. When the profile records `source: {kind: "skill", path}` for a capability,
**read that file and follow it** — and if it has changed since `verifiedAt`, prefer
what it now says over the stored `howToQuery`.

Its absence is the normal case and is **never** a warning. The previous version of
this file emitted "scope probes missing" for every customer without
BrowserStack-authored skills on disk, which is all of them.

**GitHub is mandatory.** A GitHub capability that fails replay here **refuses the
run**: culprit-PR attribution is this plugin's primary deliverable and cannot be
degraded silently. Bound: **one** re-ask — the context already recorded a shape that
worked once, so a failure here means the repo moved or a credential expired. Name
which route failed (`gh` or a GitHub MCP server) and how to fix it. Never say
GitHub is unavailable in general; this plugin needs a **local** route, and a
customer may well have the dashboard GitHub App connected.

**Every other** capability that comes back invalid or absent is a recorded gap —
shown in the gate summary, declared to TFA on the first turn ("I don't have
logs/metrics access") — **never a blocker**; the run proceeds.

**Mid-run is different, and this distinction matters more than either rule.** Once
the gate has closed, every capability failure — GitHub included — is a gap and never
a blocker. A coordinator refusing mid-run would sink the batch and break
partial-first. A coordinator never refuses.

**Before your first `listTestIds` call: for every capability recorded `valid`, you
must be able to name the read that proved it and what came back.** If you cannot,
you did not replay it — go back and do that.

### Part B — intake resolution (context first, then assume; ask at most once)

Intake fields: product repo, automation (test) repo, working branch, default
branch, the PRs in play, and the build id. **Resolve every field by ASSUMPTION
wherever possible** — this is an assumption-OK workflow; less user interaction
is the point:

- invocation args (build id, PR URLs, repo hints from Step 0),
- `gh repo view` / git remotes for the repos,
- **working branch — resolve in this order:**
  1. `fetchBuildInsights(buildId=<id>)`'s `branch` field, when a build id is
     known and the MCP tool returns one. This is the branch the build actually
     ran on — authoritative, and preferred over any assumption below.
  2. If `fetchBuildInsights` is unavailable, errors, or returns no `branch`
     (older build, field absent), fall back to whatever branch the user
     supplied in their skill invocation args.
  3. Only if neither is available, fall through to the connector's
     intake-defaults, then the current git branch, per the existing order
     below.
- cheap inference (e.g. the automation repo is the cwd if it holds the tests).

**Precedence, highest first — and the profile outranks any connector skill:**

1. **an explicit invocation value** — something the customer typed for this run,
2. build metadata from `fetchBuildInsights` (the branch the build actually ran on),
3. **the selected profile in `.rca-context.json`**,
4. a connector skill's own intake-defaults section,
5. inference.

**(1) and (2) used to be the other way round, and that made pinning impossible.** Build
metadata was ranked first because it beats any *assumption* — which is true, and an
invocation value is not an assumption, it is a statement. Under the old order a customer
who pinned a CI run lost to `ci_build_url` naming a different one, which is the opposite
of what pinning means. Only values the customer **actually typed** move; an absent one
changes nothing, so metadata still beats the profile, connector defaults and inference
exactly as before.

Show the reconciliation whenever a higher rank overrides a lower one. Only a field that
none of the five supply is a candidate for the gate's single question.

**An override lasts for this run and persists nothing.** It must not quietly rewrite the
committed profile — a pasted one-off would become the team's permanent scope, inherited by
every teammate who never saw the paste. Persisting is Part C's decision and is reached by
asking. **A credential value is never an override**, or anything else: § Credentials in
`references/interview.md` forbids one reaching the file or the transcript, and an
invocation is not an exception to that.

The profile sitting above connector intake-defaults is the whole point: a customer
answered those questions and a live read proved them. If a connector skill's lane
table could override that, first contact would prove nothing. And a connector
skill's intake section that doesn't resolve a field for THIS build — its lane table
doesn't match the failure signature at all — is not a default to force; treat the
field as genuinely non-assumable and let it fall through.

**Product-repo corroboration (do NOT skip).** The product repo must plausibly
be the _system under test for THIS build's failures_ — not merely a repo name
found lying around. A repo mentioned only in workspace docs/READMEs is a **weak
hint, never an assumption**: cross-check it against the failure signatures
(discovery runs first if needed) — do the failing area, files, or error strings
relate to that repo's domain? If they don't (e.g. the failures are self-healing
`healedElement is null` cases but the only named repo is an observability API),
the doc-sourced repo is discarded — never carry it (or its PRs) into the
manifest as a settled product repo.

When corroboration leaves **no** product repo, decide by whether a human can help:

- **PRs were supplied** → treat those as the suspect surface; product repo is
  derived from them. No question needed.
- **No PRs, interactive session** → the product repo is now **non-assumable AND
  load-bearing** (without it the mandatory culprit-PR hunt is dead), so it earns
  the single consolidated gate question below — ask it; don't silently degrade.
- **No PRs and no corroborated repo** → this case is now nearly unreachable,
  because first contact recorded and verified the product repos. It survives only
  for the case where the profile's repos do not plausibly own THIS build's failures,
  and it is the same single question — not an extra one. Record the answer back into
  the active profile so it is never asked twice.

Record each assumption in the gate summary (format:
`templates/gate-summary.md`; worked example: `examples/sample-run.md`)
("assumed product repo =
`org/obs-api` from git remote"). A field that cannot be assumed is recorded as
"none" and the run proceeds RCA-only for it — **unless** it is both genuinely
non-assumable AND load-bearing. In practice that set is: the build id; **the
product repo when it could not be corroborated and no PRs were supplied** (see
above — without it the culprit-PR hunt cannot run); and rarely an ambiguous repo
when PRs were supplied. Those, and only those, may be asked **ONCE, in a single
consolidated question at gate close** — e.g. _"Failures look like `<domain>`;
which repo owns that code? (reply 'none' → I'll RCA without culprit-PR
attribution)."_ Never a second question.

**Before your first `AskUserQuestion` call this pass: write out every field
this run still needs from the user, across every reason it might be
non-assumable, in one list — then ask them as ONE question with multiple parts
if more than one survives.** If you are about to send a second
`AskUserQuestion` call **within one pass**, STOP — fold its content into the
first question instead. There is never a second question in a pass.

**A pass is not a question.** Part C may reprint and re-ask **the same** question after
applying a change the customer asked for, at most twice (§ The question budget). That
is one question answered, acted on, and shown back — not a second question. What is
forbidden is asking for something *new* that the first call should have carried: that
is the defect the fold-it-in rule above exists for, and it is forbidden in every pass,
including the second and third.

**This governs the gate only.** Step 0b's interview has its own budget
(§ The question budget) and has already finished by the time you reach here. Do not
read this paragraph as a prohibition on interviewing.
Record the answer back into the active profile so a field asked once is never asked
again. A repo, a branch or a subpath is **not** a connector — `upsert-connector` cannot
write `profile.repos`, and this used to say it could, which is why an answered product
repo was re-typed on every run. Persist it the way Part C does: read, amend that field,
`write`.

### Part C — review and confirm (repeat runs only)

**Skip entirely when first contact ran this session.** T8 already showed this and the
customer already approved it; a second confirmation of the same screen reads as not
having listened. This part exists for the *repeat* run, where the setup was approved
weeks ago by someone who may not be the person sitting here now.

Print the **whole** setup — not a summary of it. Layout and the exact question shape:
`templates/gate-summary.md` § The review. Every value the run will act on appears:
the profile and **how it was matched**, the other profiles available, repos by role,
subpaths, branches, both match patterns, every connector with what proved it and how
long ago, gaps, warnings, and applied knowledge. A value that is not on screen cannot
be corrected, and the whole point of this part is that it can be.

Then **one** consolidated question. Always at least two real options — a one-option
part is refused by the tool and the entire call is lost (§ The question budget):

- proceed;
- use a different profile, when the file holds one (`select --profile <label>`
  re-selects and re-checks runnable);
- change a value — the free-form field carries *what* to change, including adding a
  repo or a whole new profile;
- finish setup, when the profile is runnable but not provisioned.

**A change is applied, persisted, and re-verified before the gate closes.** Persist by
reading the document, amending that field, and `write` — the writer refuses to drop a
profile, drop a connector, or downgrade a verified one (`code: "would-regress"`), so an
amend cannot cost a teammate their setup. That refusal lives in the writer, which is
why there is no per-field verb: one safe additive write covers correcting a branch,
adding a repo, and adding a profile, and a narrower verb would cover only the first two.

**A change to scope invalidates what was verified against the old scope.** Re-run the
affected capability's read before closing — a base branch the customer just corrected
has never been proved reachable, and carrying the old `verifiedBy` forward would state
that it was.

**Bounded at two further passes.** Print, ask, apply, print again — and on the third
screen the change option is gone, so the loop terminates by construction rather than by
judgement. A customer who wants more re-runs `/rca-build`, which now starts from the
corrected file.

### Gate close

Print a one-screen summary: resolved intake (with assumptions marked) + the
validated capability manifest (with gaps named). Then the gate closes.

**AFTER THE GATE CLOSES, THE RUN NEVER ASKS THE USER ANYTHING AGAIN.** RCA
execution is fully autonomous: every downstream evidence gap becomes an
`unavailable` block back to TFA (best-effort finalize), never a prompt.

## Step 2 — discovery

Call the bundled MCP tool:

```
listTestIds(buildId=<id>, status="failed", includeFailureDetail=true)
```

`includeFailureDetail=true` returns each row's trimmed failure signature
(`failure.{category, error_summary, file_path, …}`) — the seed for clustering,
so no per-test probe turns are needed.

**First, sweep the state directory** (`lib/state-dir.mjs` → `hardenStateDir(dir)`).
The sweep is cheap and idempotent — run it unconditionally; it never throws,
skipping anything it cannot chmod.

Resolve the state file with `lib/csv-state.mjs` → `csvPathFor(buildId,
config.paths.stateDir)` — the **build id is in the filename** and the default
directory is **OS temp** (`<tmpdir>/bstack-rca/rca-state.<buildId>.csv`), so
different builds can never collide and the invoking workspace stays clean. Pass
this exact path to the fan-out workflow as `csvPath`.

Seed the CSV/WAL spine from the payload (`lib/csv-state.mjs` → `seed`): one row
per failed test, every row `rca_done=pending`, signature columns populated.
Re-running `seed` on an existing CSV is idempotent and preserves terminal rows
(resume-safe — same build id → same path). If `listTestIds` returns empty →
write an empty CSV, report "no failed tests", stop.

## Step 3 — clustering (see `<pluginRoot>/skills/rca-build/references/clustering.md`)

Cluster from the server's failure themes so each *cause* runs one
**representative** (full loop) + `N−1` **siblings** (one-turn confirm) while every
test still lands a per-test RCA; no themes → every test its own singleton.

**Run the call sequence and invariants in `references/clustering.md` (§ Running
it).** After it, `writeRows(csvPath, rows)` and verify: if any row's `cluster_id`
is empty, Step 3 did not take effect — do not proceed.

## Step 4 — build-evidence pre-fetch (see `<pluginRoot>/skills/rca-build/references/evidence-routing.md` and `<pluginRoot>/lib/evidence-file.mjs`)

Once, after clustering (Step 3) and before fan-out — the capability manifest
already exists from Gate Part A, reuse it, do not re-discover. This step
replaces each coordinator's own turn-1 evidence sweep with ONE pre-fetch:
it does not remove the requirement that turn-1 evidence exists, only _who
gathers it_.

**Narrate this as one combined phase, not two sequential ones.** Step 4b
starts the moment Step 3 finishes and runs the whole time Step 4 does — any
progress line should say `Evidence pre-fetch (Step 4) + turn-1 pre-dispatch
(Step 4b)`, never "Step 4 done, now starting Step 4b."

1. Resolve the evidence-file path: `lib/evidence-file.mjs` →
   `evidencePathFor(buildId, config.paths.stateDir)` —
   `<tmpdir>/bstack-rca/rca-evidence.<buildId>.json`, alongside the state CSV.
   `initEvidenceFile(path, buildId, nowMs)`.
2. **Scope the pre-fetch to the full union, never a single guess:**
   - **Repos** — every repo in Gate Part A's scope-probe-validated
     `repos_validated` list (a build's failures often span several repos —
     validate the full set the connector maps, not one guessed repo).
   - **Workloads** — the union of workloads every cluster's **representative**
     implicates, via the active connector skill's failure-signature→workload
     routing table (never one workload guessed from the first failing test).
3. For each repo: run the connector skill's PR-window-search + deploy-state
   recipes **once**, using `lib/evidence-cache.mjs`'s `compute(repo, range,
evidenceType, fn)` to dedupe if two steps need the same `(repo, range)`.
   Persist the deploy-state via
   `setCodeEvidence(path, repo, {deployState, prsInWindow, gap}, nowMs)`.
   A repo the connector can't reach records `{gap: "<reason>"}` — never blocks
   the rest of the pre-fetch.

   **For the PR window, do NOT hand-build the entry — use the deterministic
   helper**, once per repo, all repos fired as parallel tool calls in ONE message:

   ```bash
   node bin/prefetch-prs.mjs <buildId> <org/repo> <branch> <fromISO> <toISO>
   ```

   **When Step 0 carried a PR list, use the supplied form instead — for every repo:**

   ```bash
   node bin/prefetch-prs.mjs <buildId> <org/repo> --prs <n,n,n>
   ```

   **No window search runs anywhere in that case.** The customer's list is the candidate
   set for the whole run, so a repo their list never names simply has no candidates —
   record that as a warning at the gate (`templates/gate-summary.md`), never as a reason to
   search it anyway. An empty result for such a repo must read as *nothing was offered for
   it*, not *we looked and found nothing*.

   **Hydration still runs.** The list gives you numbers; path-overlap is the first
   falsification test and needs each PR's `files`, so the binary fetches them per PR. That
   is why this is the same binary and not a prose shortcut: it writes the identical
   `prsInWindow` + `prsSearched: true`, and `prsSearched` is what stops every downstream
   reader treating a complete list as "never searched".

   **Repo scope with a supplied list is the UNION** of Gate Part A's `repos_validated`
   and the repos the supplied PRs name. Without the union a PR in a repo the gate never
   validated has no path into `prsInWindow` at all — the customer named it and it would
   vanish.

   It runs the `--json number,title,author,mergedAt,url,files --limit 100` search and
   writes the **canonical `prsInWindow` (with `files`) + `prsSearched: true`** via
   `setCodeEvidence`, preserving any `deployState` already recorded. **Never author
   the github entry by hand** (e.g. a `{prCount5d, topPRs}` blob): readers consume
   only `prsInWindow`, so a mis-shaped entry silently reads as "never searched" and
   every coordinator re-fetches the list live. `setCodeEvidence` now **rejects**
   non-canonical keys (`assertGithubEntry`) so this fails loud instead of shipping a
   dead file. A non-`gh` GitHub capability pre-fetches through its own connector but
   writes the identical shape.

   Why `files` matters: path-overlap is the first falsification test in
   `<pluginRoot>/skills/rca-build/references/github-evidence.md`, so with `files` populated a coordinator
   rules a suspect in or out from the evidence file alone, and only fetches a
   diff for the handful that survive. Do NOT pre-fetch diffs — those are large
   and only a few PRs ever need one.

   A per-PR `gh pr view --json files` call is legitimate in exactly two cases: a
   suspect PR discovered later (during a coordinator's own investigation, not in
   this pre-fetch's window), and **a customer-supplied list, where per-PR is the
   only shape available** — there is no search to project `files` out of. It is
   never a backfill for a PR-list call that should have carried `files` the first
   time.

   - **Never let coordinators re-probe connectors.** State plainly in the
     dispatch prompt that the gate validated them.
   - **Do NOT bulk-fetch file contents.** The `files` lists above tell a
     coordinator exactly which files matter, and the tool cache dedupes the
     ones two coordinators both open.
4. For each workload: run the runtime and log sweep for it **once**, through
   whatever the manifest says serves `infra` and `logs`, anchored to the build's
   own clock — never "now". **Batch all workload sweeps together with repo fetches from step 3.**
   **PAD the window: `started_at − 2m` .. `finished_at + 10m`.** Label every
   finding with whether it falls inside or outside the strict window so a
   coordinator can weigh it; do NOT silently widen to an arbitrary window.
   Persist via `setLogsEvidence(path, workload,
{clusterIds, kubectlSweep, victorialogs, gap}, nowMs)`. Those last two are
   **grandfathered field names** in the evidence-file schema, not an assumption
   about your stack: `kubectlSweep` is the runtime sweep and `victorialogs` the log
   query, whatever tool actually served them. Renaming them would break resume for
   builds already in flight, so they stay until that schema is versioned.

   Two query mechanics that cost real calls when missed:
   - **`direction` defaults to newest-first**, so a limited query always
     returns the END of the window. To find when something _started_ — the
     first request after a gap, the onset of an error burst — pass
     `direction: "forward"`. A gap "confirmed" from a backward query is not
     confirmed at all; it is just the tail of the range.
   - **Absence needs a control.** A zero-result query is indistinguishable
     from a wrong selector. Before reporting "no traffic", prove the logger
     was alive in the same window with a query you expect to be non-empty
     (e.g. readiness probes from a named pod). Only then is silence evidence.

5. `resolveBaseline(lastGreenRef, fallbackRef)` (from `lib/evidence-cache.mjs`)
   → `setBaseline(path, baseline, suspectWindow, nowMs)`. No "last green"
   baseline (never-green suite) → fall back to a configured baseline ref and
   note the weaker grounding — this note travels into the file, not just a
   spoken log line, so every coordinator sees it.
6. **Resolve local clones ONCE** (`lib/repo-source.mjs`). Local `git show`
   serves the same bytes as `gh api` with no network round trip.

   ```js
   const d = discoverWorkspaceRoot({ repos: reposValidated, from: pluginRoot });
   const { pins } = deployShas(path);          // structured, not prose
   const localRepos = d.root
     ? resolveLocalRepos({ repos: reposValidated, pins, workspaceRoot: d.root })
     : {};
   setLocalRepos(path, { workspaceRoot: d.root, repos: localRepos }, nowMs);
   ```

   `discoverWorkspaceRoot` takes the **validated repo list** and accepts a
   candidate directory only if it actually contains one of *this run's* repos,
   bounded to ~3 tries. Finding nothing is fine: every read falls back to the
   cached `gh` path.

   Set `deployState.sha` explicitly when you write each repo's entry.
   `deployShas()` falls back to parsing prose `summary`, but that is a
   safety net, not the contract.

   `pins` must be the **build-time commit shas** from `deployState`, never
   branch names — a local branch may be stale.

   **Pass `resolveLocalRepos`'s return value through unchanged — never hand-author
   the map.** With no pin for a repo it returns
   `{usable: false, reason: "no pinned sha for this repo"}` — a refusal, and the
   thing that stops a coordinator trusting a stale checkout. Hand-writing the entry
   deletes the refusal, and a coordinator told a clone is usable has no way to
   learn otherwise. Same rule as the github entry above, and for the same reason.

7. `recomputeCoverage(path, {repos, workloads}, nowMs)` and declare the
   resulting path in the gate summary alongside the capability manifest, so
   a human re-reading the run can find it.

**Size discipline is enforced at write time, not just at submit time.** Every
leaf (`deployState`, each PR, each log sweep) must already be a digested
`block` per `evidence-routing.md`'s caps (`SUMMARY≤400`, `SNIPPET≤20/40 lines`,
link over diff) — never a raw dump. Cap `prsInWindow` to the top ~30 candidates
by path-overlap relevance, not every PR in the window.

**The cap applies to a SEARCHED window only.** A customer-supplied list is never
capped: they named those PRs, and dropping some by our relevance ranking answers a
question they did not ask while looking like a complete result. Digest each one's
`block` to the same caps — that bounds size without discarding a candidate.

Pass `evidencePathFor(...)`'s path to Step 5's fan-out as `evidenceFilePath` —
every dispatch (representative and sibling) must be told to read it first.

## Step 4b — turn-1 pre-dispatch (fire-and-forget, fully async alongside Step 4)

Every cluster's representative testRunId is already known the moment Step 3
finishes. Turn 1's message has no dependency on Step 4's evidence pre-fetch —
it is built entirely from Step 2's CSV seed (`error_summary`/`testName`). So
there is no need to wait for Step 4 before starting Step 4b, or to wait for
Step 4b before moving on.

**Mechanic: dispatch, don't wait.** For every cluster representative, launch
one lightweight subagent via the Agent tool whose ONLY job is to call
`tfaRcaTurn(testRunId=<rep>, message=<first-turn digest>)` once and emit one
fixed-shape block as its final output — no evidence gathering, no loop, no
drain. Write a minimal, purpose-built inline prompt (not a full
`ai-tfa-coordinator` dispatch), and put the exact output contract below
directly in that prompt so the orchestrator can parse the result
deterministically.

```
TURN1_OUTPUT_START
testRunId: <the testRunId this subagent was given>
status: RESOLVED | NEEDS_INFO | PENDING
threadId: <threadId from the tfaRcaTurn response, or "none">
turnId: <turnId — PENDING only, tfaRcaTurn never returns one for the other two statuses; else "none">
glimpse: <RESOLVED only — the trimmed {root_cause, failure_type, related_prs, confidence, viewRca} object, verbatim; else "none">
asks: <NEEDS_INFO only — the asks array, verbatim; else "none">
TURN1_OUTPUT_END
```

That block is this subagent's entire final message — `status` selects the
branch, `testRunId` is the join key back to the CSV row / registry entry, and
the remaining fields paste straight into `flip()` or `recordTurn1()`.

Agent-tool dispatches return immediately (fire-and-forget). Fire off every
representative's dispatch together, then **immediately proceed to Step 4's
evidence pre-fetch — do not wait for any of them.**

As each subagent finishes, a task-notification carrying its `TURN1_OUTPUT`
block arrives. Handle each one the moment you are next free to, as pure
bookkeeping — no new tool calls needed for this part:

1. `initTurn1Registry(turn1PathFor(buildId, config.paths.stateDir), buildId, nowMs)`
   once, before dispatching any turn 1s (`lib/turn1-registry.mjs`).
2. **Skip any representative whose CSV row already has a `threadId` +
   `turnId`** (a `pending-resume` row from a prior run attempt — an already
   in-flight thread). Dispatching a fresh turn 1 for it would start a SECOND
   thread for the same test, which every other part of this contract
   (`agents/ai-tfa-coordinator.md`'s "one thread per test" hard limit) forbids.
   That representative resumes its existing thread at Step 5 exactly as
   before Step 4b existed — Step 4b only ever applies to a representative with
   no prior thread at all.
3. For every remaining (thread-less) cluster representative, dispatch its
   turn-1 subagent. When its result notification lands, branch on it:
   - **RESOLVED** → `flip()` this CSV row straight to terminal, right here —
     same fields a coordinator's `RCA_OUTPUT` would set (`rca_done: resolved`,
     `root_cause`, `failure_type`, `related_prs`, `view_rca`, `confidence`,
     `turns_used: 1`, `threadId`). This representative needs **no Step 5
     dispatch at all** — the cheapest possible outcome. **Do not wait for
     Step 5 to formally start: dispatch this cluster's siblings immediately,
     right here in Step 4b** — as their own fire-and-forget Agent-tool
     dispatches too, same principle, don't wait on them either — via
     `siblingPreSeed(csvPath, csvState, clusterId, representativeId)` against
     the row you just flipped. A sibling only ever needs its OWN
     representative's result, never the state of any other cluster, so
     nothing about Step 5's fan-out has to begin first. This is the ONLY case
     a sibling can be dispatched this early, and the reason is narrow: it
     works because the representative resolved in ONE pre-dispatched turn, so
     `pre_seed` is already real evidence, not a guess. A representative still
     mid-loop (`NEEDS_INFO`/`PENDING`) has no `root_cause` yet — dispatching
     that cluster's siblings before it lands would degrade every one of them
     into a full independent investigation, at real representative-level cost
     instead of a cheap one-turn confirm (see Step 5's sibling-ordering note).
     Never do that; siblings of a not-yet-resolved representative wait for
     Step 5 exactly as documented there.
   - **NEEDS_INFO** → `recordTurn1(path, testRunId, {status: "NEEDS_INFO",
     threadId, asks}, nowMs)`. A real, non-terminal answer — hand it to Step
     5's coordinator as `turn1_result` (never resubmit turn 1).
   - **PENDING** → `recordTurn1(path, testRunId, {status: "PENDING", threadId,
     turnId}, nowMs)`. Do **not** drain it here — there is no reason to spend
     any of the orchestrator's own time on it. Step 5's coordinator dispatch
     already knows how to drain a soft-PENDING (the existing `resume` input
     covers this case as-is).
4. Nothing about this starts a second thread: it is exactly turn 1 of the one
   thread the Step 5 coordinator continues from `threadId`.
5. **A subagent that never reports back fails open, not closed.** Step 5's
   `readTurn1` returns nothing → Step 5 falls back to a fresh dispatch
   (submit turn 1 from scratch, no `resume`/`turn1_result`). If the dead
   subagent did reach `tfaRcaTurn`, that thread is orphaned — not a
   correctness problem, just one wasted thread per failure.

**Dispatch at most `concurrency` (from `config/rca.config.json`) turn-1
subagents at a time.** For a build with more cluster representatives than that,
issue the first `concurrency` immediately, then issue the next batch as soon
as they're dispatched (still fire-and-forget, still never blocking Step 4's
own progress).

**The very first turn can contain Step 4b's setup-and-first-dispatch-batch
together with Step 4's own first evidence-gathering calls, in the same batch.**

Pass `turn1PathFor(...)`'s path to Step 5 alongside `evidenceFilePath` — Step 5
must read it (`readTurn1(path, testRunId)`) before building each
representative's dispatch and translate the result into the matching input:
`PENDING` → `resume: {threadId, turnId}`; `NEEDS_INFO` → `turn1_result:
{threadId, asks}`; a flipped-to-terminal row (no registry entry, CSV already
`resolved`) → no dispatch, use the CSV row's result directly as this cluster's
representative outcome for seeding siblings.

## Step 5 — fan-out (fully autonomous)

**REQUIRED gate before your first Step 5 dispatch: Step 4b's dispatch batch
must have already been ISSUED this pass — not completed, not waited on,
issued.** **If you are about to issue Step 5's representative dispatches and
cannot point to this pass's `initTurn1Registry` call and a turn-1 dispatch
batch issued for every thread-less cluster representative, STOP — go back and
fire that dispatch batch first.** This is NOT a "wait for Step 4b's subagents
to finish" gate — it only catches the case where Step 4b never happened at
all.

**ORDER MATTERS: representative first, siblings only after it lands.** For each
cluster, dispatch the representative, wait for its row to go terminal, then
dispatch its siblings carrying `pre_seed` from
`siblingPreSeed(csvPath, csvState, clusterId, representativeId)`. Clusters are
independent, so they still run concurrently *with each other* — the barrier is
per cluster, not global.

`siblingPreSeed` returns `{ok:false, reason}` when the representative is not
resolved or recorded no `root_cause` — **do not dispatch that sibling yet**.
Never hand-roll the seed: without this guard, siblings degenerate into full
independent investigations at representative-level cost.

Drive the cluster work-list **`concurrency` at a time** — read `concurrency` from
`config/rca.config.json`, never hardcode a number: representatives deep, siblings
one-turn-confirm. Eagerly persist to the CSV/WAL (claim → heartbeat → flip) so the
run is resumable. Keep it a **rolling queue, not two rigid phases**: as each batch
returns, refill up to `concurrency` by mixing freed representatives' siblings (via
`siblingPreSeed`) with not-yet-dispatched representatives from other clusters —
never "all representatives, then all siblings," which idles a fast cluster's
siblings behind an unrelated slow representative.

Dispatch path, in preference order:

- **Direct Agent-tool dispatch** — **the default.** Dispatch
  `tfa-rca:ai-tfa-coordinator` subagents in batches of `concurrency` (one message, up
  to `concurrency` tool-use blocks), refilling per the rolling queue above. Honors the
  JSON `concurrency` literally. Coordinator output flows back into the orchestrator's
  context — kept affordable by the compact `RCA_OUTPUT` contract. A batch is a barrier
  (the next batch waits for the slowest in the current one).
  **This path has no code enforcing the Step 4b handoff — you are the enforcement.**
  Before dispatching ANY representative, call `readTurn1(turn1PathFor(buildId,
  stateDir), testRunId)` and fold the result into the prompt using this exact mapping
  — distinct coordinator inputs (`agents/ai-tfa-coordinator.md`), never
  interchangeable: `PENDING` → `resume: {threadId, turnId}`; `NEEDS_INFO` →
  `turn1_result: {threadId, asks}`; no registry entry with the CSV row already
  `resolved` → skip the dispatch, use the CSV row's result directly. A swapped field
  is silently wrong, not rejected.
- **`workflows/rca-batch.mjs`** — **opt-in** (Claude Code, when the Workflow runtime is
  available). Keeps coordinator output out of the orchestrator's context and gives
  `resumeFromRunId` resumability + a progress UI. Runs fewer agents at once than direct
  dispatch, so choose it when orchestrator context is the constraint (very large
  builds) or you want the UI/resumability — not for throughput.
- **Sequential harness `lib/loop.mjs`** (`runRcaLoop`) — hosts without the Workflow
  runtime and without Agent-tool fan-out, one test at a time. Same contract, same
  no-prompt rule.

Subagents/coordinators return compact `RCA_OUTPUT` blocks, never transcripts. A
coordinator that dies becomes a recorded `failed` row — one stuck test never
sinks the batch (partial-first). No path ever prompts the user (the gate is
closed).

**Coordinator prompts MUST carry `pluginRoot` and use it to fully qualify every
reference-doc / lib path.** A coordinator is dispatched fresh with no guarantee
about its cwd. Every dispatch prompt must state `pluginRoot=<absolute path>` up
front and every reference-doc pointer must be `pluginRoot`-qualified — never a
bare `references/<file>.md`.

**Coordinator prompts MUST also point at the API reference instead of letting
the coordinator re-derive it.** State plainly in the dispatch prompt: "Function
signatures for `lib/*.mjs` are documented at
`<pluginRoot>/skills/rca-build/references/api.md` — read it once if a signature is
needed; do not `grep`/`Read`/`cat` the `lib/` source to re-derive a signature
already documented there."

**Coordinator prompts MUST name every connector-shaped skill on the manifest.**
Each dispatch prompt lists, per capability, the resolved connector skill from
Gate Part A — e.g. _"Use `<resolved-github-skill>` for every
product_code / deploy / ci ask. Use `<resolved-infra-skill>` for every infra
ask."_ Omitting a manifest-listed connector lets the coordinator infer repos
from workspace `git remote` or cwd, landing wrong PR attributions.

**Hand coordinators the knowledge itself, never a path to it.** When the profile
records `knowledge` entries, put the relevant part's text **verbatim** in the dispatch
prompt. Not the path: a coordinator reading the whole artifact reads the machinery this
excludes, and it is a prompt-following agent. Withhold any part that asserts a verdict
("signature X is always environment") from a **sibling** dispatch — a sibling's
confirmation has to stay its own, which Step 5 and the coordinator's Principle 0 already
require. If a part contradicts a rule of ours, ours applies and the coordinator says so.

**Coordinator prompts MUST carry a customer-supplied PR list, and any override.**
Whatever Step 0 read out of the invocation goes in every dispatch — representative and
sibling alike — as `suppliedPrs` plus the pinned values, stated as *the customer named
these at invocation*. Two reasons it cannot be left implicit: `pre_seed` carries only the
representative's own result (`lib/signature.mjs`), so a sibling learns intake from nowhere
else; and the coordinator's `INCOMPLETE` rule sends it digging to the turn cap unless it
knows the enumeration was supplied and is therefore exhausted. Naming the evidence file
is not a substitute — a coordinator that reads `prsInWindow` there cannot tell a supplied
set from a searched one, and the two mean different things about whether to keep looking.

**Coordinator prompts MUST also name the Step 4 evidence file.** Every
dispatch prompt (representative and sibling alike) includes the absolute
`evidenceFilePath` from Step 4 with the instruction: _"Read `<path>` (via the
Read tool) before making any live github/infra/logs gather call. It's a
pre-fetch, not a hard dependency — a repo/workload it doesn't name, or marks
with a `gap`, is a genuine gap: fall back to the capability manifest above
exactly as if no file existed."_ For a sibling, add: _"The file's data about
your OWN test's workload is real evidence, not inheritance — reading it is
fine. What must stay independent is the CONFIRMATION judgment: never adopt the
representative's verdict just because the file already has the answer in
it."_ A dispatch prompt that omits this path forces its coordinator back into
a full independent sweep — exactly the redundancy Step 4 exists to remove.

**The file is read-write, not just read-only.** When a coordinator has to
gather live (a genuine gap), tell it to write the result back —
`contributeCodeEvidence`/`contributeLogsEvidence` (`lib/evidence-file.mjs`),
passing its own `testRunId` as `writerId` — before finishing, not just answer
TFA and move on. A representative's deep dive (a full diff, a downstream
trace, a PR the pre-fetch never named) then benefits its own siblings and any
other cluster sharing the same repo/workload, instead of every one of them
re-running the same live search. This is already baked into
`agents/ai-tfa-coordinator.md`'s Operating Principle 0 for any dispatch of
that agent type — no need to repeat the mechanics in the prompt, just don't
omit `evidenceFilePath` (above), since write-back has nothing to write to
without it.

**Pre-seed the MCP cache with the queries you just ran.** Step 4's log sweeps
are MCP calls, and a coordinator will often want the same ones. Deposit each
result under the key it would compute — `mcpCacheKey(tool, args)` then
`cachePut(toolCacheDirFor(buildId), key, {…, writerId: "orchestrator"}, nowMs)`
from `lib/tool-cache.mjs` — storing the DIGEST, not the raw rows.

Store the same digest you put in the evidence file; the two are complementary
(the file is read wholesale at turn 1, the cache answers a specific repeat
query later).

**Also hand every dispatch the tool cache.** Include the plugin root in each
dispatch prompt so coordinators can invoke `bin/cached-exec.mjs` /
`bin/cached-mcp.mjs`, and tell them to pass their own `testRunId` as
`writerId`. The cache lives at `<tmpdir>/bstack-rca/rca-toolcache.<buildId>/`,
one file per call key, shared by shell and MCP alike.

**Tell every coordinator where its scratch goes and that it owns the cleanup**
(`agents/ai-tfa-coordinator.md` § Scratch goes in your own directory). Pass the
plugin root so it can call `scratchDirFor(buildId, itsOwnTestRunId)` from
`lib/state-dir.mjs`: keyed per agent, so parallel coordinators cannot collide, and
under the state tree rather than in the customer's repo.

Each agent then deletes what **it** created, by name, before finishing. Never a glob
and never a directory sweep — this plugin does not delete files it did not create
(`54d5bb0` removed `pruneStateDir` for that reason), so only the agent that wrote a
path can safely remove it. You cannot do it for them.

Apply both to yourself: your Step 4 pre-fetch staging is the same kind of residue,
and you have a `writerId` too.

One real run left 28 files and 572 KB in a customer's repo root, several of them
overwriting each other because parallel agents picked the same short names.

Run `node bin/cached-exec.mjs <buildId> --stats` at the end and **report the
numbers in the finish message.** In that same run this was skipped, so the cache had
16 entries and no hit rate anybody could see — a saving nobody can measure is one
nobody will defend.

**Concurrency is handled by layout, not by locking.** Base
(`rca-evidence.<buildId>.json`) has exactly one writer — this orchestrator, in
Step 4. Every coordinator writes only its own shard under
`rca-evidence.<buildId>.contrib/<testRunId>.json`. `readEvidenceFile` folds
base + all shards into one view, applying shards in sorted order, with real
evidence taking precedence over a recorded `gap`.

**Application bugs need a culprit PR.** Whenever a test's RCA classifies as
PRODUCT_BUG / application bug, the coordinator MUST hunt the culprit PR via the
github connector (deploy timeline vs last-pass window, changed paths vs failure
signature — `<pluginRoot>/skills/rca-build/references/github-evidence.md`) and feed the PR link(s) to TFA in
the turn message so the dashboard RCA's `related_prs` populates. An
application-bug RCA with no GitHub PR link is **incomplete**: keep digging until
the turn cap; if still none, the turn must explicitly state "no culprit PR
identified after <what was searched>" and the CSV row records the gap.

## Step 6 — finish: glimpse + dashboard report (NO local report)

This plugin **never renders or writes a local RCA report, and never surfaces RCA
detail in Claude.** The in-Claude output is a two-line completion notice plus the
link — that is all. When every row is terminal:

1. Print a one-line **completion summary** by counting the CSV's terminal
   states: `RCA analysis complete — build <id>` + `<N> tests · <R> resolved ·
   <P> pending · <F> failed`. **Nothing per-test.**
2. Call **`triggerRcaReport(buildUuid=<build id>, force=true)`** — **always pass
   `force=true`; never `force=false` in any case.** Forcing regenerates the
   release-readiness report from the RCAs completed so far, so the report is
   produced for this run's actual analysis even when only a subset of tests
   reached terminal RCA — instead of returning a stale/empty cached report or
   blocking on a bulk re-trigger of every test's RCA.
3. Print the link line, verbatim shape:

   ```
   Full report on the Test Observability UI: <viewReport>
   ```

**One carve-out, and only one: name the knowledge parts that were applied.** If any
coordinator used a recorded part, list them — artifact and part — in this notice. It is
the only surface the plugin owns that a human reads, and the per-ask decision to apply a
part is made after the gate where nothing can be asked, so this line is its entire audit
trail. `RCA_OUTPUT` carries which part each coordinator used; this aggregates them.

**Do NOT print** root causes, culprit/related PRs, cluster breakdowns, per-test
analysis, confidence rationales, or a per-test table — root_cause, related_prs,
suspect_signals and the like are for the CSV + the dashboard ONLY. If a human
wants the "why", they open the link. Claude's job here is "analysis complete →
report is at <link>", not to re-narrate the RCA the BrowserStack agent authored.

## Resume

On startup, run the reaper (`lib/csv-state.mjs` → `reaper`) to reclaim rows
stranded `in_flight` by a crashed worker (heartbeat older than
`reaperHeartbeatTtlSec`) back to `pending`, then re-point fan-out at the CSV.
Live `threadId`/`turnId` resume the prior thread; dead threads re-run from
pending. Resuming a run does **not** reopen the gate and does **not** re-run first
contact — no new questions. A resume always loads the existing context; it never
interviews, even when the profile is not runnable.
(In-session only — cross-session durability is deferred.)

A `pending-resume` row now means the coordinator's **soft-PENDING drain budget
was spent** (`softPendingDrain`), not merely that a turn ran past 90s — the
common case is drained in-flight and never reaches the CSV. Resume reads such a
row's `turnId` with `getTfaTurnResult` **before** submitting anything new on the
thread.

## Hard rules

- On first contact, the ownership split is the FIRST thing the customer reads. The
  context load that decides it is silent. A greeting that arrives after five tool
  calls has not happened, however complete its wording.
- Exactly one gate **per run**. At most one consolidated question, at gate close.
  **After the gate closes, never ask the user anything.** First contact (Step 0b) is
  a separate, one-time phase with its own budget — see § The question budget.
- First contact writes `.rca-context.json` and then **falls through into Step 1**.
  It never ends the session and never starts RCA work of its own.
- **GitHub is mandatory at gate time**: unverifiable → refuse the run, name which
  route failed, start no RCA work. Every other connector — and GitHub itself once
  the gate has closed — is a recorded gap, never a blocker.
- A `parse-error` on the context file refuses and **writes nothing**. It is never
  treated as "no context": that would overwrite the team's file.
- Never reconstruct a stored `howToQuery` verbatim into a string passed to a
  shell-invoking wrapper such as `bin/cached-exec.mjs`. It tells you WHICH call to
  make; you re-author and re-quote it at call time from the structured fields.
- Never call `tfaRcaTurn` from this skill — always via the `ai-tfa-coordinator` —
  **except Step 4b's turn-1 pre-dispatch**, which is a deliberate, narrow carve-out
  (one direct call per cluster representative, concurrent with Step 4, never a
  follow-up turn) documented there. Every OTHER `tfaRcaTurn` call — every turn
  past 1, and every sibling's turn 1 — still goes exclusively through a
  dispatched coordinator.
- A soft-`PENDING` is never an answer: it must be drained with
  `getTfaTurnResult(testRunId, turnId)` before any further submit on that thread.
  Only a spent drain budget may end a test `PENDING`.
- Every failed test must end terminal in the CSV — partial-first, no abort-on-one-failure.
- Never gather `test_logs` — TFA owns logs.
- Never render/write a local RCA report — glimpse table + `triggerRcaReport` +
  the Test Observability UI link only.
- A PRODUCT_BUG RCA without a GitHub PR link is incomplete — dig until the turn
  cap, else state what was searched and record the gap.
- Step 4's first `gh pr list` call per repo MUST include `files` in `--json` —
  never split into a plain list followed by a per-PR `gh pr view --json files`
  backfill loop. A customer-supplied PR list is not that split: there is no list
  call to carry `files`, so per-PR IS the first call (Step 4).
- Every reference-doc / `lib/` path handed to a coordinator (in the dispatch
  prompt or in `agents/ai-tfa-coordinator.md`) MUST be `pluginRoot`-qualified
  (`<pluginRoot>/skills/rca-build/references/<file>.md`) — never a bare
  `references/<file>.md`, which resolves against an unknown coordinator cwd.
