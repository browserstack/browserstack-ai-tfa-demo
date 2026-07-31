#!/usr/bin/env node
// Memo cache for READ-ONLY **MCP** tool calls, sharing the same per-build
// store as `cached-exec.mjs`.
//
// Shell calls can be wrapped transparently (`cached-exec.mjs` runs the command
// for you). MCP calls cannot — only the agent can invoke an MCP tool — so the
// contract here is check-then-call:
//
//   1. get   → node bin/cached-mcp.mjs <buildId> get <tool> '<argsJson>'
//              exit 0 + result on stdout  = HIT, skip the MCP call entirely
//              exit 1, empty stdout       = MISS, make the MCP call yourself
//   2. put   → node bin/cached-mcp.mjs <buildId> put <tool> '<argsJson>' <writerId>
//              (payload on STDIN — pipe the digest you want shared)
//
// WHEN THIS PAYS OFF, and when it does not. A hit replaces one MCP call with
// one cheap local read, so it wins on latency and on tokens whenever the
// cached payload is a digest smaller than the raw response. A miss costs two
// extra calls (the probe + the store), so this is worth it for **expensive,
// broadly-reusable, build-level queries** — a VictoriaLogs sweep, a
// `listTestIds`, a `getFailureLogs` several coordinators would each re-run —
// and NOT worth it for a one-off lookup only this test will ever need.
//
// Never cacheable (refused): `tfaRcaTurn`, `getTfaTurnResult`,
// `triggerRcaReport`. Those are stateful — a turn's status is *expected* to
// change between reads, so serving one from cache is wrong, not just stale.
// Prefer storing a DIGEST rather than a raw payload: the point is to spare the
// next reader the raw rows, not to relay them.

import { readFileSync } from "node:fs";
import {
  toolCacheDirFor, mcpCacheKey, cacheGet, cachePut, cacheStats, isCacheableMcp,
} from "../lib/tool-cache.mjs";

const [, , buildId, verb, tool, argsJson, writerId] = process.argv;

if (!buildId || !verb) {
  console.error("usage: cached-mcp.mjs <buildId> get <tool> '<argsJson>'");
  console.error("       cached-mcp.mjs <buildId> put <tool> '<argsJson>' <writerId>   # payload on stdin");
  console.error("       cached-mcp.mjs <buildId> stats");
  process.exit(2);
}

const dir = toolCacheDirFor(buildId, process.env.RCA_STATE_DIR ?? "");

if (verb === "stats") {
  console.log(JSON.stringify({ cacheDir: dir, ...cacheStats(dir) }, null, 2));
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
try {
  args = JSON.parse(argsJson);
} catch (err) {
  console.error(`[mcp-cache] argsJson is not valid JSON: ${err.message}`);
  process.exit(2);
}

const key = mcpCacheKey(tool, args);

if (verb === "get") {
  const hit = cacheGet(dir, key);
  if (!hit) {
    console.error(`[mcp-cache MISS ${key} ${tool}] — make the MCP call, then 'put' the digest`);
    process.exit(1);
  }
  console.error(`[mcp-cache HIT ${key} ${tool} — captured by ${hit.writerId ?? "?"}, ${hit.bytes}B]`);
  process.stdout.write(hit.stdout);
  process.exit(0);
}

if (verb === "put") {
  let payload = "";
  try {
    payload = readFileSync(0, "utf8"); // stdin
  } catch {
    payload = "";
  }
  if (!payload.trim()) {
    console.error("[mcp-cache] refusing to store an empty payload");
    process.exit(2);
  }
  const rec = cachePut(dir, key, { command: `${tool} ${argsJson}`, writerId, stdout: payload }, Date.now());
  console.error(`[mcp-cache STORED ${key} ${tool} — ${rec.bytes}B]`);
  process.exit(0);
}

console.error(`unknown verb: ${verb}`);
process.exit(2);
