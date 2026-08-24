# tfa-rca — generic multi-client RCA agent plugin

Drive BrowserStack's collaborative root-cause-analysis loop over **all failed
tests of a build**, generic across product and infra, from inside an agentic
MCP client (Claude Code / Cursor / Codex).

The plugin wraps three stable MCP tools — `listTestIds`, `tfaRcaTurn`, and
`triggerRcaReport` (from the `bstack` MCP server) — and adds the harness that
batches RCA over a whole build, clusters failures by signature, routes evidence
requests to whatever skills/tools the client already has, and lands a per-test
RCA in the TRA (Test Observability) dashboard.

> **The full RCA report lives on the Test Observability UI, not in Claude.**
> The plugin surfaces a terse glimpse, triggers the dashboard report
> (`triggerRcaReport`), and prints the link. It **learns and delegates**: the setup
> interview records which of your own tools serves each capability — code, runtime,
> logs, metrics, CI — and every run after that uses them. It does **not** install or
> own those connectors, ship a list of supported ones, or write a local report file.

## Install

```bash
git clone https://github.com/browserstack/browserstack-ai-tfa-demo.git
cd browserstack-ai-tfa-demo
cp .env.example .env   # fill in BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY
claude --plugin-dir ./
```

The plugin auto-configures on load: the `bstack` MCP server (from `.mcp.json`),
the `rca-build` skill, and the `ai-tfa-coordinator` agent are all discovered by
convention. (There is deliberately **no** command file named `rca-build` — a
command and skill sharing a name collide and the skill body fails to load.)

### Cursor & Codex

The MCP core (`listTestIds` + `tfaRcaTurn` + `triggerRcaReport`) and the
skill/agent layer port to both — Cursor uses `.cursor-plugin/plugin.json` +
`.cursor-mcp.json`, Codex uses `~/.codex/config.toml` (see
`codex-mcp.example.toml`). The only Claude-specific piece is the batch *dynamic
workflow*; on Cursor/Codex the same batch runs via subagents or the sequential
harness (`lib/loop.mjs`). Full per-host wiring (MCP config, skill/agent
discovery, deeplink) is in **[INTEGRATION.md](INTEGRATION.md)**.

## Usage

```
/rca-build <build-id>
/rca-build build_id=<id> https://github.com/org/repo/pull/123
```

Args: a build id (bare, `build_id=`, or a dashboard link) plus optional PR URLs
/ repo hints.

## First contact, then the single gate

**The first time you run this in a repo, it interviews you.** It says what
BrowserStack already has versus what only you can supply, then walks capability by
capability — GitHub first, then your application logs, CI, whatever runs your
services, your metrics — asking only for the scope it cannot see and **verifying
every answer with a live read** before keeping it. The result is committed to
`.rca-context.json`, so a teammate who clones the repo inherits it and is asked only
for credentials.

**GitHub is the one hard requirement.** Without the code and the PRs merged into the
branch under test there is no culprit PR to name, and that is the deliverable — so
setup blocks there and says so. Everything else is suggested, never forced: skip it
and it becomes a recorded gap that shows up in the report.

Nothing here ships a list of supported vendors. No fingerprints, no probe table: the
model works out that a given CLI is your runtime or that a given MCP server is your
metrics, which is why a stack nobody here has heard of works with no code change.

**Every run after that has exactly one gate**, with two parts:

1. **Capability validation** — each capability the context recorded is re-verified
   by replaying the read that proved it, all in one batch, into a manifest:
   `capability → valid | invalid | absent`. An unverifiable GitHub refuses the run.
   Anything else is a recorded gap, declared to the TFA agent ("I don't have
   logs/metrics access") — never a blocker.
2. **Intake** — product repo, automation repo, branches, PRs in play, build id,
   resolved in a fixed precedence: build metadata → invocation args → the persisted
   profile → connector defaults → inference. At most **one** consolidated question
   at gate close, and only for a field that is both non-assumable and load-bearing.

**After the gate closes, the run never asks you anything again** — RCA
execution is fully autonomous. Evidence gaps degrade to "unavailable" back to
the TFA agent, which finalizes best-effort.

## Output

When every test is terminal, the run prints a terse **glimpse table**
(`testRunId → cluster → status → confidence one-liner`), calls
`triggerRcaReport(buildUuid)`, and prints:

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

The gate re-validates the capabilities your context recorded and resolves the
intake, preferring the build's own metadata and your committed profile over
inference. It never assumes a product repo from unrelated workspace
docs — if it can't infer one that matches the failures, it records the gap and
proceeds RCA-only rather than blaming the wrong repo. Then it clusters the
failures, drives `tfaRcaTurn` per cluster, and lands per-test RCAs on the
dashboard, printing the glimpse + the Test Observability link.

## Layout

Implementation plan + requirements live under `docs/` (local, gitignored).
Cross-client wiring is in `INTEGRATION.md`.
