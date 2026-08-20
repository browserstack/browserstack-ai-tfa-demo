# Multi-client integration (Claude Code · Cursor · Codex)

This plugin is built so the **MCP core is truly cross-client** and the **harness
layer ports via the cross-vendor Agent Skills standard**. Only one piece is
genuinely Claude-Code-specific (the batch *dynamic workflow*); on Cursor and
Codex that role is filled by the sequential harness or subagents. Every path is
autonomous after the single `/rca-build` gate — no host ever prompts mid-run.
Setup (`/rca-setup`) is the one interactive surface, and it runs once per repo
rather than per build.

## What transfers, what doesn't

| Layer | Claude Code | Cursor | Codex |
|---|---|---|---|
| `bstack` MCP server (`listTestIds` + `tfaRcaTurn` + `triggerRcaReport`) | `.mcp.json` (auto-discovered) | `.cursor-mcp.json` / `.cursor/mcp.json` | `~/.codex/config.toml` `[mcp_servers.bstack]` |
| `rca-build` skill (`SKILL.md`) | plugin `skills/` | Agent Skills (`.cursor/skills/` or cursor-plugin `"skills":"./skills/"`) | Agent Skills (`.agents/skills/`) |
| `rca-setup` skill (`SKILL.md`) | plugin `skills/` (same directory — no packaging change) | same | same |
| Committed setup context (`.rca-context.json`) | portable — a plain file in your repo | same | same |
| Connector-skill pre-fill during setup | reads `.claude/skills/` (4 paths) | **not yet** — Cursor reads `.cursor/skills/` | **not yet** — Codex reads `.agents/skills/` |
| `ai-tfa-coordinator` agent | plugin `agents/` | `.cursor/agents/` (also reads `.claude/agents/`) | `.codex/agents/` |
| Per-test RCA **loop** | `agents/ai-tfa-coordinator.md` | same skill/agent | same skill/agent |
| Batch orchestration | dynamic workflow `workflows/rca-batch.mjs` (or subagents) | subagents | subagents |

The dynamic workflow (`workflows/rca-batch.mjs`) uses Claude Code's Workflow
runtime, which Cursor/Codex don't have. The same batch still runs there via
**subagents**, which both hosts support. There is no separate sequential harness:
one existed as an executable mirror of the coordinator's loop and was deleted —
283 lines plus 582 of tests, driven by nothing, proving the mirror matched the
prose rather than that an agent did. The loop contract lives in
`agents/ai-tfa-coordinator.md`, which every host reads.
On every host the run finishes the same way: a status count →
`triggerRcaReport(buildUuid)` → "Full report on the Test Observability UI:
<viewReport>". No local report file is ever written.

## Claude Code

```bash
cp .env.example .env   # BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY
claude --plugin-dir ./
/rca-build <build-id>
```

`.claude-plugin/plugin.json` + root `.mcp.json` + `skills/` + `agents/` are
auto-discovered. (No `commands/rca-build.md` on purpose — a command and skill
with the same name collide and the skill body fails to load.)

## Cursor

The repo ships Cursor parity files mirroring `slack-mcp-plugin`:
`.cursor-plugin/plugin.json` (points at `../.cursor-mcp.json` and `./skills/`)
and `.cursor-mcp.json` (the stdio `bstack` server).

**Wire the MCP server** — either:
- copy `.cursor-mcp.json`'s `bstack` entry into your project `.cursor/mcp.json`
  (top-level `mcpServers`), or
- Cursor → Settings → Cursor Settings → **MCP** → paste the same JSON, or
- use an **Add to Cursor** deeplink:
  `cursor://anysphere.cursor-deeplink/mcp/install?name=bstack&config=<base64-of-the-bstack-entry-body>`

Set `BROWSERSTACK_USERNAME` / `BROWSERSTACK_ACCESS_KEY` / `O11Y_TFA_RCA_BASE_URL`
in your environment (or replace the `${…}` placeholders with literals).

**Skill + agent discovery** — Cursor reads `.cursor/skills/` and `.cursor/agents/`
(and also `.claude/agents/`). The simplest no-duplication setup is to symlink the
shared trees:

```bash
mkdir -p .cursor
ln -s ../skills  .cursor/skills
ln -s ../agents  .cursor/agents
```

Then drive it from Agent chat: invoke the `rca-build` skill with a build id.

## Codex

Codex reads the global `~/.codex/config.toml` (no per-project MCP file).

**Wire the MCP server** — either copy the block from `codex-mcp.example.toml`
into `~/.codex/config.toml`, or:

```bash
codex mcp add bstack \
  --env BROWSERSTACK_USERNAME=… --env BROWSERSTACK_ACCESS_KEY=… \
  --env O11Y_TFA_RCA_BASE_URL=https://api-observability-rengg-tfa.bsstag.com \
  -- npx -y @browserstack/mcp-server@1.2.27-beta.1
```

**Skill + agent discovery** — Codex reads `.agents/skills/` (skills) and
`.codex/agents/` (subagents). Symlink the shared trees:

```bash
mkdir -p .agents .codex
ln -s ../skills  .agents/skills
ln -s ../agents  .codex/agents
```

Then run the `rca-build` skill; the coordinator + `tfaRcaTurn` loop are identical.

## Notes

- The `bstack` server is **stdio** (`npx @browserstack/mcp-server@1.2.27-beta.1`), not a remote
  OAuth server — so the configs use `command`/`args`/`env`, unlike Slack's
  `url`+`oauth`/`auth` shape.
- Env-var interpolation (`${VAR}`) is honored by Claude Code's `.mcp.json`; on
  Cursor/Codex, replace the placeholders with literals if your client doesn't
  expand them.
- Everything in `lib/` and the `SKILL.md`/agent prose is host-agnostic — only the
  MCP wiring file and the dynamic workflow are host-specific.
