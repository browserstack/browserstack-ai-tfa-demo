#!/usr/bin/env node
// Memo cache for READ-ONLY **MCP** tool calls, sharing the same per-build
// store as `cached-exec.mjs`.
//
// Usage:
//   1. get   → node bin/cached-mcp.mjs <buildId> get <tool> '<argsJson>'
//   2. put   → node bin/cached-mcp.mjs <buildId> put <tool> '<argsJson>' <writerId>   # payload on stdin
//   3. list  → node bin/cached-mcp.mjs <buildId> list
//   4. stats → node bin/cached-mcp.mjs <buildId> stats
//
// Never cacheable (refused): `tfaRcaTurn`, `getTfaTurnResult`,
// `triggerRcaReport`. Those are stateful.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  toolCacheDirFor, mcpCacheKey, cacheGet, cachePut, cacheStats, isCacheableMcp, banner,
} from "../lib/tool-cache.mjs";

const logPath = process.env.TOOLCACHE_LOG ?? "";
const [, , buildId, verb, tool, argsJson, writerId] = process.argv;

if (!buildId || !verb) {
  console.error("usage: cached-mcp.mjs <buildId> get <tool> '<argsJson>'");
  console.error("       cached-mcp.mjs <buildId> put <tool> '<argsJson>' <writerId>   # payload on stdin");
  console.error("       cached-mcp.mjs <buildId> list");
  console.error("       cached-mcp.mjs <buildId> stats");
  process.exit(2);
}

const dir = toolCacheDirFor(buildId, process.env.RCA_STATE_DIR ?? "");

if (verb === "stats") {
  console.log(JSON.stringify({ cacheDir: dir, ...cacheStats(dir) }, null, 2));
  process.exit(0);
}

if (verb === "list") {
  if (!existsSync(dir)) { console.log("(no cache yet)"); process.exit(0); }
  let n = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    let e; try { e = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    if (!/^mcp__/.test(e.command ?? "")) continue;
    n++;
    const sp = e.command.indexOf(" ");
    console.log(`\n[${e.key}] ${e.command.slice(0, sp)}  (by ${e.writerId ?? "?"}, ${e.bytes}B)`);
    console.log(`  args: ${e.command.slice(sp + 1)}`);
    console.log(`  digest: ${String(e.stdout).replace(/\s+/g, " ").slice(0, 150)}…`);
  }
  if (!n) console.log("(no MCP entries cached)");
  process.exit(0);
}

if (!tool || argsJson === undefined) {
  console.error("both <tool> and '<argsJson>' are required");
  process.exit(2);
}

if (!isCacheableMcp(tool)) {
  console.error(`[mcp-cache REFUSED] ${tool} is stateful — never cache it; call it directly.`);
  process.exit(2);
}

let args;
try { args = JSON.parse(argsJson); } catch (err) {
  console.error(`[mcp-cache] argsJson is not valid JSON: ${err.message}`);
  process.exit(2);
}

const key = mcpCacheKey(tool, args);

if (verb === "get") {
  const hit = cacheGet(dir, key);
  if (!hit) {
    banner(`[mcp-cache MISS ${key} ${tool}] — make the MCP call, then 'put' the digest`, logPath);
    process.exit(1);
  }
  banner(`[mcp-cache HIT ${key} ${tool} — captured by ${hit.writerId ?? "?"}, ${hit.bytes}B]`, logPath);
  process.stdout.write(hit.stdout);
  process.exit(0);
}

if (verb === "put") {
  let payload = "";
  try { payload = readFileSync(0, "utf8"); } catch { payload = ""; }
  if (!payload.trim()) {
    console.error("[mcp-cache] refusing to store an empty payload");
    process.exit(2);
  }
  const rec = cachePut(dir, key, { command: `${tool} ${argsJson}`, writerId, stdout: payload }, Date.now());
  banner(`[mcp-cache STORED ${key} ${tool} — ${rec.bytes}B]`, logPath);
  process.exit(0);
}

console.error(`unknown verb: ${verb}`);
process.exit(2);
