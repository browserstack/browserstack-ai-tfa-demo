---
name: rca-setup
description: One-time setup conversation for the RCA plugin. Discovers what this machine already has (executables, MCP servers, repo fingerprints), interviews only for the scope discovery cannot resolve, verifies every capability with a live read, confirms at a single gate, and persists a commit-safe context the run skill consumes. GitHub via gh or a GitHub MCP server is mandatory; everything else degrades to a recorded gap. Args: none — run it once per repo.
---

# rca-setup — the one-time setup conversation

> **Status: skeleton.** This body is filled in by U5 of
> `docs/plans/2026-08-20-001-feat-rca-setup-skill-and-discovery-engine-plan.md`. U6 creates the file
> so U1–U4 have a mandated-reading target to document their `lib/` exports in; the interview
> procedure itself does not exist yet.

## Mandated reading

Files this skill's flow requires loading. The per-skill API guard in `tests/wiring.test.mjs` asserts
that every `lib/` export this skill drives is documented across this set, and the prose-budget check
measures this set plus this body. Paths are `pluginRoot`-qualified because a subagent starts in an
unknown cwd.

- `<pluginRoot>/skills/rca-setup/references/api-reference.md`
