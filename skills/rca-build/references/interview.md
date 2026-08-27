# First contact — the interview (T0–T8)

Loaded by `<pluginRoot>/skills/rca-build/SKILL.md` § Step 0b, once per repo. That
file owns **when** this runs and **how many questions** are allowed (§ The question
budget) — this file owns the turn order, the exact question shapes, the pre-read
budget, the provenance rule, the procedure-authoring template, all credential
handling, and the refusal wording. Per-capability question *content* lives in
`<pluginRoot>/skills/rca-build/references/capabilities.md`; the file being written
is annotated in `<pluginRoot>/skills/rca-build/references/context-file.md`.

**Contents:** [Provenance](#provenance--the-rule-that-replaced-the-vendor-table) ·
[Evidence hierarchy](#the-evidence-hierarchy-ordered) ·
[Pre-read budget](#the-pre-read-budget-as-a-number) ·
[Question mechanics](#question-mechanics) ·
[Credentials](#credentials--every-field-you-author-not-just-credential) ·
[T0–T8](#t0--greeting) ·
[GitHub failure classes](#github-failure-classes-and-the-2-re-ask-bound) ·
[Procedure template](#authoring-a-procedure-howtoquery--verifiedby) ·
[T8 digest](#t8--confirm-and-write)

---

## Provenance — the rule that replaced the vendor table

There used to be a probe table naming six products. It is gone, and this replaces it:

> **You may only probe a tool name that appeared in the session tool list, in a
> file you read during the pre-read, or in the user's own answer. Never a name you
> recalled from training. Before any probe, name the artifact the name came from.
> If you cannot, you invented it — drop it.**
>
> **And the pre-read source is the customer's worktree, never this plugin's. The
> plugin's own worktree establishes provenance for nothing.** On the documented
> install flow (`git clone <plugin> && cd <plugin> && claude --plugin-dir ./`) cwd
> *is* the plugin clone, so an unqualified pre-read reads our repo — which names
> runtimes and log stores in its own README, templates and examples. Reading them
> here would re-admit exactly the list that was deleted, and T5 would offer our
> tooling as the customer's stack.

Checkable, in a way a blocklist never was: "name the artifact" also forbids the
vendors nobody thought to blocklist. A `--help` or `--version` call is allowed
**only to learn the call shape of a name already established**, never to test
whether a name you guessed exists.

## The evidence hierarchy (ordered)

Work down it. Stop as soon as a capability is bounded; the human is tier 5, not tier 1.

1. **The session's own tool list** — authoritative. If an MCP tool is listed, it
   exists and is reachable; no probe is needed to establish that.
2. **The build's own metadata** — its name, branch, tags, environment label and CI
   URL, from the insights read at T1b. Free, exact, and describing *this* run rather
   than the customer's setup in general, which is what makes it the strongest bound
   available: an environment or tenant label here is frequently the literal name of
   the grouping a runtime, log or metric read has to be scoped to. Read it as a
   candidate bound and match it against tier 3 before asking a human or listing a
   control plane. A shared, product-named grouping and a per-run one commonly both
   exist and both answer to the product's name — only one of them served this build,
   and only the metadata says which.
3. **What the customer's repo says about itself** — CI workflow files, deploy
   manifests, IaC directories, test-selection and environment config, `Makefile` /
   package-manifest scripts, and the dashboard or log-store URLs in READMEs and
   runbooks. A URL in a README is a *name*, not a verified connector.
4. **Connector-shaped skills** under the customer's `.claude/skills/`, when
   present. One additional source, nothing more: **their absence is the normal
   case and is never a warning.**
5. **The human** — for the residue only, at T3/T5/T6.
6. **`--help` / `--version` on a name already established by 1–5** — to learn its
   call shape and its field-projection flag. Never to discover existence.

## The pre-read budget, as a number

Against the customer's worktree, at T2c, once:

- **one** glob batch, then **at most 8** read/exec calls;
- all of them in a **single parallel message**, plus **one** follow-up batch of the
  same size when a hit is worth following;
- **no file read past 200 lines**;
- **no dependency graph**, no lockfile parse, no per-service walk.

Nine calls, and at most nine more once. This is a number because the prose version
of the same instruction failed twice. Budget exhausted with a capability still
unbounded is not a failure — it is what T5 and T6 are for.

**Spend it on file reads, not directory listings.** A listing tells you a path
exists; it never tells you a repo name, a branch, a grouping or a service. A
pre-read that spends every call on listing, finding and remote-reading has learned
the shape of the tree and nothing in it, and arrives at T3 with only git remotes to
offer — which produces a wrong answer the customer must correct rather than an
absent one they get asked about. **If your calls returned only paths, the pre-read
has not started.**

**Following a hit is the point.** A glob or search that surfaces a promising
directory or file name has told you where to read, not what is there — so open
something in it. This rule used to read *"no recursion — you do not glob what a
first glob revealed"*, and that is precisely the instruction that stops a pre-read
one call short of the file holding the answer. The bound is the one follow-up batch
above: follow a hit that plausibly bounds a capability, and do not then follow what
*it* reveals.

## Question mechanics

Every call is one `AskUserQuestion` with this shape:

```json
{"questions": [
  {"question": "<one sentence, names the downstream consumer>",
   "header": "<≤12 chars>",
   "multiSelect": false,
   "options": [{"label": "<the answer itself>", "description": "<where it came from>"},
               {"label": "<the other answer>", "description": "<where THAT came from>"}]}
]}
```

Two options in the schematic because two is the **minimum**, not an illustration of
a batch. Every shape below shows at least two for the same reason.

Constraints the shapes below are designed to:

- **At most 4 parts per call, at most 4 options per part.** A fifth of either is
  not rendered, so a batched turn that would need five parts merges two instead of
  overflowing into a second call — a second call spends a second question.
- **At least 2 options per part, and the tool enforces it.** A part carrying one
  option is **rejected**, the whole call fails, and the customer sees nothing — so a
  batch mixing one settled part with open ones loses the open ones too. Two live runs
  lost a turn to exactly this.

  A part you can give only one answer to is not a question, it is a finding. **State
  it and move on**, and keep the question for something undecided. Never pad to two:
  an invented alternative you would not act on asks the customer to ratify a decision
  you already made, and if they choose it you are committed to something worse than
  what you had.
- **Options are answers, not prompts.** `label` is the value the agent will use;
  `description` names its provenance (`from git remote`, `named in
  .github/workflows/deploy.yml`, `MCP tool in this session`).
- The **free-form escape is always available** and is where every value the
  pre-read could not enumerate arrives. Never add an option whose label is
  "type it below".
- `multiSelect: true` **only** where more than one answer is genuinely usable:
  T3's repo parts and T5's capability picker. Everywhere else a second selection
  means the question was wrong.
- **Never offer an option you cannot act on** and never a level the customer's
  stack does not have (`capabilities.md` § Two hard rules).

## Credentials — every field you author, not just `credential`

There is **no credential-detection code, by product-owner decision.** Four
generations of pattern-matching for "is this string a secret?" broke in four
different ways, because that decision is a judgement and judgement in a pattern
breaks. The controls are the schema (no field a value fits in) and this prose. Both
are load-bearing; neither is a scanner.

1. **Never write a value a human typed.** Ask for the environment-variable
   **NAME** and record `credential: {kind: "env-var", name: "<NAME>"}`. When the
   tool authenticates from its own ambient config or a provider session, record
   `{kind: "provider-managed"}` and ask for nothing.
2. **A pasted credential is refused inline and never echoed.** Do not quote it, do
   not put it in a summary, do not put it in a tool call. Say:
   > That value is now in this session's transcript, so treat it as disclosed:
   > revoke and reissue it, then tell me the environment-variable name you put the
   > new one in. I will record the name, never the value.
3. **The rule covers every field you author, not just `credential`.** Plenty of
   log, metrics and webhook tools authenticate by query string or path token
   (`?api_key=…`), so *the literal call shape that worked* carries the secret —
   which means an honest interview, following only rule 1, still commits a
   credential to a shared repo. When authoring **`howToQuery.args`**, **`scope`**
   or **`verifiedBy.note`**, substitute a `${ENV_VAR_NAME}` placeholder for any
   secret-bearing element and record the variable name in `credential`. Never the
   literal, in any of the three.
4. **Raw provider output never reaches the file.** A failure is reduced to its gap
   class and its next action; the bytes stay in your context. `verifiedBy` is a
   structured claim, never captured output — `stdout`, `raw` and `body` are refused
   keys, so there is nowhere to put them anyway.

---

## T0 — greeting

No question, and **no tool output before it.** `<pluginRoot>/skills/rca-build/SKILL.md`
§ Step 0a holds the copy and the reason this ordering is a rule rather than a
preference. Say it, then name what you can actually see in this session (the MCP
servers, the skills) so the customer can tell the interview is short, and say once
that **GitHub is the only thing that can stop setup.**

One message, three parts, in this order: what BrowserStack already has · what only
they can supply · GitHub is the one thing that can stop this. The concrete
what-I-can-see list belongs after those three, not woven through them — it is
evidence that the interview is short, not part of the split itself.

Read the capability sequence before you plan the turns — it is config, not a list
in this file:

```
node <pluginRoot>/bin/rca-context.mjs capabilities
```

### T0 in adopt-or-extend mode

Entered when `select` refused with `no-matching-profile` or `no-matching-project`
(`SKILL.md` § Step 0b). A verified setup is already on disk and the only open question
is whether it covers this build, so **do not give the first-contact greeting** — it
would tell someone who has already done the setup that BrowserStack needs to learn
where their half lives.

Say instead, in one short message: what is on file, what it binds, that this build's
name is not in it, and that their connectors look reusable. Then one call:

```json
{"questions": [{
  "question": "<label> is set up and verified, but it binds <patterns> — this build is <name>. How should I handle it?",
  "header": "Profile", "multiSelect": false,
  "options": [
    {"label": "New profile for this suite", "description": "reuses <label>'s verified connectors; I ask only what differs — repos, subpaths, branches"},
    {"label": "Add this build to <label>", "description": "one pattern added; every later run of this suite resolves with no question"},
    {"label": "Use <label> for this run only", "description": "nothing is written; the next run asks again"}
  ]
}]}
```

**Which one is right is theirs to decide, and the difference is real.** A sibling suite
in the same environment often exercises different repos and different subpaths, so
adding a pattern to a profile whose repos are wrong buys a clean resolution and a wrong
attribution. Say that in the option descriptions rather than steering.

Then continue at **T2** — the artifact pass and the pre-read still run, because which
repos a *different* suite exercises is exactly what reading can answer. Skip T1 and T1b:
the build id came from the invocation and the insights were read at Step 0 to select.

## T1 — build id

Skip entirely if the invocation args already carry one.

Otherwise: **ask in the greeting's own text, not with `AskUserQuestion`.** A build id
is free text with no alternatives, and a part needs two genuine options or the call is
refused (§ Question mechanics). One sentence, folded into T0's message:

> Which build am I analysing? A build id, or a link to it on the dashboard.

**Two or more candidate ids** — several in the args, several links in this session —
is the one case that *is* a question, and then it is one call with one option per
candidate.

The build id is the one genuinely load-bearing field: it drives `listTestIds`, and
the **name and project** it resolves to at T1b drive profile selection on every later
run.

## T1b — fetch the build's insights

**No question, and nothing else happens first.** With the id in hand, read the
build's own metadata immediately:

```
fetchBuildInsights(buildId=<id>)
```

**Already read at Step 0 when the invocation carried the id** — that is where it has
to happen, because selection needs the build's name and project (`SKILL.md` § Step 0).
Do not call it twice. This turn exists for the other path: T1 just supplied an id that
the invocation did not, so nothing has been fetched yet.

This is the cheapest scope material in the whole interview and the only source that
describes *this run* rather than the customer's setup in general. Every later turn is
worse without it, so it is not something to get around to — it is the first tool call
of the interview.

What it answers, so you can stop asking for it:

| Field | What it bounds |
|---|---|
| the build **name** | which suite ran, and `buildMatch` for every later run's profile selection |
| `branch`, and any branch-carrying **tag** | T3's base/build branch pair, per role — a build commonly names more than one |
| an environment or tenant **tag** | frequently the literal name of the grouping `infra`, `logs` and `metrics` reads must be scoped to (§ Evidence hierarchy, tier 2) |
| the **CI run URL** | the CI system and the job path — `ci`'s project and pipeline identity, without asking |
| the **dashboard URL** | the project these results land in |
| failure categories, error overview, flake counts | what the artifact pass at T2 judges relevance *against* |

**A bound read here becomes a T5 candidate.** Naming a capability's project and
pipeline, or its grouping, and then not offering that capability is how a build ends
up declaring as a gap the one thing it told you where to find.

Read them as **candidate bounds, not verified ones**: a tag naming a grouping is a
name, and `capabilities.md` § Verified means still requires the read that proves the
credential can see it. What the metadata buys is not skipping verification — it is
not spending a question, and not searching a live control plane for a name the build
already gave you.

**If it is unavailable or errors, say so once and continue.** Every later turn
degrades to asking, which is the old behaviour and not a failure. What is not
acceptable is proceeding as though it had been read: the tiers below are ordered on
the assumption this one was tried.

## T2 — session inventory and the artifact pass

No question, and no repo reading yet. Enumerate what this session has and read what
the customer has already written down, in **one parallel batch**:

1. **MCP servers and their tools** — already in your tool list. Nothing to run.
2. **CLIs** established by tier 1 of § Provenance.
3. **What the customer has written down for their agents.** At each of four
   scopes — `.`, `..`, `../..`, `~` — because an artifact can be project-scoped,
   workspace-scoped or personal and only the first is obvious:

   ```
   .claude/skills/*/SKILL.md
   .claude/agents/*.md
   .claude/knowledge/**/*.md
   ```

   Three directories rather than one, because those are the locations **the harness
   itself defines**. This closes that set; it does not open a list — and the
   difference matters, because a customer's triage knowledge sits in `knowledge/` or
   in an agent definition at least as readily as in a skill, and a proving run walked
   past a populated `knowledge/` directory that a skills-only glob could not see.

   **Open each hit.** Read the frontmatter, any capability declaration, and enough of
   the body to judge it — a listing of these directories is not this step, it is the
   step before it. **Absence is the normal case and is never a warning.**

   These four scopes reach up and sideways. The customer's own repos are *downward*,
   and that is T2c's job — an artifact found there is a candidate on exactly the same
   terms as one found here.

**Some artifacts are not connectors at all, and those are the interesting ones.** An
artifact may carry a product area's own triage knowledge rather than a way to reach a
capability — decision heuristics, a taxonomy of suites, what a signature means for that
product. Judge those the same way and use only the parts that apply:

- **Take** what informs judgement: heuristics, taxonomies, what a failure means.
- **Never take** machinery: another flow's phase ordering, its trigger conditions, its
  output or digest contract, its own subagent model. Two orchestrations produce two
  answers and only one reaches the dashboard.
- **Never take anything that bounds scope.** An excerpt naming a repo, branch, path,
  service or component **is scope**, however it is phrased — "failures here usually come
  from <a service>" reads as triage and functions as a redirect. Scope is already
  answered by verified profile fields that outrank any artifact, and overriding them
  lands as a wrong PR on the dashboard.
- Record each part you will use with `record-knowledge`, naming the artifact, where you
  read it, and which part. Omit `--capability` when the knowledge is about the product
  as a whole.

**PR-hunting excerpts split three ways, and only one of the three is knowledge.** This
is worth stating because culprit-PR attribution is the run's deliverable, so it is the
subject a customer's artifacts most often cover — and the three cases have different
homes:

- **How to REACH the PRs** — the repo set, the base branches, the call shape, an
  alternate route such as a forge MCP server instead of a CLI — is a **connector**, not
  knowledge. It goes in `connectors.github` (`scope` / `howToQuery`) with
  `source: {kind: "skill", path}`, and it gets a live read before it counts. Filing it
  as knowledge would hand a coordinator a call shape as prose and change nothing about
  what actually runs.
- **Which PRs COUNT as candidates** — an exclusion, a ranking, a surface-to-code
  mapping, a "this class of change never causes that class of failure" rule — is
  judgement, and it **is** knowledge. Record it with `--capability github`.
- **An ARTIFACT that replaces the definition of the candidate window** is machinery and
  is refused. The window is
  `<pluginRoot>/skills/rca-build/references/github-evidence.md`'s: merged in
  `(baselineRef, build commit]` and touching the failing path. An artifact that narrows
  or ranks inside that window is additive; one that says candidates come from somewhere
  else entirely replaces it, and two definitions of "candidate PR" produce two answers
  where only one reaches the dashboard.

  **What decides this is who is speaking, not what is said.** An artifact is refused
  because nobody chose it for this run: it was found on disk, it may predate the code it
  describes, and it competes silently with a definition the run already has. **The person
  invoking the run is the opposite of all three** — they are speaking now, about this
  build, on the record. A PR list supplied at invocation therefore *does* replace the
  enumeration, it is tagged `given` on the gate screen, and `SKILL.md` § Step 0 and
  § Step 4 own that path.

  The carve-out is exactly that narrow. It admits a value a human typed for this run; it
  does not admit a file, a recalled convention, or an inference. Widening it to "anything
  may replace the window" gives back the two-answers problem this rule exists to stop.

**State the cost when a recorded route is not the CLI.** `<pluginRoot>/bin/prefetch-prs.mjs`
fetches the PR window once for every coordinator to share, and it speaks the forge CLI
only. A connector recorded on another route is honoured — you make the call yourself
from `howToQuery` — but the shared pre-fetch is bypassed, so each coordinator pays for
its own read. Say so at T8 rather than leaving someone to find it in a slow run.

**Account for every artifact you opened.** For each one: the parts recorded, or one
line saying nothing applied and why. This is a rule because the pass has no other
outcome — reading is silent, judging is silent, and "I looked and took nothing" is
indistinguishable from "I did not look" when both produce no record and no sentence.

That is not hypothetical. A live run opened three of a team's own artifacts — a
regression-RCA procedure, a culprit-PR finder, a build-triage engine — and recorded
nothing from any of them, in a run whose whole deliverable is culprit-PR attribution.
The culprit-PR artifact carried an explicit attribution heuristic. Everything else in
those files was machinery, so *most* of the judgement was right; what was missing was
any obligation to land the part that was not.

**A heavily-machinery artifact is the normal case, not a reason to take nothing from
it.** These files are written to orchestrate — phases, triggers, output contracts,
sub-agent rules — and all of that is correctly refused. The takeable part is usually
one or two sentences buried in it: what a failure shape implies, which surface owns
which kind of change, what the team has learned reads as a false positive. Read for
that, and expect to find it in a file that is 90% things you must not take.

The digest at T8 lists what was recorded, so this is visible rather than trusted.

**This is why T1b comes first.** Judging "does this apply to THIS build" needs the
build's metadata; with only an artifact's own description to go on, every artifact
looks plausibly relevant and none can be ruled out. What you have here is
build-level: name, branch, tags, failure categories, error overview. What you do NOT
have is per-test signatures; those arrive after the gate. So judge **candidates**
here and decide **application** per ask later, when the signature is in front of you.

**No question is asked before this pass** — T1 is the sole exception, and only when
the invocation carried no build id. Asking first and reading afterwards is how a
customer gets asked for something they had already written down.

**A skill is not a hint; it is a procedure.** An MCP tool or a CLI tells you a
capability is reachable. A connector-shaped skill additionally carries the repo map,
the branch conventions and the query conventions its author wrote down — which is
exactly the knowledge that makes attribution accurate and that no probe can
recover. So when a skill declares a capability:

- take its scope as **pre-filled**, and confirm rather than ask (T5/T6);
- still **verify it with a live read** — a declaration is not evidence, and treating
  one as proof is the defect that made the old gate trust scope probes it never ran;
- record `source: {kind: "skill", path: "<the SKILL.md you read>"}` on that
  connector, so a later run can re-read it and notice it changed. Without the path
  the record says "a skill informed this" and gives no way back to it.

  **Write the path relative to the context file** when the skill sits inside that
  directory's tree — `.claude/skills/logs/SKILL.md`. That is the portable case: a
  teammate who clones the repo gets the same skill at the same place.

  A skill found at `../.claude/skills/…` or `~/.claude/skills/…` is **machine-local**
  by construction — the first assumes the same workspace layout, the second is one
  person's home. Record it as you read it anyway: re-verification happens on the
  machine that will use it, so a local path is genuinely useful there. Just say at
  T8 that the capability is backed by a local skill, so nobody is surprised when a
  teammate is asked about it. An unresolvable path is not an error — it degrades to
  a targeted re-ask for that one capability, exactly like a missing tool.

For everything else, record `source: {kind: "mcp" | "cli" | "api"}` — no path, since
`via` already names it.

There is deliberately **no script for this.** Globbing known directories and judging
whether what is in them bears on your capability is reading and judgement, which is
yours; a discovery module would only be a list of places and patterns that goes
stale. The glob above is short and fixed because those directories are a harness
convention. The judgement about what is *in* them is never a list.

The repo pre-read is T2c, one turn later, once § Provenance's one refusal — this
plugin's own worktree — has been ruled out. Everything else reachable from the
invocation directory is fair game and is read before any repo question is asked.

## T2b — resolve the write target

No question. `.rca-context.json` lands in **the directory you were invoked in** —
not a repo chosen by lookup, and it need not be a git repo at all. The one refusal
is the plugin's own checkout: the documented install flow leaves cwd there, and a
context written there stages the customer's scope into the plugin's repository
(`code: "plugin-root-destination"`, and `plugin-root-context` when one is already
sitting there). Run:

```
node <pluginRoot>/bin/rca-context.mjs find --from <a candidate customer worktree>
```

Outcomes: a path (a teammate already committed one — you are not in first contact,
re-read `<pluginRoot>/skills/rca-build/SKILL.md` § Step 0), `no-context`
(expected), or `parse-error` (stop; write nothing — same section).

If **no** customer worktree is reachable from here, the local clone path becomes an
additional part of T3. Discovering that at write time means the customer answered
eight questions for nothing.

## T2c — repo pre-read

No question. One parallel batch, inside the budget above, against every customer
worktree reachable from the invocation directory — that directory when it is one,
and the checkouts sitting inside it. **Never this plugin's own worktree** (§
Provenance).

**This runs before T3, because T3's options are what you read here.** It used to run
after, on the reasoning that no customer worktree existed yet. That holds only when
cwd *is* the plugin clone; whenever the customer is invoked in a directory holding
their checkouts it is false, and the guard for the first situation switched reading
off in the second — leaving T3 able to offer nothing but git remotes.

What you are looking for is bounds, not inventory: the levels `capabilities.md` says
each capability needs, and the names in tier 3 of the evidence hierarchy. A suite's
own test-selection, environment or deploy config frequently names the **product**
repos and the branch it runs against — which is T3's question, answered without
asking it. An automation repo's remote is the one thing a git listing does give you,
and it is the one part of T3 you least need help with.

Record which artifact each name came from: T3, T5 and T6 must be able to cite it,
and an option you cannot cite is not a candidate (§ Provenance).

**Domain artifacts found here go through T2's pass, not a different one.** A repo's
own runbooks, agent prompts and `.claude/` directory are the same kind of thing as
what T2 globbed upward, and they are the likelier place for a product area's triage
knowledge to live. Judge them on the same terms — take heuristics, never machinery,
never anything that bounds scope — and record the parts with `record-knowledge`.

Also record `subpaths`: the directories inside the product repo these tests
actually exercise. If you cannot bound them, write `subpaths: null` explicitly — it
is how the culprit-PR hunt learns to print *"path overlap is repo-wide; attribution
may over-match"* instead of over-attributing silently.

**If T3's answer names a tree you did not read** — a repo not checked out here, or a
clone path supplied at part 4 — that is what the budget's one follow-up batch is
for. Spend it before T4.

## T3 — GitHub: repos, branches, and the clone path

One call, or **none**. What T2c read becomes the pre-selected options, and **every
option's description names the artifact it came from** — that is what makes it
checkable, and a candidate you cannot cite is not one.

**When the pre-read settled a part, drop that part.** This used to say a conclusive
pre-read "degrades to a single confirm, which is still one call", and that shape does
not exist: a part with one option is refused by the tool (§ Question mechanics), so
the whole call is lost — including the parts that *were* open. Say what you resolved
and what named it, then carry on. If every part is settled, T3 asks nothing and the
interview is one question shorter, which is the best outcome this turn has.

An option whose only provenance is a git remote is the weakest kind, and a question
built entirely from remotes means the pre-read found nothing — say so in the
descriptions rather than presenting a directory listing as a finding.

```json
{"questions": [
  {"question": "Which repo holds the product code these tests exercise? Culprit-PR attribution searches it.",
   "header": "Product", "multiSelect": true,
   "options": [{"label": "acme/api", "description": "named in <the file that named it>, under ./web-e2e"},
               {"label": "acme/api-worker", "description": "named in the same file"}]},
  {"question": "Which branch do merged PRs land on, and which branch did this build run against?",
   "header": "Branches", "multiSelect": false,
   "options": [{"label": "release/24.9 → release/24.9", "description": "named in <the file that named the repos>, beside them"},
               {"label": "main → main", "description": "default branch of acme/api; nothing read here named another"}]},
  {"question": "Which directory should I set up? The context file lands there, and I did not find one here.",
   "header": "Clone path", "multiSelect": false,
   "options": [{"label": "/Users/me/src/api", "description": "sibling of this plugin clone"},
               {"label": "/Users/me/src/web-e2e", "description": "the other checkout reachable from here"}]}
]}
```

**The automation repo is absent from this example on purpose.** The pre-read settled
it — one checkout, holding the suite this build's name matches — so it is stated, not
asked. That is the dropped-part rule above, and a live run lost a whole call by
sending it as a one-option part instead.

The clone-path part is present **only** when T2b resolved nothing, and only when more
than one directory is a genuine candidate; with exactly one, state it. The base/build
branch pair is deliberately one part with a `base → build` label so all four fit the
render cap; when the clone-path part is absent, split them into two parts and ask each
plainly.

Every part names its downstream consumer, because a question whose answer nothing
reads is cut (`capabilities.md` § Two hard rules).

## T4 — verify GitHub immediately

Two reads, in one parallel batch, against the values T3 just supplied: a repo read
that returns the default branch, and a merged-PR listing on the named base branch.
See `capabilities.md` § github for what counts. `gh auth status` and a version
banner are **route checks, not verification** — they prove a binary exists and say
nothing about whether this credential can see that repo.

**On pass, write the document immediately.** T4 is the first moment at which the
repos, the branches and one verified connector are all known, and the CLI's
per-connector verbs read a context that already exists:

```
node <pluginRoot>/bin/rca-context.mjs write --from <the directory being set up> --file <doc.json>
```

Print the path, and say whether that directory is a git repo: inside one, tell them
to commit the file so a teammate inherits it; outside one, say plainly that it is
local to that directory. From here on every capability is persisted the moment it
verifies, so abandonment costs the customer nothing and there is no partial state to
model.

`homeRepo` is optional and read by nothing — record it if you like, as a line for a
human opening the file. It used to select the destination; the destination is now
the directory you were invoked in.

**On failure, classify before you re-ask.** An unclassified loop re-asks a repo
name at an auth problem.

### GitHub failure classes and the 2-re-ask bound

Bound: **2 re-asks / 3 attempts.** The bound is on re-asks, not on retries, and
`<pluginRoot>/skills/rca-build/SKILL.md` § The question budget states that this
loop is never cut short by the ceiling — GitHub is the one capability a run cannot proceed without.

| Class | Response | Counts against the bound |
|---|---|---|
| No credential, or no local route at all | **Not a re-ask.** Print the local-setup instruction naming both routes (`gh` authenticated for the org, or a GitHub MCP server in this session), then **one** retry | no |
| Name failure — 404 on a repo or a branch | Re-ask **that field only**, with near-match suggestions from the remotes and branch list you already read | yes |
| Reachable, but the PR window is empty | **A warning, not a failure.** Record `verifiedBy: {count: 0, note: "no merges in window"}` — a count of 0 is a verified claim — carry the warning into the digest, and continue | no |
| Partial — 3 of 4 repos verified | The verified repos pass; each unreachable one is a **scoped gap**. GitHub is **satisfied** | no |
| Credential reaches the forge but not this repo | A scoped gap classified `credential-under-scoped-for-target`, on that target only. Never rewrite the team's scope to fit one machine's credential | no |

After the bound, refuse. **Write nothing extra and set no flag** — the absence of a
verified `github` connector *is* the marker, which is why there is no `complete`
field and no `blockedOn`. Whatever verified already is on disk.

**The refusal wording must not say GitHub is impossible.** The dashboard GitHub App
is out of scope for this *plugin*, not absent from the *product*, and a customer who
has it connected will otherwise open a support ticket:

> I can't start the RCA. Culprit-PR attribution is this run's deliverable, and it
> needs a **local** GitHub route from this machine — either the `gh` CLI
> authenticated for `<org>`, or a GitHub MCP server configured in this session.
> `<class>` is what failed, on `<field>`. Nothing you already confirmed is lost:
> it is on disk at `<path>`. Add one of those two routes and re-run
> `/rca-build <build id>` — setup picks up where this stopped. (If your team has
> the BrowserStack GitHub App connected on the dashboard, that is a different
> route and does not reach this plugin.)

## T5 — optional capabilities

One call, `multiSelect: true`, offering **exactly the candidates the pre-read
found** — never a fixed list.

```json
{"questions": [{
  "question": "I found these on your side. Which should I set up now? Each one I skip is recorded as a gap and declared to the BrowserStack agent as evidence I don't have.",
  "header": "Set up",
  "multiSelect": true,
  "options": [
    {"label": "Application logs", "description": "<store named in <artifact>>"},
    {"label": "Runtime", "description": "<control plane named in <artifact>>"},
    {"label": "Something else (describe)", "description": "name it and I'll bound it"},
    {"label": "None — GitHub only", "description": "records the rest as gaps; never asked again"}
  ]
}]}
```

Order candidates by evidence strength and keep the option count at four: when
candidates would push it past four, drop `Something else` first (the free-form
field covers it), never a candidate the pre-read actually found. A candidate you
cannot cite an artifact for is not a candidate — see § Provenance.

**A capability the build's own metadata identified is a candidate, and one of the
strongest.** T1b's fields are bounds: the CI run URL names the CI system and the job
path, the dashboard URL names the project. Those are cited to the build itself, which
outranks anything found by looking around — so they belong in this list before
anything the pre-read guessed at. A live run recorded `ci` as a gap while its own gap
note said the CI run URL was known from the insights: the bound was produced, then
dropped, and the customer was never offered the capability the build had already
located for them. **If T1b named a bound for a capability, that capability appears
here** — or the gap note has to say why it was not worth offering, and "it was known
but not offered" is not a reason.

Every unselected capability gets a recorded gap at T8, which is what makes the
profile `provisioned` and stops the gate re-offering setup forever.

## T6 — per capability: author, verify, record

One call for **all** selected capabilities, one part each, asking only for the
bounds `capabilities.md` says that capability needs and the pre-read did not
already answer:

```json
{"questions": [
  {"question": "Which <grouping> and which <workload> should I read for this service? I need both to scope a runtime read.",
   "header": "Runtime", "multiSelect": false,
   "options": [{"label": "<grouping>/<workload>", "description": "named in <artifact>"},
               {"label": "<other grouping>/<workload>", "description": "also present; named in <artifact>"}]},
  {"question": "Which <dataset> holds this service's logs, and which field carries the service name?",
   "header": "Logs", "multiSelect": false,
   "options": [{"label": "<dataset> · <field>", "description": "named in <artifact>"},
               {"label": "<dataset> · <other field>", "description": "the other field carrying an identity"}]}
]}
```

**A capability the pre-read fully bounded gets no part at all** — state the bounds and
verify them. Sending it as a one-option part fails the whole call, taking the
capabilities that genuinely needed asking down with it.

More than four selected capabilities: merge the parts that share an identifier
(logs and metrics usually share the service name) rather than spending a second
call. **Never ask for a level the customer's stack does not have** — a process
manager has no namespace, and asking for one tells the customer you do not
understand their setup.

Then, per capability, in one parallel batch: run the proving read, and persist
immediately.

- **Verified** → `upsert-connector`. Zero rows inside a quiet window is a
  **warning on the connector, never a gap** — `capabilities.md` § The empty-read
  rule; verification asks only whether the read was *authorised*.
- **Failed, declined, or out of budget** → `record-gap` and move on. **No loop:
  GitHub is the only capability that loops.**

```
node <pluginRoot>/bin/rca-context.mjs upsert-connector --from <the directory being set up> \
     --capability <c> --profile <label> --file <conn.json>
node <pluginRoot>/bin/rca-context.mjs record-gap --from <the directory being set up> \
     --capability <c> --profile <label> --classification <class> [--note <one line>] [--target <t>]
```

A gap without a classification is refused — an unclassified gap tells the next run
nothing. A "just confirm the values a skill declared" shortcut means *confirm, then
verify*: a declaration is not a read, and trusting one is the defect this whole
phase exists to remove.

### Authoring a procedure (`howToQuery` / `verifiedBy`)

Author the connector from the call that actually returned data — not from what you
intended to run.

```jsonc
{
  "via":        "<the tool as the customer names it>",
  "scope":      { "<their vocabulary>": "<value>" },      // open-keyed, on purpose
  "howToQuery": { "tool": "<argv[0]>", "args": ["<argv[1]>", "…"] },
  "credential": { "kind": "env-var", "name": "<NAME>" },  // or {"kind":"provider-managed"}
  "verifiedBy": { "count": 12, "note": "<one line, what came back>" }
}
```

- `args` is **argv, already field-projected** — one element per argument, never a
  joined string (a string is refused by the schema). No shell metacharacters,
  because nothing here runs through a shell. Project to the fields the ask needs:
  `<pluginRoot>/skills/rca-build/references/github-evidence.md`
  § Field-filtering.
- `verifiedBy` needs **`count` (an integer, 0 allowed) or `observedAt` (a
  `YYYY-MM-DD` day)** — `note` alone proves nothing and makes the profile
  unrunnable. Write the honest `{note: "attempted, …"}` when a read failed; it is
  writable, and the predicate is what refuses it, not the schema.
- `scope` keys are the customer's tool's words. A fixed key list is how the
  previous lineage locked out every stack but two.
- Substitute `${ENV_VAR_NAME}` in `args`, `scope` and `note` per § Credentials.
- **What you record is which call to make, not a command to run.** The plugin never
  executes `howToQuery` — `context-file.md` § `howToQuery` is documentation.
- **Never pin a per-build identifier into `args`.** The context file outlives this
  build; a run number, a build id, a time window or a commit sha baked into the call is
  wrong for every later build and — this is the part that bites — **replaying it still
  succeeds.** A live run stored a CI call ending `/351/api/json`, and the gate's replay
  returned HTTP 200 on every later build, so the capability read as verified while
  pointing at another build's run. That is the `checkBy: "<tool> --version"` defect one
  level up: the probe passes and proves nothing about the thing being asked.

  Record the **mapping** in `scope` — which field of the build's metadata names the run
  — and leave a `<placeholder>` in `args` where the resolved value goes, the same way
  `${ENV_VAR_NAME}` stands in for a credential. Then the value comes from T1b's insights
  at use time, which is where it is actually known.
- **`verifiedBy.note` describes the verification, not the build.** "run 351 answered on
  2026-08-25" is a note. "run 351 is the authoritative window for the build" is a
  per-build fact in a cross-build file, and it will be read as true by every run that
  inherits it.

## T7 — profile label and build binding

**Silent** (label `default`, no call) unless the pre-read found more than one
environment signal, or a context already holds a profile. Otherwise one call:

```json
{"questions": [
  {"question": "This looks like one of several environments. What should I label this setup, and which build names belong to it? Later runs auto-select by build name.",
   "header": "Profile", "multiSelect": false,
   "options": [{"label": "prod-web · Nightly Web Regression*", "description": "matches this build's name"},
               {"label": "default · *", "description": "one setup for every build"}]}
]}
```

`buildMatch` binds the build **name**, never the id — an id is unique, so the only
pattern that could match one is `*`. Authoring rules and the selection order are in
`context-file.md` § Profile selection; get the pattern wrong and every future run
either refuses or runs the wrong environment's repos.

**Record `projectMatch` alongside it, from the project the insights named.** Project
is the coarser bound and it is checked first: two projects routinely run suites with
near-identical names, and a `buildMatch` that matches both selects on a coin toss.
Write it even when the customer has one project — it costs nothing now and it is the
field nobody thinks to add later, when a second project is exactly what made
selection ambiguous.

Both patterns come from **T1b's insights**, not from the customer. They are already
exact; asking someone to retype a build name introduces a typo that fails silently as
a non-match on the next run. What the question above is for is the **label** and how
wide the pattern should be — that is a judgement about their environments, and it is
the only part they can answer better than the metadata can.

## T8 — confirm and write

One call, over a one-screen digest. Every field carries how it was resolved, in the
same vocabulary the gate uses (`<pluginRoot>/skills/rca-build/templates/gate-summary.md`
§ Tags) narrowed to the five this phase can produce:

```
SETUP — review before I commit it
  context: <abs path>/.rca-context.json          profile: <label>   binds: <buildMatch>

  build id:        <id>                          answered
  product repo:    <org/repo>                    answered
  automation repo: <org/repo>                    detected — origin remote of cwd
  base branch:     <branch>                      answered
  build branch:    <branch>                      detected — checked out here
  owned subpaths:  <path, path | none>           detected | gap (attribution runs repo-wide)

  github    verified   <via>   <what the read returned: N merged PRs into <branch>>
  logs      verified   <via>   <N rows | 0 rows in a quiet 6h window — warning, not a gap>
  infra     warned     <via>   authorised, empty listing for <workload>
  metrics   gap        declined at T5 — declared to the BrowserStack agent as unavailable
  ci        gap        <class> on <target>

  credentials: <NAME> (env-var name only — no value is in this file)

  knowledge: <artifact> — <part>                 will be used for <capability | this product>
             <artifact> — <part>                 will be used for <capability | this product>
             <artifact> — nothing applied         <one clause: why>
```

**The knowledge block is TEXT, never options.** A `multiSelect` here would hit the
four-options-per-part render cap, and a workspace holding a dozen artifacts makes
overflow the expected case rather than an edge. Corrections go through the existing
free-form "Correct a field" path — the same shape as correcting a branch.

**Omit the block only when nothing was OPENED.** It used to say "omit when nothing was
recorded", and that is the hole: a pass that read three of the team's artifacts and
took nothing from any of them printed the same screen as a pass that never looked, so
the customer had no way to tell which had happened — and neither did anyone reading the
run afterwards. An artifact that was opened and yielded nothing gets the
`nothing applied` line with its reason. Nothing opened, no block; absence of artifacts
is never a warning.

```json
{"questions": [{
  "question": "Commit this? Anything wrong, say which field and what it should be — I'll re-verify that one and come back here.",
  "header": "Write it?",
  "multiSelect": false,
  "options": [
    {"label": "Write it", "description": "commits to <path>; teammates inherit it"},
    {"label": "Correct a field", "description": "name the field and the value in the same reply"},
    {"label": "Close <gap>, <gap> — <N> more questions", "description": "<what each one buys, concretely>"},
    {"label": "Discard", "description": "keeps what already verified; nothing new is written"}
  ]
}]}
```

**The third option is offered only when there is something specific to close, and
it is named by VALUE, not by count.** "Want to answer more questions?" asks the
customer to price something they cannot see. "`metrics` is a gap — 2 questions and
pressure-vs-functional becomes distinguishable on this build" is a decision they can
actually make. Build the label from the digest's own gap lines: which capabilities
are gaps, what each would cost, and what each buys. If nothing is closable, the
option is absent — never offered as a bare "anything else?".

This is also where a dropped `Something else` goes. When T5's option cap forced the
free-form entry out (four real candidates fill the render budget), the open
"anything else do you have?" question has not been asked at all — and that is the
one question that catches a stack nobody wrote down. Offer it here, by name.

**T8 is a bounded loop, and this is the one place the budget can grow.** A
correction or a gap-closing round re-runs the relevant proving read, re-prints the
digest, and re-asks *this* call — which IS another `AskUserQuestion`, so pretending
otherwise is how the ceiling gets exceeded in practice. A real run spent three of
its five questions here.

So: **T8 is entered at most three times.** On the third entry the extension option
is gone and only `Write it` / `Correct a field` / `Discard` remain, so it terminates
by construction rather than by the agent's judgement. Worst case for the whole
interview is therefore **10**: the 8 of § The question budget, plus two further T8
passes. Still arithmetic, still checkable — which is the property that matters, and
the reason the ceiling is a number at all.

A customer who wants to keep going past that has a better route than more questions
in one sitting: the profile is already on disk and every capability persists the
moment it verifies, so re-running `/rca-build` resumes at the first capability with
neither a connector nor a gap. Say that instead of asking a fourth time.

Then apply any correction to the portable fields with a final `write` (additive —
the CLI refuses a document that would drop a profile, drop a connector, or replace
a verified connector with an unverified one), print the path, and record every
unselected capability as a gap so the profile is `provisioned`.

**Then fall through into Step 1.** First contact never ends the session, never
starts RCA work of its own, and never announces a separate setup command.
