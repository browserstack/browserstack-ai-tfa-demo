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

## The single gate

The run has exactly **one gate** before execution, with two parts:

1. **Connector discovery + validation** — every connector relevant to test RCA
   (github, infra, logs, metrics, …) is enumerated and probe-validated (`gh auth
   status`, an infra probe matching whatever runtime exists — kubectl/docker/ecs/… — MCP tools listed). The result is a validated
   capability manifest: `connector → valid | invalid | absent`. A gap is
   recorded and declared to the TFA agent ("I don't have logs/metrics access") —
   never a blocker.
2. **Requirements** — intake fields (product repo, automation repo, branches,
   PRs in play, build id) are resolved **by assumption** wherever possible
   (invocation args, `gh repo view`, current branch). At most **one**
   consolidated question may be asked at gate close, and only for genuinely
   non-assumable, load-bearing fields. Headless (`claude -p`) never asks: a
   missing build id fails fast; everything else is a recorded gap.

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

## Demo run (rengg-tfa)

A seeded failing build exercises the full loop against real staging infra:

1. **Seed the build** — `automation/` holds failing API cases for the rcaChat /
   `is_mcp_driven` feature and `upload.sh` to push them. The current seeded build:
   `awswxm0t5ve7vbjnspfna4xbvjwxn92u2lwv5fw2` (project "RCA Feature Fencing",
   build "VRT Build"). See `automation/README.md`.
   provide the `infra` capability: read-only runtime context (pod/instance health, deployed
   image, error logs, events) from the `rengg-tfa` namespace, secrets redacted.
3. **Run** — with `BROWSERSTACK_USERNAME`/`ACCESS_KEY` exported and `kubectl`
   pointed at the staging cluster:
   ```
   /rca-build awswxm0t5ve7vbjnspfna4xbvjwxn92u2lwv5fw2
   ```
   The gate validates connectors (github via `gh`, infra via whatever runtime connector exists (kubectl/docker/ecs/…)
   skill), then the harness clusters the failures, drives `tfaRcaTurn` per
   cluster, routes `infra`/`k8s` asks to it while `product_code`/`deploy` asks go
   to GitHub — landing per-test RCAs on the dashboard that trace back to the
   seeded regressions, then prints the glimpse + the Test Observability link.

## Layout

Implementation plan + requirements live under `docs/` (local, gitignored).
Cross-client wiring is in `INTEGRATION.md`.
