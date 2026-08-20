# tfa-rca — generic multi-client RCA agent plugin

Drive BrowserStack's collaborative root-cause-analysis loop over **all failed
tests of a build**, generic across product and infra, from inside an agentic
MCP client (Claude Code / Cursor / Codex).

The plugin wraps three stable MCP tools — `listTestIds`, `tfaRcaTurn`, and
`triggerRcaReport` (from the `bstack` MCP server) — and adds the harness that
batches RCA over a whole build, groups failures by cause, routes evidence
requests to whatever skills/tools the client already has, and lands a per-test
RCA in the TRA (Test Observability) dashboard.

> **The full RCA report lives on the Test Observability UI, not in Claude.**
> The plugin surfaces a terse glimpse, triggers the dashboard report
> (`triggerRcaReport`), and prints the link. It **discovers and delegates** to
> the infra skills/tools already in your client (GitHub, whatever runtime you have — k8s/ECS/docker/… — kibana/other
> logs, metrics). It does **not** install or own those connectors, and it never
> writes a local report file.

## Install

```bash
git clone https://github.com/browserstack/browserstack-ai-tfa-demo.git
cd browserstack-ai-tfa-demo
cp .env.example .env   # fill in BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY
claude --plugin-dir ./
```

The plugin auto-configures on load: the `bstack` MCP server (from `.mcp.json`), the
`rca-build` skill, and the `ai-tfa-coordinator` agent are all discovered by
convention. (There is deliberately **no** command file named after the skill — a
command and skill sharing a name collide and the skill body fails to load.)

### Cursor & Codex

The MCP core (`listTestIds` + `tfaRcaTurn` + `triggerRcaReport`) and the
skill/agent layer port to both — Cursor uses `.cursor-plugin/plugin.json` +
`.cursor-mcp.json`, Codex uses `~/.codex/config.toml` (see
`codex-mcp.example.toml`). The only Claude-specific piece is the batch *dynamic
workflow*; on Cursor/Codex the same batch runs via subagents. Full per-host wiring (MCP config, skill/agent
discovery, deeplink) is in **[INTEGRATION.md](INTEGRATION.md)**.

## Usage

One skill. First run on a repo interviews you once; every run after that is quiet.

### Just run it

```
/rca-build <build-id>
```

With no setup context on disk, the run interviews you first — the setup phase is
part of this skill, not a separate thing to remember. It looks at what your machine
already has (a forge CLI, a runtime CLI, MCP servers in the session, connector
skills in the workspace), decides which capability each one serves, and then asks
only for the scope it cannot see: which repos are yours, which subpaths inside a
monorepo, which branch regression runs against, which namespace, which log index.
Every answer is verified with a live read before it is kept.

**Nothing in this plugin has a list of supported vendors.** No fingerprints, no
hint list, no probe commands — the model decides that a given CLI is your runtime
or that a given MCP server is your metrics, which is why a stack nobody here has
heard of works without a code change. GitHub is the one hard requirement: without
the code and the merged PRs there is no culprit PR to name, and that is the output.

Then **commit and push the context it writes**:Then **commit and push the context it writes**:

```bash
git add .rca-context.json && git commit -m "chore: add RCA setup context"
```

This step is the point of the file. It holds no credential values — only
environment-variable *names* — so it is safe to review in a PR, and a teammate who
clones the repo is asked for credentials and nothing else. Skip the commit and
every teammate does the whole interview again.

**GitHub is mandatory.** `gh` or a GitHub MCP server, and nothing else — without
the code changes and the PRs merged into the branch under test there is no culprit
PR to name, which is the entire output. Setup says so plainly and stops. Everything
else (app logs, pipeline/CI, infra runtime, metrics/APM) is optional and degrades
to a recorded gap that travels into the report.

Interrupted, or blocked on GitHub? Setup writes a **partial** context, so coming
back costs a re-verify rather than the whole interview.

**Headless (`claude -p`) does not interview.** It loads and validates an existing
context and fails fast when there is none — there is no synchronous human to
answer. A first context has to be produced interactively, on a developer machine,
and committed. A CI-only consumer cannot bootstrap one.

### 2. Run, per red build

```
/rca-build <build-id>
/rca-build build_id=<id> https://github.com/org/repo/pull/123
```

Args: a build id (bare, `build_id=`, or a dashboard link) plus optional PR URLs
/ repo hints. Copy the command straight from the AI Agents Report — the build id
is already in it.

The run refuses to start in three cases, before any analysis: no context is
resolvable, the context is present but unreadable (a merge conflict or a schema
mismatch — reported as *that*, never as "no context"), or GitHub is not verified in
it. Each names the file and the fix.

## The single gate

The run has exactly **one gate** before execution, with two parts:

1. **Connector discovery + validation** — every connector relevant to test RCA
   (github, infra, logs, metrics, …) is enumerated and probe-validated (`gh auth
   status`, an infra probe matching whatever runtime exists — kubectl/docker/ecs/… — MCP tools listed). The result is a validated
   capability manifest: `connector → valid | invalid | absent`. A gap is
   recorded and declared to the TFA agent ("I don't have logs/metrics access") —
   never a blocker.
2. **Requirements** — intake fields (product repo, automation repo, branches,
   PRs in play, build id) are resolved in a fixed precedence: **build metadata →
   invocation args → the persisted setup context → connector intake defaults
   → inference**. A field the context verified is used as given and is never
   re-asked, which is what makes the repeat loop quiet. At most **one**
   consolidated question may be asked at gate close, and only for a field no tier
   supplies. Headless (`claude -p`) never asks: a missing build id fails fast;
   everything else is a recorded gap.

**After the gate closes, the run never asks you anything again** — RCA
execution is fully autonomous. Evidence gaps degrade to "unavailable" back to
the TFA agent, which finalizes best-effort.

## Output

When every test is terminal, the run prints a **status count**, calls
`triggerRcaReport(buildUuid)`, and prints the link:

```
Full report on the Test Observability UI: <viewReport link>
```

That dashboard report — populated per-test by the BrowserStack agent, with
mandatory culprit-PR links on application bugs — is the real deliverable.

## Requirements

- The `bstack` MCP server (bundled via `.mcp.json`).
- Credentials in `.env` (or your client's MCP env).
- For full evidence coverage: whatever GitHub / infra / logging / metrics
  skills your client already has. Missing ones degrade gracefully (the RCA's
  confidence band reflects what evidence was actually available).

## Run

Point it at any red BrowserStack build — the harness discovers what it needs:

```
# BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY exported; default base is
# production, override O11Y_TFA_RCA_BASE_URL only for a staging tenant.
/rca-build <build-id>
```

The single gate validates connectors (github via `gh`, infra via whatever
runtime connector exists — kubectl/docker/ecs/…) and resolves the intake
**by inference** (product/automation repo from the cwd's git remote, branches,
any PRs you pass). It never assumes a product repo from unrelated workspace
docs — if it can't infer one that matches the failures, it records the gap and
proceeds RCA-only rather than blaming the wrong repo. Then it clusters the
failures, drives `tfaRcaTurn` per cluster, and lands per-test RCAs on the
dashboard, printing the glimpse + the Test Observability link.

## Layout

Implementation plan + requirements live under `docs/` (local, gitignored).
Cross-client wiring is in `INTEGRATION.md`.
