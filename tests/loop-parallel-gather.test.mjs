import { test } from "node:test";
import assert from "node:assert/strict";
import { runRcaLoop } from "../lib/loop.mjs";

// A NEEDS_INFO turn's independent asks (lib/routing.mjs's routeAsk/routeAsks
// have no cross-ask state) should be gathered concurrently, not one round-trip
// at a time. This file proves both properties of that fix: the calls actually
// overlap, and the final message still assembles blocks in priority order
// regardless of which one finishes first.

const CONFIG = {
  turnCap: 6,
  evidenceRouting: {
    test_logs: { owner: "tfa", skip: true },
    product_code: { capability: "github" },
    infra: { capability: "infra" },
    other: { capability: "other" },
  },
};
const MANIFEST = {
  github: { available: true, via: "gh" },
  infra: { available: true, via: "kubectl" },
};
const resolved = (threadId) => ({
  status: "RESOLVED",
  threadId,
  confidence: "high",
  glimpse: { root_cause: "r", failure_type: "f", related_prs: [] },
  viewRca: "https://automation.browserstack.com/x",
});
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test("independent NEEDS_INFO gathers run concurrently, not sequentially", async () => {
  const events = [];
  const gather = async (g) => {
    events.push(`start:${g.evidenceType}`);
    // The slower ask (product_code) is listed FIRST but finishes LAST. If
    // gathers were sequential, infra's "start" could never appear before
    // product_code's "end".
    await delay(g.evidenceType === "product_code" ? 30 : 5);
    events.push(`end:${g.evidenceType}`);
    return `BLOCK:${g.evidenceType}`;
  };

  let calls = 0;
  const submit = async () => {
    calls++;
    if (calls === 1) {
      return {
        status: "NEEDS_INFO",
        threadId: "chat:1",
        asks: [
          { evidenceType: "product_code", priority: "high", ask: { what: "diff" } },
          { evidenceType: "infra", priority: "medium", ask: { what: "pod status" } },
        ],
      };
    }
    return resolved("chat:1");
  };

  await runRcaLoop({
    testRunId: "1",
    firstMessage: "start",
    submit,
    config: CONFIG,
    manifest: MANIFEST,
    gather,
  });

  const firstEnd = events.findIndex((e) => e.startsWith("end:"));
  const startsBeforeFirstEnd = events.slice(0, firstEnd).filter((e) => e.startsWith("start:"));
  assert.equal(
    startsBeforeFirstEnd.length,
    2,
    `expected both gathers to start before either finished, got: ${events.join(", ")}`,
  );
});

test("gathered blocks preserve priority order in the message even when the slower ask finishes first", async () => {
  const gather = async (g) => {
    await delay(g.evidenceType === "product_code" ? 30 : 5);
    return `BLOCK:${g.evidenceType}`;
  };

  let calls = 0;
  const submits = [];
  const submit = async (args) => {
    calls++;
    submits.push(args);
    if (calls === 1) {
      return {
        status: "NEEDS_INFO",
        threadId: "chat:2",
        // Listed low-priority-first on purpose — the message must still put
        // high-priority product_code ahead of low-priority infra.
        asks: [
          { evidenceType: "infra", priority: "low", ask: { what: "pod status" } },
          { evidenceType: "product_code", priority: "high", ask: { what: "diff" } },
        ],
      };
    }
    return resolved("chat:2");
  };

  await runRcaLoop({
    testRunId: "2",
    firstMessage: "start",
    submit,
    config: CONFIG,
    manifest: MANIFEST,
    gather,
  });

  assert.equal(
    submits[1].message,
    "BLOCK:product_code\n\nBLOCK:infra",
    "high-priority product_code must precede low-priority infra regardless of which gather resolved first",
  );
});

test("gap blocks still follow every gathered block, unaffected by concurrency", async () => {
  const gather = async (g) => `BLOCK:${g.evidenceType}`;

  let calls = 0;
  const submits = [];
  const submit = async (args) => {
    calls++;
    submits.push(args);
    if (calls === 1) {
      return {
        status: "NEEDS_INFO",
        threadId: "chat:3",
        asks: [
          { evidenceType: "product_code", priority: "high", ask: { what: "diff" } },
          { evidenceType: "metrics", priority: "low", ask: { what: "latency" } }, // no capability -> gap
        ],
      };
    }
    return resolved("chat:3");
  };

  const result = await runRcaLoop({
    testRunId: "3",
    firstMessage: "start",
    submit,
    config: CONFIG,
    manifest: MANIFEST,
    gather,
  });

  assert.match(submits[1].message, /^BLOCK:product_code\n\nASK:/);
  assert.deepEqual(result.asks_fulfilled, ["product_code"]);
  assert.deepEqual(result.asks_unavailable, ["metrics"]);
});
