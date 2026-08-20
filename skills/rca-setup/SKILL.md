---
name: rca-setup
description: One-time setup conversation for the RCA plugin. Discovers what this machine already has (executables, MCP servers, repo layout) and which capability each serves, interviews only for the scope discovery cannot resolve, verifies every capability with a live read, confirms at a single gate, and persists a commit-safe context the run skill consumes. GitHub via gh or a GitHub MCP server is mandatory; everything else degrades to a recorded gap. Args: none — run it once per repo.
---

# rca-setup — the one-time setup conversation

Run once per repo. Produces `.rca-context.json`, committed, which `/rca-build`
consumes so the repeat loop asks nothing.

The division this whole flow rests on: **discovery resolves capability, the
interview resolves scope, verification proves both.** Discovery can find that a
forge CLI is on PATH or that a metrics MCP server is in the session. It cannot
find which
namespace, which log index, or which subpath of a monorepo is yours. That residue —
and only that — is what a human gets asked about.

## Mandated reading

Files this skill's flow requires loading. The per-skill API guard in
`tests/wiring.test.mjs` asserts that every `lib/` export this skill drives is
documented across this set, and the prose-budget check measures this set plus this
body. Paths are `pluginRoot`-qualified because a subagent starts in an unknown cwd.

- `<pluginRoot>/skills/rca-setup/references/api-reference.md`
- `<pluginRoot>/skills/rca-setup/references/context-api.md` (shared with `rca-build`,
  so the signatures both skills need live in one file rather than two copies)
- `<pluginRoot>/skills/rca-setup/references/capability-sequence.md`
- `<pluginRoot>/skills/rca-setup/references/verification-failures.md`
- `<pluginRoot>/skills/rca-setup/references/context-resolution.md`

- `<pluginRoot>/skills/rca-setup/templates/gate-digest.md`
- `<pluginRoot>/skills/rca-setup/templates/context-file.md`

## Reference material (not loaded per run)

Read when you want the shape of a whole run, not on the way through one — which is
why it sits outside the mandated set the budget measures.

- `<pluginRoot>/skills/rca-setup/examples/sample-setup.md` — one worked interview,
  pinned to `tests/fixtures/discovery/full-stack.json`.

## Step 0 — mode

**Headless (`claude -p`) does not interview.** Load the context, validate it,
report the result, and end. Fail fast when none exists. There is no synchronous
human to answer a question, so asking one would hang.

Interactive, and a **valid complete** context already exists → this is not a
re-interview. Show the gate, accept per-field correction, persist only if something
changed. "Valid" means schema-valid; see Step 5 for the case where such a
context's GitHub no longer verifies.

## Step 1 — discover, before saying anything

Collect the environment, decide what each tool is, and hand both to
`planInterview()`:

- executables on PATH — scan broadly, not only the names the table hints at, or an
  unfamiliar runtime or deploy CLI can never surface at all,
- MCP servers present in this session: pass **your own available tool names
  through verbatim** (`mcp__prometheus__execute_query`, `claude_ai_Slack`).
  Fingerprint matching is one-way substring containment, so no parsing, filtering
  or server-name derivation is needed — deriving one is how this gets it wrong,
- repo paths the table hints at, where they exist,
- connector-shaped skills at `.claude/skills/`, `../.claude/skills/`,
  `../../.claude/skills/`, `~/.claude/skills/`.

**Then assign.** `seedHints` in the table recognise the common cases; they are hints
and nothing more. You decide which capability each tool serves — that a runtime CLI
is this team's runtime, that a metrics MCP server is their metrics — and pass it as
`assigned`, which beats a hint unconditionally. A hint list only knows the vendors
someone wrote down, and most customers are not on that list.

```js
const { table, violations } = loadCapabilityTable(config, read?.context?.capabilities);
const plan = planInterview({ table, env, assigned, connectorSkills });
// plan.questions is the interview. plan.relevant is "your repo shows this but this
// machine cannot reach it" — ask its questions anyway; a teammate inherits them.
```

Nothing here is executed, so it is cheap enough to
run before the greeting. Load the table with `loadCapabilityTable`; a non-empty
`violations` array is a bug in the shipped config, not a customer problem — report
it and stop.

Connector skills are a **less-trusted** input, not a more-trusted one: they are
read from four filesystem paths including a home directory, so they may only fill
fields the
table declares.

## Step 2 — greet with what you found

Name the split concretely: what BrowserStack already has (test logs, traces,
screenshots, sessions) versus what only they can supply. Then list what discovery
actually found on this machine, and say how many questions remain.

A canned split is true and useless. The concrete one — "you have `gh` and
`<their runtime CLI>`; I need your namespace and your log index" — is the same
statement with
the machine in it, and it tells the customer the interview is short.

Say once, here, that GitHub is the only capability that can stop setup.

## Step 3 — walk the capabilities

Follow `<pluginRoot>/skills/rca-setup/references/capability-sequence.md`. In short:
GitHub first, then logs, pipeline/CI, infra, metrics, then an open "anything else".
One question per turn, only for `unresolvedFields`, only for fields the table
declares. Every optional capability is skippable; a skip is a recorded gap and is
never re-asked. GitHub is not skippable and the refusal is bounded.

The repo-context scan runs **inside** GitHub scope resolution, because its output is
the owned subpaths and GitHub's path-overlap test is their only consumer.

## Step 4 — verify

Follow `<pluginRoot>/skills/rca-setup/references/verification-failures.md`.

**What "verified" means is stated per capability**, in that row's `intent` in
`config/rca.config.json`. Read it. For infra it says the runtime must answer for
the named scope, "not merely that some runtime CLI exists on PATH" — that
distinction is the whole point, and it differs by capability.

**You run the check.** `lib/` cannot spawn a process or invoke an MCP tool, and it
no longer builds commands for you to run: how to verify a Fly.io app, a Coralogix
index or a Dynatrace scope is your judgement. Do it per resolved target, not per
tool — a capability valid for one repo and 404 on another stays valid for the one
that passed.

**Then report what you actually checked**, and hand it to `validateVerification`:

```js
const { result, violations } = validateVerification({
  capability: "metrics",
  row: table.metrics,
  result: {
    verified: true,
    via: "mcp__dynatrace__metrics",          // the tool or server you used
    targets: [{
      field: "metricsNamespace",              // must be a field the row declares
      value: "prod-eu",
      ok: true,
      checkedBy: "mcp__dynatrace__metrics timeseries builtin:host.mem.used, scope prod-eu -> 1 series",
    }],
    scopes: ["metrics.read"],                 // when the provider reports them
  },
});
```

`checkedBy` is the load-bearing field: name the command, tool call or API request
AND the scoping arguments, specifically enough that a reader can tell what was
proven. **A target reported `ok` with no `checkedBy` is recorded `unverified`, not
verified** — a claim with no named check carries no information, and this is what
stops a capability probe standing in for a scope it never read.

A target you could reach but could not prove is `{ok: false, state: "unverified"}`
and needs no gap: nothing is wrong, there is simply no evidence.

A failure needs `gap: {class, nextAction}` where `class` is one of `GAP_CLASS` and
`nextAction` is non-empty. The three classes prescribe opposite remedies — install
something locally, re-ask the team's scope, or fix a credential's rights — so
choosing among them from the evidence is your call and nothing derives it for you.

`violations` names anything wrong with the report itself: `unsupported-claim`,
`undeclared-target-field`, `bad-gap-class`, `gap-without-next-action`,
`via-missing`, `targets-missing`, `verified-without-a-checked-target`,
`secret-in-result`, `raw-output-in-result`. Fix the report and re-validate; a
non-empty `violations` is your mistake, not the customer's.

**Never put raw provider output in the report.** Reduce a failure to its class and
next action — the bytes stay in your context. `validateVerification` refuses a
`raw`/`stdout`/`stderr`/`body` key anywhere in the shape, and refuses any
credential-shaped string, because this record reaches a committed file.

For GitHub, pass the validated result through the gate as well — it is the
mandatory capability and its refusal is binary:

```js
const gate = githubGate(result);          // result from validateVerification
if (gate.blocking) stop(gate.message, gate.nextAction);
```
 On an MCP route with no command to run for
the base branch, the merged-PR count you obtain IS that target's evidence — put
the count in `checkedBy` and run `prWindowWarning` on it, because an empty window
predicts a dead culprit hunt and persists into the context.

If a customer pastes a credential value at any point: refuse it, do not echo it,
give rotation guidance, and continue asking for the variable name instead.

## Step 5 — the gate

Print the digest from `<pluginRoot>/skills/rca-setup/templates/gate-digest.md`.
Tagged fields, gaps, warnings, destination — never raw probe output.

Accept correction **per field**, and re-verify only that field. Bounded: after a
stated number of rounds a still-failing field persists as `unverified`.

**GitHub is exempt from `unverified`.** It is the only mandatory capability, so a
context that closed with GitHub unverified would claim completeness while every run
against it refuses, and the customer would have no signal which rule applies. When
GitHub correction exhausts its rounds, stop with the binary refusal and write a
partial instead of closing.

**An inherited context whose GitHub no longer verifies** gets the gate with GitHub
tagged `failed` and credential correction plus re-verification **only** — never the
interview. A teammate was promised they would be asked for credentials and nothing
else. On continued failure, refuse with the credential named, and do not rewrite
the committed file.

## Step 6 — persist and hand off

`writeRcaContext`. On refusal, report the code and its next action; a
`secret-in-field` refusal also says to rotate the value that was pasted.

On success: name the path, and **tell them to commit and push it**. Without that
step the committed-file design delivers nothing over a local file and the teammate
inherits nothing. Then point at `/rca-build` for a red build.

## Hard rules

- Never ask for a field the capability table does not declare. The table is the
  question list.
- Never re-ask a skipped capability in the same session.
- GitHub is mandatory and the refusal is bounded — decline a skip, re-pose, and
  after three declines stop and write a partial.
- Never echo a pasted credential. Refuse, guide rotation, ask for the variable name.
- Never print raw probe output. Class plus next action.
- Every failure record names a next action.
- GitHub never persists as `unverified` — write a partial instead.
- A teammate is asked for credentials only, never the interview.
- Never point `hardenStateDir` at the context file. It is git-tracked.
- Every reference pointer is `pluginRoot`-qualified, never a bare `references/…`.
