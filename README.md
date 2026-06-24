# tfa-rca — generic multi-client RCA agent plugin

Drive BrowserStack's collaborative root-cause-analysis loop over **all failed
tests of a build**, generic across product and infra, from inside an agentic
MCP client (Claude Code / Cursor / Codex).

The plugin wraps two stable MCP tools — `listTestIds` and `tfaRcaTurn` (from the
`bstack` MCP server) — and adds the harness that batches RCA over a whole build,
clusters failures by signature, routes evidence requests to whatever
skills/tools the client already has, and writes a per-test RCA into the TRA
dashboard.

> It **discovers and delegates** to the infra skills/tools already in your
> client (GitHub, k8s/EKS, kibana/other logs, metrics). It does **not** install
> or own those connectors.

## Install

```bash
git clone https://github.com/browserstack/browserstack-ai-tfa-demo.git
cd browserstack-ai-tfa-demo
cp .env.example .env   # fill in BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY
claude --plugin-dir ./
```

The plugin auto-configures on load: the `bstack` MCP server (from `.mcp.json`),
the `/rca-build` command, the `rca-build` skill, and the `ai-tfa-coordinator`
agent are all discovered by convention.

### Cursor & Codex

The MCP core (`listTestIds` + `tfaRcaTurn`) and the skill/agent layer port to
both — Cursor uses `.cursor-plugin/plugin.json` + `.cursor-mcp.json`, Codex uses
`~/.codex/config.toml` (see `codex-mcp.example.toml`). The only Claude-specific
piece is the auto-mode *dynamic workflow*; on Cursor/Codex the same batch runs via
interactive subagents or the sequential harness (`lib/loop.mjs`). Full
per-host wiring (MCP config, skill/agent discovery, deeplink) is in
**[INTEGRATION.md](INTEGRATION.md)**.

## Usage

```
/rca-build <build-id>
/rca-build build_id=<id> mode=auto
```

On start the plugin runs a **mandatory pre-flight intake** asking for your
product + automation repos, working branch, default branch, and the PRs in
play, plus the build id. Every question is answerable with "I don't have one" →
the run proceeds RCA-only.

## Modes

- **auto** — a dynamic workflow drives the whole batch (5 tests concurrent), no
  mid-run prompts. When evidence can't be gathered (no matching skill), it
  reports "unavailable" back to the TFA agent, which finalizes best-effort.
- **interactive** — the main session spawns subagents (5 at a time); on an
  evidence gap a subagent returns the gap to the main agent, which asks you,
  then feeds the answer back.

`auto` means autonomy *during* the batch from an interactive session — not
headless. Running `claude -p` with a required input missing ends immediately.

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
2. **k8s evidence harness** — `skills/k8s-rengg-tfa/` + `bin/k8s-context.sh`
   provide the `k8s` capability: read-only obs-api context (pod health, deployed
   image, error logs, events) from the `rengg-tfa` namespace, secrets redacted.
3. **Run** — with `BROWSERSTACK_USERNAME`/`ACCESS_KEY` exported and `kubectl`
   pointed at the staging cluster:
   ```
   /rca-build awswxm0t5ve7vbjnspfna4xbvjwxn92u2lwv5fw2 mode=interactive
   ```
   The harness clusters the failures, drives `tfaRcaTurn` per cluster, and routes
   `k8s` asks to the `k8s-rengg-tfa` skill while `product_code`/`deploy` asks go to
   GitHub — landing per-test RCAs that trace back to the seeded regressions.

## Layout

Implementation plan + requirements live under `docs/` (local, gitignored).
Cross-client wiring is in `INTEGRATION.md`.
