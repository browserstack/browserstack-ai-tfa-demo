# `.rca-context.json` — the committed setup context

Read by `<pluginRoot>/skills/rca-build/SKILL.md` § Step 1 Part A on **every** run,
and written by its § Step 0b once. That file owns the lifecycle boundary (§ The
question budget), and `<pluginRoot>/skills/rca-build/references/interview.md` owns
the procedure that authors this file — this file is the shape: every field, why it
exists, and **what reads it**. A field nothing reads is not documented here as if
it does; where a field's only consumer is a
digest, that is what it says.

Everything deterministic about the file — where it lives, whether a profile is
runnable, which profile a build name selects, whether a write would discard a
teammate's verified connector — is in `<pluginRoot>/bin/rca-context.mjs`. **Never
hand-write JS to touch it, and never edit it with `Edit`/`Write` mid-interview.**
What goes *in* the file is judgement; where it goes is not.

**Contents:** [Where it lives](#where-it-lives-and-how-it-is-found) ·
[Why it is committed](#why-it-is-committed-and-deliberately-not-permission-hardened) ·
[The document](#the-document-annotated) · [Top level](#top-level-fields) ·
[Profile](#profile-fields) · [Connector](#connector-fields) ·
[`verifiedBy`](#verifiedby-is-a-shape-not-a-string) ·
[`howToQuery`](#howtoquery-is-documentation-the-plugin-never-executes-it) ·
[`gaps` and `warnings`](#gaps-and-warnings) ·
[The two predicates](#the-two-predicates-and-what-each-one-gates) ·
[Profile selection](#profile-selection) · [Refusals](#refusals-including-parse-error)

## Where it lives, and how it is found

**One file, in the directory the agent was invoked in.** That is the whole rule.
Resolution reads `.rca-context.json` there, then walks up at most three levels so
that running from a subdirectory of the same project still finds it.

That directory **does not have to be a git repo.** A workspace folder holding
several clones is a normal place to work, and it is where the file belongs if that
is where you are.

This replaced a resolver that took the `homeRepo` the document declared, searched
every level up *plus each level's children*, and used git-tracked-ness and the
`origin` remote to decide which of several nearby files to adopt. All of that
answered "which repo owns this context". The answer is now "no repo owns it — the
directory you are working in does", so there is nothing to adopt and nothing to
guess. It is also predictable: a customer can see where the file will land before it
lands, which the old rule could not offer. Run in a workspace of three clones, it
silently picked one of them.

**What that gave up, so it is a decision and not an accident:** a directory is not
necessarily a repo, so the file is no longer guaranteed to be committable, and a
teammate no longer inherits it just by cloning. Inside a repo it is still
committable and the gitignore refusal below still applies — so tell the customer to
commit it when they are in one. Outside a repo, say plainly that it is local to that
directory.

**One refusal, and it has no override: the plugin's own checkout.** The documented
install flow is `git clone <plugin> && cd <plugin> && claude --plugin-dir ./`, so
cwd *is* the plugin root on a first run. A context there would put the customer's
repos, branches and infra scope into the plugin's repository, where any `git add -A`
they run would stage it. Writing is refused (`plugin-root-destination`) and a file
already sitting there is refused rather than read (`plugin-root-context`).

```
node <pluginRoot>/bin/rca-context.mjs find   --from <dir>
node <pluginRoot>/bin/rca-context.mjs read   --from <dir>
node <pluginRoot>/bin/rca-context.mjs select --from <dir> --build-name "<name>" [--profile <label>]
```

**`--from` defaults to cwd**, which is normally exactly right. Pass it explicitly
only when the agent's cwd is not the directory the customer is working in — the
documented install flow, where cwd is the plugin checkout, is the case that matters.

`read` reports a **`trust`** field: `cwd` (found where you are), `ancestor` (found
within three levels up) or `caller-supplied` (an explicit `--path`). `select` adds `label`,
`matchedBy`, `alsoMatched`, `runnable`, `provisioned`, `capabilities`, `missing`,
`resumeAt`, `stale`, `ages` and the injected `todayISO` — all **outputs, not fields
in the file**. `resumeAt` in particular is *derived* (`missing[0]`); resume is never
stored, because a stored resume point goes stale the moment a teammate writes.

## Why it is committed, and deliberately NOT permission-hardened

It is committed so a teammate inherits it and is asked only for their own
credentials. That is the whole return on the interview.

Which means it must **not** be `0600`, and the module must contain no `chmodSync`
and no `hardenStateDir` call. Every other persisted file under `<pluginRoot>/lib/` is
owner-only and that is correct for them: they are machine-local state under a temp
directory. This one is a git-tracked artifact — git does not preserve the mode, so
hardening it buys nothing and breaks the teammate promise on the next checkout. The
tests assert the **absence** of the hardening idiom, because absence is the guard.

The safety property is not file permissions, it is that **there is nowhere in the
schema for a secret to live** (§ Connector fields) and the file is small enough to
review in a PR diff. No key named `value`, `raw`, `stdout`, `stderr`, `body`,
`response`, `token` or `secret` exists at any depth, and an unknown key is refused
rather than persisted.

Writes are **atomic** (temp file, then rename in the same directory), so a refused
or interrupted write leaves the committed file byte-identical. That is a filesystem
guarantee, which is why it is code's job and not yours.

## The document, annotated

```jsonc
{
  "_README": "Generated by the RCA plugin's setup interview. Commit it — teammates
              inherit it and are asked only for credentials. Credential VALUES
              never belong in this file; reference them by env-var NAME.",
  "schemaVersion": 1,
  "homeRepo": "acme/api",              // the repo this file lives in
  "defaultProfile": "prod-web",        // consulted ONLY when no build name is known
  "profiles": {
    "prod-web": {
      "buildMatch": ["Nightly Web Regression*", "web-prod-smoke-*"],
      "projectMatch": ["Web Platform"],
      "repos": { "product": ["acme/api"], "automation": ["acme/web-e2e"] },
      "subpaths": ["services/billing"],          // or null — see below
      "branches": { "default": "main", "observed": ["release/24.9"] },
      "connectors": {
        "github": {
          "via": "<forge CLI on PATH>",
          "scope": { "repo": "acme/api", "base": "main" },
          "howToQuery": { "tool": "<forge-cli>",
                          "args": ["pr","list","--repo","acme/api","--base","main",
                                   "--state","merged","--json","number,mergedAt,files"] },
          "credential": { "kind": "provider-managed" },
          "verifiedBy": { "count": 37, "observedAt": "2026-08-19",
                          "note": "merged PRs into main; newest #4188" },
          "verifiedAt": "2026-08-19"
        }
      },
      "gaps": [], "warnings": []
    }
  }
}
```

`_README` and `schemaVersion` are stamped by the `write` verb — never hand-write
them. A `schemaVersion` the resolver does not expect is its own named refusal
(`schema-version`), distinct from a missing field (`missing-field`), so a customer
on an older file is told which it is.

## Top-level fields

| Field | Why it exists | What reads it |
|---|---|---|
| `_README` | The file is reviewed in PRs by people who never ran the interview; the one thing they must know is that credential values do not belong in it | humans in a diff |
| `schemaVersion` | An integer, so a future shape change is a named refusal rather than a misread | `read`, which refuses a version it does not expect |
| `connectors.<cap>.source` | `{kind: "skill"\|"mcp"\|"cli"\|"api", path?}`. Whether there is a *procedure* behind the tool. A skill carries a repo map and query conventions a raw CLI does not; `via` is free text and could not distinguish them. `path` is required for a skill (so a later run can re-read it and notice it changed) and refused for the rest (`via` already names them). Relative to THIS file when the skill is inside its tree — the portable case. A `../` or `~/` path is machine-local: still worth recording, since re-verification runs where it resolves, and an unresolvable one degrades to a targeted re-ask rather than an error | Part A, when deciding whether to follow a skill; a coordinator's gather |
| `knowledge` | Profile-level list of parts of the CUSTOMER's own artifacts judged worth using — `{artifact, path, part, capability?, note?, judgedAt?}`. `capability` is a FIELD, and the list is profile-level, precisely so it cannot reach `missingCapabilities`: coverage there is `Object.hasOwn(connectors, c)`, so knowledge stored under a connector would mark an unverified capability answered and silence the gate's finish-setup offer. Omit `capability` for product-wide knowledge | the dispatch prompt (as verbatim excerpts), the gate digest, Step 6's completion notice |
| `homeRepo` | **Optional, and read by nothing.** It used to select the write destination; the destination is now the invocation directory. Kept because it is a useful line for a human opening the file, and `repos.product` already carries the same information for code | nothing — human readers only |
| `defaultProfile` | The single-purpose fallback for **"the build name is genuinely unknown"** — nothing else | `select`, step 5 only. It is deliberately **not** consulted when a known build name matches nothing |
| `profiles` | Labelled setups in one file, because one team runs several environments and a flat blob forces one to win | everything |

## Profile fields

| Field | Why it exists | What reads it |
|---|---|---|
| `buildMatch` | Binds build **names** to this profile so a later run auto-selects with no question | `select` (§ Profile selection) |
| `projectMatch` | Binds **project names**. Checked BEFORE `buildMatch`, as a filter — the coarse bound that stops two projects' near-identically named suites from selecting each other's profile | `select` (§ Profile selection) |
| `repos.product` | The code under test — the culprit-PR search surface | Part B intake, the culprit-PR hunt |
| `repos.automation` | The suite that produced the build — where a test-side defect lives | Part B intake |
| `subpaths` | Bounds path-overlap attribution inside a monorepo. **`null` is a real value, not an omission**: it records "path overlap runs repo-wide", which lets the hunt print *"attribution may over-match"* instead of confidently naming a PR that touched an unrelated package | the culprit-PR hunt (`<pluginRoot>/skills/rca-build/references/github-evidence.md` § Falsification protocol) |
| `branches.default` | The base branch the PR window is computed against | the culprit-PR hunt, the gate digest |
| `branches.observed` | Branches this profile's builds have actually run on — candidate values only | Part B, at precedence rank 3: below build metadata and invocation args, above a connector skill's intake-defaults |
| `connectors` | Per capability, the authored procedure — see below | Part A replay, `buildManifest`'s `discovered` |
| `gaps` | A capability deliberately or provably not available here | `provisioned`, `missingCapabilities`, the gate digest |
| `warnings` | Non-blocking observations worth a human's eye | the gate digest and the T8 digest — **nothing under `<pluginRoot>/lib/`** |

`repos` carries **roles**, not a flat list, and the roles are a closed set. A flat
list forces the "if there's exactly one other repo it must be the automation repo"
guess; naming the role deletes the guess, and with it the vocabulary translator an
earlier lineage needed between the file's words and the gate's. A flat array, a
bare string, or an unknown role is refused.

A `buildMatch` pattern with **more than one `*` is refused at write time**, because
matching returns false for it — persisting one would make the profile silently
unreachable, which is worse than a refusal at authoring time.

## Connector fields

| Field | Why it exists | What reads it |
|---|---|---|
| `via` | What the customer calls the thing that serves this capability. Free text on purpose: the previous version's `via` was an enum of six product names | `buildManifest(config, discovered)` as `[{capability, via}]`; printed in the gate digest |
| `scope` | The resolved targets, **open-keyed in the customer's own vocabulary**. A fixed key list is precisely how two vendor names shipped as schema field names and locked out every other stack | you, when you re-author the call; the gate digest |
| `howToQuery` | Structured `{tool, args[]}` — **which** call returned data | you, at call time. Never an executor — see below |
| `credential` | Either `{kind: "env-var", name: "<NAME>"}` or `{kind: "provider-managed"}`, and nothing else | you, to resolve the variable at call time |
| `verifiedBy` | The claim that a live read succeeded — see below | `isRunnable`, staleness, the gate digest |
| `verifiedAt` | **Day precision.** Millisecond precision guarantees a merge conflict every time a teammate writes | staleness at selection |

`credential` is a **closed object**: an unrecognised `kind`, an env-var name that is
not a valid variable name, a `name` on a `provider-managed` credential, and any
extra key are each refused — and the refusal names *where* it was without quoting
*what* it was, because refusals get printed. There is no `value` key at any depth,
by design, so a pasted secret has nowhere to go. That is the schema half of the
story; the prompt half is `interview.md` § Credentials, and it covers `args`,
`scope` and `note` too, because a query-string token lands in those.

`verifiedAt` is stamped by `upsert-connector` from the injected day
(`--today`), never read from the clock inside the library — which is what keeps
selection and staleness deterministic under test.

### `verifiedBy` is a SHAPE, not a string

**`{count: <integer>}` or `{observedAt: <YYYY-MM-DD>}` — at least one — plus an
optional free-text `note`.** No other key: `stdout`, `raw` and friends are refused,
so captured output cannot get in.

It was a non-empty string in the first draft, and that was the single worst defect
in the design: the lifecycle boundary rests on this field, and a non-empty string is
satisfied by `"TODO"` and by `"attempted, could not list PRs"` — both of which an
agent hedging instead of failing will write. It is the same defect this project already shipped
once, one level up: a `checkedBy` field that recorded a tool's version banner —
which satisfied the presence check and proved nothing about whether the scope was
ever read. A shape check is decidable — no judgement, no pattern over
content — and it can be mutation-tested against `{note: "TODO"}` rather than only
against `""`.

Two consequences worth stating:

- **`{count: 0}` is verified.** A reachable target with an empty window is a
  warning, not a failure (`capabilities.md` § The empty-read rule). Refusing to
  call 0 verified would loop a customer whose repo simply has no merges in the
  window.
- **`{note: "attempted, …"}` is *writable*.** The schema accepts an honest
  attempt record; `isRunnable` is what refuses it. Recording the honest attempt is
  correct — it tells the next run what was tried.

### `howToQuery` is documentation. The plugin never executes it.

**Say it plainly: nothing in this plugin runs `howToQuery`.** It records **which**
call to make. You read it and make your own tool call, at call time, under the
user's own permission layer, re-authoring and re-quoting from the structured
fields.

That structural choice is what removes the hazard, and it is not sufficient on its
own. This repo's documented way for an agent to make exactly this kind of read is a
**shell string** — `node <pluginRoot>/bin/cached-exec.mjs <buildId> <writerId>
'<command>'` — and that binary runs `execSync(cmd, {shell: true})`. So:

> A stored `howToQuery` may inform **which** call to make. It is **never**
> reconstructed verbatim into a string passed to a shell-invoking wrapper. You
> re-author and re-quote the call at call time, from the structured fields.

Joining `args[]` into that wrapper re-opens the hazard one hop away: a PR editing
`.rca-context.json` — a file reviewers skim as config — would then change what
commands the agent runs. This is also why `args` must be **argv, one element per
argument**: a joined command string is refused by the schema, which makes any such
reconstruction deliberate rather than accidental. The durable fix, an argv-only
interface on `<pluginRoot>/bin/cached-exec.mjs`, is a recommended follow-up and is not in place.

## `gaps` and `warnings`

A gap is `{capability, classification}` plus optional `note` and `target`.
**`classification` is mandatory** — an unclassified gap tells the next run nothing
and it is refused. `target` is what makes a gap *scoped*: one unreachable repo out
of four is a gap on that target, and the capability stays valid for the rest.
`credential-under-scoped-for-target` is a distinct classification on purpose, so
someone whose credential is narrower than the team's recorded scope is never led
into rewriting the team's scope to fit their machine.

Gaps are **append-only and idempotent**: recording the same gap twice does not
double it, or the digest would grow on every run.

```
node <pluginRoot>/bin/rca-context.mjs record-gap --from <the invocation directory> \
     --capability <c> --classification <k> [--note <one line>] [--target <t>] --profile <label>
```

`warnings` is written **only** as part of a full `write` document — there is no
`record-warning` verb. A warning noticed after the document exists is carried in
that run's digest and is persisted only if a later `write` includes it. Do not
record something as a warning when it is a gap: a gap changes what the run declares
to the BrowserStack agent, a warning does not.

## The two predicates, and what each one gates

Both are decidable from the file. Neither is a judgement. Each has exactly one
consumer — which is the point, because the version of this design that computed a
completeness value read by nothing was the same "computed but never consumed"
pattern this project keeps repeating.

| Predicate | Definition | What it gates |
|---|---|---|
| `runnable` | `connectors.github` exists **and** its `verifiedBy` carries a `count` or an `observedAt` | **the lifecycle boundary.** Runnable → the gate; not runnable → first contact. "Runnable" and "GitHub verified" are the *same* predicate, which is what keeps this a file test rather than a judgement — the test a later run applies *is* the test that would have caught a partial setup |
| `provisioned` | every capability in the config's `evidenceRouting` sequence has **either** a `connectors` entry **or** a `gaps` entry | **only** whether the gate offers to finish setup. It never blocks a run |

No other capability substitutes for `github` in `runnable`: without the code and the
merged PRs there is no culprit PR, which is the run's entire deliverable.

**Runnable is not finished, and conflating them locks a customer in.** GitHub is
asked first, so someone who abandons the interview right after it has a *runnable*
profile — first contact never fires again, and every later run quietly declares the
rest unavailable. That is what `provisioned` exists to catch: a profile that is
runnable but not provisioned spends the gate's single question on *finish setup now,
or run GitHub-only and record the rest as gaps?*, and choosing GitHub-only **writes
those gaps** so the question is never asked again
(`<pluginRoot>/skills/rca-build/templates/gate-summary.md` § The one question).

There is deliberately **no `complete` flag** and no `blockedOn`: both are derivable
from the two predicates, and a stored flag can disagree with the file it describes.
`complete` and `resumeAt` are refused keys, so nobody can add them back by writing
one.

**Staleness** is a date comparison at selection against the injected day
(`context.staleAfterDays`, default 30). It never blocks and never asks by itself —
it downgrades a digest line from `verified` to `stale`. Repair is lazy, at first
use: GitHub is rechecked at the gate for free because Step 4's PR-window fetch *is*
the recheck, and every optional connector is verified by the first routed ask that
uses it — that one call is simultaneously the gather and the verification. A
capability no ask routes to costs nothing.

## Profile selection

`select` resolves one profile, deterministically, **with no regex anywhere**. First
hit wins:

1. **`--profile <label>`** → exact key match. A near miss **refuses**, listing the
   labels. No fuzzy match: a typo resolving to a neighbouring label is a
   wrong-context run with no signal at all. An explicit label outranks a build name
   that matches a different profile (`matchedBy: "requested"`).
2. **A project name FILTERS the candidates**, before anything is scored: a profile
   survives if its `projectMatch` matches, or if it declares none (no opinion).
   Project is the coarser bound and it goes first because two projects routinely run
   suites with near-identical names — selecting on the name alone would pick one of
   them by coin toss and run against the other's repos. Nothing surviving **refuses**
   (`code: "no-matching-project"`).

   **An unknown project does not refuse.** Insights can be unavailable, and a
   declared `projectMatch` that cannot be evaluated passes rather than eliminating —
   the same degradation as an absent build name. The result then carries
   `projectUnchecked: true`, the gate prints it, and the reader knows the profile on
   screen was chosen without the constraint its author added. A silently unapplied
   constraint is how a build gets attributed to the wrong project's repos while every
   refusal in this list stays quiet.
3. **A build name** → surviving candidates are those with a matching `buildMatch`
   (`matchedBy: "build-name"`).
4. **Several candidates** → most literal characters wins, and the loser comes back
   as `alsoMatched` so the gate can print it — that is how a bad `buildMatch` gets
   fixed instead of quietly mis-routing every night. **An exact tie refuses**,
   naming both labels. Never alphabetical, never first-key-in-file: JSON key order
   is a hidden ordering a reformat silently changes.
5. **Zero candidates with a known build name** → **refuse**, unless exactly one
   profile declares no `buildMatch` at all, which has no opinion and is used
   (`matchedBy: "sole-profile"`). `defaultProfile` is deliberately not consulted, and
   neither is "it is the only profile in the file": a name matching nothing means the
   file does not describe this build.

   This used to adopt the sole profile whatever it declared, and the refusal one line
   down already argued against it. A live run took a profile bound to one suite, applied
   it to a differently-named suite's build, and reported the setup as valid — the other
   suite's four product repos and base branches included. A narrow pattern is a
   deliberate statement; a customer who meant every build writes `*`.
6. **Build name genuinely unknown** → `defaultProfile`
   (`matchedBy: "default-profile"`), printed loudly. Its only job.
7. The selected profile must then be **runnable**. If it is not, **refuse — never
   silently switch to a runnable sibling.** That substitution is the wrong-context
   run in its purest form: the customer asked about one environment and got an
   answer about another.

### Authoring `buildMatch` and `projectMatch`

Both fields are the same shape, validated by the same code and matched by the same
function — `matchesBuildName` is the matcher for either. Matching is **case-folded,
whole-string, and at most one `*`**, implemented with string arithmetic:

- **Anchor it.** `nightly` does **not** match `web-nightly-*`, and `web-nightly-*`
  does not match `prod-web-nightly-12`. Substring matching is how the wrong profile
  gets selected, and a wrong profile is a run against another environment's repos
  and branches.
- **One wildcard.** A second `*` matches nothing, so it is refused at write time
  rather than persisted as an unreachable profile.
- **Match the build NAME, never the id.** An id is unique, so the only pattern that
  could match one is `*`.
- **Keep patterns disjoint across profiles.** Two patterns of equal specificity
  matching one name is a refusal, not a coin flip — and the customer sees it on the
  night it happens, not silently for a month.

## Refusals, including `parse-error`

Every verb prints JSON on stdout and exits non-zero on refusal, with a `code` to
branch on and a `message` written for the customer: `1` is a refusal, `2` is a usage
error. Prose goes to stderr so stdout stays parseable.

| `code` | Meaning | What to do |
|---|---|---|
| `no-context` | Nothing resolvable from here | First contact. Not an error in the product sense |
| **`parse-error`** | The file exists and cannot be parsed — a hand-resolved merge conflict is the common cause | **A third state: refuse and write nothing.** Print the path it names and stop. Never treat it as "no context" — that re-interviews the customer and overwrites the team's file, throwing away every answer already given |
| `schema-version` / `missing-field` | The file is parseable but not this shape | Print `found`/`expected` or the named `fields`; do not guess a migration |
| `not-runnable` | The selected profile's GitHub connector proves nothing | First contact for that profile. Never switch to a sibling |
| `ambiguous-profile` / `no-matching-profile` / `unknown-profile` / `no-default-profile` / `no-profiles` | Selection could not decide | Print the labels and let the gate's one question resolve it |
| `would-regress` | The write would drop a profile, drop a connector, or replace a verified connector with an unverified one | The file is byte-identical. Fix the document, not the guard: writes are **additive** |
| `invalid-context` | The document failed validation — a closed-key violation, a bad credential, a joined `howToQuery` | Refused **before** anything is written, and it names *where* without echoing *what* |
| `ignored-destination` | A `.gitignore` rule matches the destination | Refuse: an ignored context can never be committed, so it can never be inherited |
| `plugin-root-destination` | The invocation directory IS the plugin's own checkout | Run from the customer's working directory, with the plugin loaded via `--plugin-dir` |
| `no-directory` | The invocation directory does not exist | Nothing to fix in the file; the caller passed a bad `--from` |

Two of these are load-bearing enough to repeat: **`parse-error` is not
`no-context`**, and a refused write leaves the committed file **byte-identical**.

## Why a knowledge entry has no digest, and what that costs

An entry is a locator — artifact identity, path, part — and nothing more. It carries no
content hash, no lifecycle state, no tombstone. So on a later run the agent re-reads the
part and **judges** whether it still says what it was recorded for; the file cannot tell
it that the text changed.

That is a deliberate trade and the cost is real: drift is not *provably* visible, only
noticeable. A hash would make "this changed" decidable, and a state field would let a
rename be distinguished from a deletion. Both were designed and both were left out,
because they are machinery in service of a capability with no evidence behind it yet —
and this project has repeatedly shipped that kind of mechanism and then deleted it.

Adding a digest later is one field and one comparison. Removing a state machine nobody
needed is not. If re-judgement proves too weak in practice, that is the first thing to
add — and the absence is enforced by the closed key set, so adding it is a deliberate
act rather than a drift.

**Re-read rules, which are the agent's:** if the part is gone, drop it and say so — the
artifact may still be present with only the part unresolvable, which is the signal a
human needs. If it now reads as machinery or as a scope claim, do not use it, whatever it
said when it was recorded. If it still applies, use it.
