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

Work down it. Stop as soon as a capability is bounded; the human is tier 4, not tier 1.

1. **The session's own tool list** — authoritative. If an MCP tool is listed, it
   exists and is reachable; no probe is needed to establish that.
2. **What the customer's repo says about itself** — CI workflow files, deploy
   manifests, IaC directories, `Makefile` / package-manifest scripts, and the
   dashboard or log-store URLs in READMEs and runbooks. A URL in a README is a
   *name*, not a verified connector.
3. **Connector-shaped skills** under the customer's `.claude/skills/`, when
   present. One additional source, nothing more: **their absence is the normal
   case and is never a warning.**
4. **The human** — for the residue only, at T3/T5/T6.
5. **`--help` / `--version` on a name already established by 1–4** — to learn its
   call shape and its field-projection flag. Never to discover existence.

## The pre-read budget, as a number

Against the customer's worktree, at T3b, once:

- **one** glob batch, then **at most 8** read/exec calls;
- all of them in a **single parallel message**;
- **no recursion** — you do not glob what a first glob revealed;
- **no file read past 200 lines**;
- **no dependency graph**, no lockfile parse, no per-service walk.

Nine calls total. This is a number because the prose version of the same
instruction failed twice. Budget exhausted with a capability still unbounded is not
a failure — it is what T5 and T6 are for.

## Question mechanics

Every call is one `AskUserQuestion` with this shape:

```json
{"questions": [
  {"question": "<one sentence, names the downstream consumer>",
   "header": "<≤12 chars>",
   "multiSelect": false,
   "options": [{"label": "<the answer itself>", "description": "<where it came from>"}]}
]}
```

Constraints the shapes below are designed to:

- **At most 4 parts per call, at most 4 options per part.** A fifth of either is
  not rendered, so a batched turn that would need five parts merges two instead of
  overflowing into a second call — a second call spends a second question.
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

## T1 — build id

Skip entirely if the invocation args already carry one. Otherwise one call, folded
into T0's message:

```json
{"questions": [{
  "question": "Which build am I analysing? A build id or a dashboard link.",
  "header": "Build id",
  "multiSelect": false,
  "options": [{"label": "<candidate id>", "description": "<from the invocation args | from a link in this session>"}]
}]}
```

With no candidate, the options list holds nothing usable and the answer arrives in
the free-form field — that is the expected path, not a degraded one. The build id
is the one genuinely load-bearing field: it drives `listTestIds`, and its **name**
drives profile selection on every later run.

## T2 — session inventory only

No question, no repo reading. Enumerate what this session has, in **one parallel
batch**:

1. **MCP servers and their tools** — already in your tool list. Nothing to run.
2. **CLIs** established by tier 1 of § Provenance.
3. **Connector-shaped skills.** Glob these four, because a skill can be
   project-scoped, workspace-scoped or personal, and only the first is obvious:

   ```
   .claude/skills/*/SKILL.md
   ../.claude/skills/*/SKILL.md
   ../../.claude/skills/*/SKILL.md
   ~/.claude/skills/*/SKILL.md
   ```

   Read the frontmatter and any capability declaration of each hit. **Absence is
   the normal case and is never a warning** — most customers have none.

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

For everything else, record `source: {kind: "mcp" | "cli" | "api"}` — no path, since
`via` already names it.

There is deliberately **no script for this.** Globbing four paths and judging
whether a skill is about your capability is reading and judgement, which is yours;
a discovery module would only be a list of places and patterns that goes stale.

The repo pre-read waits for T3b because there is no customer worktree to read yet —
see § Provenance for why reading the one under cwd is worse than reading nothing.

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

## T3 — GitHub: repos, branches, and the clone path

One call. Session-inventory and git-remote values become pre-selected options; when
the inventory is conclusive this degrades to a single confirm, which is still one
call.

```json
{"questions": [
  {"question": "Which repo holds the product code these tests exercise? Culprit-PR attribution searches it.",
   "header": "Product", "multiSelect": true,
   "options": [{"label": "acme/api", "description": "origin remote of ./api"}]},
  {"question": "Which repo holds the automation suite that produced this build?",
   "header": "Tests", "multiSelect": true,
   "options": [{"label": "acme/web-e2e", "description": "origin remote of cwd"}]},
  {"question": "Which branch do merged PRs land on, and which branch did this build run against?",
   "header": "Branches", "multiSelect": false,
   "options": [{"label": "main → main", "description": "default branch of acme/api; no build metadata yet"},
               {"label": "main → release/24.9", "description": "release/24.9 is checked out here"}]},
  {"question": "Which directory should I set up? The context file lands there, and I did not find one here.",
   "header": "Clone path", "multiSelect": false,
   "options": [{"label": "/Users/me/src/api", "description": "sibling of this plugin clone"}]}
]}
```

Part 4 is present **only** when T2b resolved nothing. The base/build branch pair is
deliberately one part with a `base → build` label so all four fit the render cap;
when part 4 is absent, split them into two parts and ask each plainly.

Every part names its downstream consumer, because a question whose answer nothing
reads is cut (`capabilities.md` § Two hard rules).

## T3b — repo pre-read

No question. One parallel batch against the **customer's** worktree resolved by T3,
inside the budget above. What you are looking for is bounds, not inventory: the
levels `capabilities.md` says each capability needs, and the names in tier 2 of the
evidence hierarchy. Record which artifact each name came from — T5 and T6 must be
able to cite it.

Also record `subpaths`: the directories inside the product repo these tests
actually exercise. If you cannot bound them, write `subpaths: null` explicitly — it
is how the culprit-PR hunt learns to print *"path overlap is repo-wide; attribution
may over-match"* instead of over-attributing silently.

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
   "options": [{"label": "<grouping>/<workload>", "description": "named in <artifact>"}]},
  {"question": "Which <dataset> holds this service's logs, and which field carries the service name?",
   "header": "Logs", "multiSelect": false,
   "options": [{"label": "<dataset> · <field>", "description": "named in <artifact>"}]}
]}
```

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
```

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
