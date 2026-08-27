# Template — THE gate (printed once, when the gate closes)

The screens printed before autonomous execution starts. After the gate screen prints,
the run never asks the user anything.

Which screens appear depends on which lifecycle this run is in, and the two never both
appear:

- **First contact ran this session** — `references/interview.md`'s T8 digest already
  showed the setup and took its approval, so § The review is skipped and only § The
  screen prints. Confirming the same thing twice in one session reads as not having
  listened the first time.
- **Repeat run** — § The review prints first, showing everything a previous run
  persisted and offering to change it, then § The screen. A setup approved weeks ago by
  someone who may not be the person here now is worth one look.

## Tags

Every field carries how it was resolved. One vocabulary, because a field can be
resolved without asking, answered, deliberately skipped, or proven broken:

| Tag | Meaning |
|---|---|
| `given` | **the customer said so** — supplied in the invocation. Outranks everything below it (`SKILL.md` § Part B, precedence) |
| `detected` | resolved without asking — the profile already held it, or a tool answered, **build metadata included** |
| `assumed` | inferred, and the inference is named |
| `answered` | the human supplied it at this gate |
| `skipped` | declined. A recorded gap, never re-asked |
| `failed` | replay ran and the value is wrong or unreachable |
| `stale` | verified, but longer ago than `context.staleAfterDays`. Not a failure and not a question — it is repaired lazily, at first use |
| `gap` | absent, and declared to TFA as such |

**Never print raw provider output.** A gate is a decision surface: a failure prints
as its class plus its next action, never as bytes.

**Name the profile and the file.** A run driven by the wrong profile is the worst
silent failure this design has, so both are always on screen. When selection had to
break a tie on specificity, print what else matched — that is how a bad
`buildMatch` gets fixed instead of quietly mis-routing every night.

**Print what selection MATCHED ON, not just what it chose.** `matchedBy` is the
difference between "this build's name and project picked this profile" and "nothing
matched, so you got the default" — and those look identical on a screen that prints
only the label. `default-profile` on a build the file was supposed to describe is the
single most useful line on this screen. And when `projectUnchecked` is set, say so:
the file declared a `projectMatch` and this run could not evaluate it, so the profile
on screen was chosen without the constraint its author added.

**Do not list a capability that can never be recognised.** `other` is the
catch-all; it would otherwise appear as a missing connector on every single run.

**A `viaFallback` is shown, not hidden.** `ci` served by the git forge is a correct,
common outcome — but a reader comparing two runs needs to see which one had a real
CI connector.

## The screen

```
GATE CLOSED
  profile: <label>   matched <pattern> (<matchedBy>)   [also matched: <label>, … — narrow buildMatch]
  build:   <name>    project: <name>   [project unchecked — insights unavailable]
  context: <abs path>/.rca-context.json

Capabilities:
  github   ✅ valid    (<what the profile records>)   repos 2/2 · base <branch>
  ci       ✅ valid    (<connector>, via github)       ← fallback: no separate CI connector
  infra    ✅ valid    (<connector>)                   <scope>
  logs     ⚠️  stale    (<connector>)                  last verified <date>
  metrics  ❌ gap                                      → declared to TFA

Intake:
  build id:        <id>                   (given)
  product repo:    <org/repo>             (detected — from the profile)
  automation repo: <org/repo>             (detected — from the profile)
  working branch:  <branch>               (given — build metadata, overrides profile <other>)
  default branch:  <branch>               (detected)
  PRs in play:     <repo#n, repo#n | none>  (given | detected | gap)
  [culprit-PR discovery: DISABLED — the supplied list is the candidate set]
  [overridden: <field> = <value> (given) — displaces <what it replaced> (<its source>)]

Warnings:
  · <branch> has no merged PRs in the last 30 days — culprit-PR attribution will
    have nothing to search. Expected on a quiet branch; worth a look otherwise.

Gaps declared to TFA (the run proceeds; these degrade evidence, not the run):
  · metrics — no connector recorded

Proceeding autonomously: discovery → clustering → fan-out (concurrency <N>, turn-cap <M>).
```

The `via` column names **whatever the profile records** for that capability. There
is no fixed set of runtimes or log stores to choose from. This template used to
enumerate several by name, which taught a default in one of the few files an agent
reads at gate time — outliving every deletion made elsewhere.

## The review (repeat runs only — SKILL.md § Part C)

Printed **before** the gate screen below, and only when first contact did not run this
session. Its job is that every value the run will act on is visible and correctable —
so it prints the profile, not a précis of it.

**Print what is there, not this shape.** A field the profile does not carry is omitted
rather than shown empty: `subpaths` absent means attribution runs repo-wide, and that
belongs in the warnings line where it is actionable, not as a blank row.

```
SETUP ON FILE — review before I start
  context: <abs path>/.rca-context.json
  profile: <label>          matched <pattern> (<matchedBy>)      approved <date>
  [!! OVERRIDE: <label> binds <overriddenBuildMatch> and does NOT claim this build —
      running on an explicit --profile. Confirm this is what you asked for.]
  others on file: <label>, <label>            [project unchecked — insights unavailable]

  binds builds: <buildMatch>
  binds project: <projectMatch>
  product repo(s):    <org/repo>, <org/repo>
  automation repo(s): <org/repo>
  subpaths:           <path>, <path>
  base branch:        <branch>          build ran on: <branch>

  github    <via>   <what proved it>              verified <date> (<N> days ago)
  logs      <via>   <what proved it>              verified <date> — STALE
  infra     <via>   <what proved it>              verified <date>
  metrics   gap     <class> — declared to the BrowserStack agent as unavailable

  knowledge: <artifact> — <part>
  warnings:  <one line each, including "no subpaths — attribution runs repo-wide">
```

**A supplied PR list turns discovery off, and the screen has to say so.** The customer's
list is the whole candidate set, so no window search runs for any repo — and a repo their
list never names has no candidates at all. Warn about those by name:

```
Warnings:
  · supplied PRs cover <repo>, <repo>. <repo> and <repo> have no supplied candidate —
    a failure implicating them reports no culprit rather than searching for one.
```

Without that line an empty `related_prs` for those repos reads as *we looked and found
nothing* when the truth is *nothing was offered for them*, and those need different
reactions from a human.

**Print what an override displaced, not just what won.** An invocation value outranks
build metadata (`SKILL.md` § Part B), so a run can legitimately read a CI run the insights
did not name. Show both sides on one line: nobody can reproduce or audit a run whose
inputs silently differed from the build's own metadata. And say once that an override is
**for this run only** — it writes nothing to `.rca-context.json`, because a pasted one-off
must not become the team's persisted scope.

**An override gets its own line, and it is loud.** `overriddenBuildMatch` is non-null
only when an explicit `--profile` was used against a build the profile does not claim —
a state no automatic path can produce. A live run reached it by re-running `select
--profile` to get past a refusal, then replayed five connectors green and called the
setup valid for a suite the profile does not name. On this screen that must be
impossible to read past.

**`matchedBy` is on the first line for a reason.** `default-profile` means nothing
matched this build and the file may not describe it at all — the single most useful
thing on this screen, and invisible if only the label is printed.

**Say how old each verification is, not just its date.** "verified 2026-06-02" reads as
fine; "verified 2026-06-02 (83 days ago)" is what makes someone look. Staleness never
blocks (`context.staleAfterDays` only relabels), so the number is the whole signal.

### The review question

One call. At least two options — a one-option part is refused and the whole call is
lost, so options that do not apply are omitted rather than padded:

```json
{"questions": [{
  "question": "This is the setup on file. Start the run with it, or change something?",
  "header": "Setup", "multiSelect": false,
  "options": [
    {"label": "Looks right — start", "description": "<N> capabilities verified, <M> gaps"},
    {"label": "Use profile <other-label>", "description": "also on file; binds <its buildMatch>"},
    {"label": "Change something", "description": "say which field and what it should be — repos, branches, a new profile"},
    {"label": "Finish setup", "description": "<capability>, <capability> have neither a connector nor a gap"}
  ]
}]}
```

Only the first option is always present. Drop `Use profile` when the file holds one,
`Finish setup` when the profile is provisioned, and — past the second pass —
`Change something`, which is what makes the loop terminate. With `Change something`
dropped and nothing else to offer, there is no question: say the setup is unchanged
and close.

**"Change something" is free-form on purpose.** The customer says what is wrong in
their own words — a branch, another repo, a whole new environment — and a menu of
fields could not cover "add a profile for staging" without becoming the interview
again. Apply it, persist it, re-verify what the change invalidated, print again.

## The one question

At most one, and only for a field that is both non-assumable and load-bearing.
In practice: the build id; the product repo when the profile's repos cannot be
corroborated against this build's failures and no PRs were supplied; and the
profile itself when the build name matched zero or more than one `buildMatch`.

If more than one survives, they are parts of ONE question — never a second call in the
same pass. § The review's correction passes reprint and re-ask **that same question**
after applying a change, at most twice; asking something *new* on a later pass is the
thing that is forbidden. See SKILL.md § The question budget for the arithmetic.

**A runnable but not provisioned profile spends the question differently.** If
GitHub is verified but some capabilities have neither a connector nor a recorded
gap, setup was abandoned partway. Ask: *finish setup now, or run GitHub-only and
record the rest as gaps?* Choosing GitHub-only **writes those gaps**, so the profile
becomes provisioned and this is never asked again. Without that, a customer who
stopped after GitHub is silently locked into a GitHub-only setup forever.
