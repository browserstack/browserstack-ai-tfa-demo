import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runRcaLoop, replaySubmit } from "../lib/loop.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const load = (name) =>
  JSON.parse(readFileSync(join(here, "fixtures", "recorded-turns", name), "utf8"));

const CONFIG = {
  turnCap: 6,
  evidenceRouting: {
    test_logs: { owner: "tfa", skip: true },
    product_code: { capability: "github" },
    other: { capability: "other" },
  },
};
const GITHUB_AVAILABLE = { github: { available: true, via: "gh" } };

// A coordinator gather() stub: returns a one-line digest block.
const gather = async (g) => `ASK: ${g.ask.what}\nTYPE: ${g.evidenceType}\nFOUND: yes\nSUMMARY: stub`;

test("resolved fixture: NEEDS_INFO → evidence → RESOLVED, trimmed glimpse captured, test_logs skipped", async () => {
  const fx = load("resolved.json");
  const result = await runRcaLoop({
    testRunId: fx.testRunId,
    firstMessage: "Error: empty buildName",
    submit: replaySubmit(fx.turns),
    config: CONFIG,
    manifest: GITHUB_AVAILABLE,
    gather,
  });
  assert.equal(result.status, "RESOLVED");
  assert.match(result.root_cause, /#7421/);
  assert.ok(result.root_cause.length <= 220); // glimpse root_cause is trimmed server-side
  assert.equal(result.failure_type, "product_regression");
  assert.deepEqual(result.related_prs, ["#7421"]);
  assert.match(result.view_rca, /^https:\/\/automation\.browserstack\.com/);
  assert.deepEqual(result.asks_fulfilled, ["product_code"]);
  assert.deepEqual(result.asks_skipped, ["test_logs"]); // TFA-owned, never gathered
  assert.equal(result.turns_used, 2);
  assert.equal(result.threadId, "thr-39");
});

test("pending fixture: soft-PENDING (trimmed: status/threadId/turnId) ends with turnId, no re-poll", async () => {
  const fx = load("pending.json");
  let calls = 0;
  const counting = async (args) => {
    calls++;
    return replaySubmit(fx.turns)(args);
  };
  const result = await runRcaLoop({
    testRunId: fx.testRunId,
    submit: counting,
    config: CONFIG,
  });
  assert.equal(result.status, "PENDING");
  assert.equal(result.turnId, "turn-81-1");
  assert.equal(result.threadId, "thr-81");
  assert.equal(calls, 1); // ended immediately, did not poll again
});

test("turn-cap fixture: ends PENDING(turn-cap) at the cap, never a 7th submit", async () => {
  const fx = load("turn-cap.json");
  let submits = 0;
  const counting = async (args) => {
    submits++;
    return replaySubmit(fx.turns)(args);
  };
  const result = await runRcaLoop({
    testRunId: fx.testRunId,
    submit: counting,
    config: CONFIG,
    manifest: GITHUB_AVAILABLE,
    gather,
  });
  assert.equal(result.status, "PENDING");
  assert.equal(result.root_cause, "turn-cap");
  assert.equal(submits, 6); // capped at turnCap, never 7
});

test("degraded path: no connector → gap degrades to unavailable (never a prompt), still terminal", async () => {
  // Same resolved fixture, but the client has NO github connector. The loop is
  // autonomous: the gap becomes an `unavailable` block and it still RESOLVEs.
  const fx = load("resolved.json");
  const result = await runRcaLoop({
    testRunId: fx.testRunId,
    submit: replaySubmit(fx.turns),
    config: CONFIG,
    manifest: {}, // nothing valid at the gate
  });
  assert.equal(result.status, "RESOLVED");
  assert.deepEqual(result.asks_unavailable, ["product_code"]);
  assert.deepEqual(result.asks_fulfilled, []);
});

test("unavailable block names the missing connector in the resubmitted message", async () => {
  const fx = load("resolved.json");
  const messages = [];
  const recording = (inner) => async (args) => {
    messages.push(args.message);
    return inner(args);
  };
  await runRcaLoop({
    testRunId: fx.testRunId,
    submit: recording(replaySubmit(fx.turns)),
    config: CONFIG,
    manifest: {},
  });
  assert.match(messages[1], /unavailable — no github connector/);
});

test("no testRunId → failed block, tool never called", async () => {
  let called = false;
  const result = await runRcaLoop({
    testRunId: undefined,
    submit: async () => {
      called = true;
      return {};
    },
    config: CONFIG,
  });
  assert.equal(result.status, "failed");
  assert.equal(called, false);
});
