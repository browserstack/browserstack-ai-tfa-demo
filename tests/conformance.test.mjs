import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runRcaLoop, replaySubmit, replayRead } from "../lib/loop.mjs";

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

// Drain tests inject a no-op sleep so the 5s read interval costs no wall clock.
const noSleep = async () => {};

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

test("pending fixture: soft-PENDING with NO getTfaTurnResult tool → ends resumable, never resubmits", async () => {
  // Client lacks readTurn: the drain is impossible, so the old floor applies —
  // report it resumable rather than busy-waiting through tfaRcaTurn resubmits.
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
    sleep: noSleep,
  });
  assert.equal(result.status, "PENDING");
  assert.equal(result.turnId, "turn-81-1");
  assert.equal(result.threadId, "thr-81");
  assert.equal(calls, 1); // one submit, no resubmit
});

test("soft-PENDING is DRAINED via getTfaTurnResult before the next submit, not reported", async () => {
  // The real 3840238857 case: turn 1 finalized NEEDS_INFO at 104s, past the tool's
  // 90s in-call cap, so submit() handed back a soft PENDING. Reading the same
  // turnId lands the NEEDS_INFO the agent had already committed to.
  const fx = load("soft-pending-drain.json");
  const submits = [];
  const submit = replaySubmit(fx.turns);
  const read = replayRead(fx.reads);
  let reads = 0;
  const result = await runRcaLoop({
    testRunId: fx.testRunId,
    firstMessage: "Initiating collaborative RCA",
    submit: async (args) => {
      submits.push(args);
      return submit(args);
    },
    readTurn: async (args) => {
      reads++;
      return read(args);
    },
    config: CONFIG,
    manifest: GITHUB_AVAILABLE,
    gather,
    sleep: noSleep,
  });

  assert.equal(result.status, "RESOLVED");
  assert.equal(reads, 3); // PENDING, PENDING, then the landed NEEDS_INFO
  assert.equal(submits.length, 2); // turn 1, then the evidence turn — no submit mid-flight
  assert.equal(result.turns_used, 2); // 3 reads did NOT consume the turn cap
  assert.deepEqual(result.asks_fulfilled, ["product_code"]);
  assert.deepEqual(result.asks_skipped, ["test_logs"]); // TFA owns logs, even post-drain
  assert.match(result.root_cause, /#current-url/);
});

test("drain reads the SAME turnId, and stops resubmitting it once landed", async () => {
  const fx = load("soft-pending-drain.json");
  const readArgs = [];
  const submits = [];
  const submit = replaySubmit(fx.turns);
  const read = replayRead(fx.reads);
  await runRcaLoop({
    testRunId: fx.testRunId,
    submit: async (args) => {
      submits.push(args);
      return submit(args);
    },
    readTurn: async (args) => {
      readArgs.push(args);
      return read(args);
    },
    config: CONFIG,
    manifest: GITHUB_AVAILABLE,
    gather,
    sleep: noSleep,
  });
  // Every read targets the turnId the soft-PENDING handed back.
  for (const a of readArgs) {
    assert.equal(a.turnId, "c2e1a6fd-2243-4f93-bc69-62f298db062c");
    assert.equal(String(a.testRunId), "3840238857");
  }
  // The spent resume handle is dropped: the follow-up submit rides threadId only.
  assert.equal(submits[1].turnId, undefined);
  assert.equal(submits[1].threadId, "chat:3840238857");
});

test("drain budget is bounded: a wedged turn ends PENDING instead of hanging the batch", async () => {
  const fx = load("soft-pending-drain.json");
  let reads = 0;
  const result = await runRcaLoop({
    testRunId: fx.testRunId,
    submit: replaySubmit([fx.turns[0]]), // always soft-PENDING
    readTurn: async () => {
      reads++;
      return { status: "PENDING", turnId: "c2e1a6fd-2243-4f93-bc69-62f298db062c" };
    },
    config: { ...CONFIG, softPendingDrain: { maxWaitMs: 60_000, intervalMs: 1, maxReads: 4 } },
    sleep: noSleep,
  });
  assert.equal(result.status, "PENDING");
  assert.equal(reads, 4); // capped by maxReads, never unbounded
  assert.match(result.root_cause, /soft-pending: still working after 4 read\(s\)/);
  assert.equal(result.turnId, "c2e1a6fd-2243-4f93-bc69-62f298db062c"); // still resumable
});

test("a failed read is not a verdict — the drain keeps reading and still lands", async () => {
  const fx = load("soft-pending-drain.json");
  const landed = fx.reads[2];
  let reads = 0;
  const result = await runRcaLoop({
    testRunId: fx.testRunId,
    submit: replaySubmit(fx.turns),
    readTurn: async () => {
      reads++;
      if (reads === 1) throw new Error("transient 502 from o11y");
      return landed;
    },
    config: CONFIG,
    manifest: GITHUB_AVAILABLE,
    gather,
    sleep: noSleep,
  });
  assert.equal(result.status, "RESOLVED");
  assert.equal(reads, 2);
});

test("a PERSISTENT hard error stops the drain early instead of burning the budget", async () => {
  const fx = load("soft-pending-drain.json");
  let reads = 0;
  const result = await runRcaLoop({
    testRunId: fx.testRunId,
    submit: replaySubmit([fx.turns[0]]), // always soft-PENDING
    readTurn: async () => {
      reads++;
      throw new Error("Failed to get tfa turn result: TFA agent run failed");
    },
    // Budget allows 40 reads; the error cap must cut it off long before that.
    config: { ...CONFIG, softPendingDrain: { maxWaitMs: 600_000, intervalMs: 1, maxReads: 40, maxErrorReads: 3 } },
    sleep: noSleep,
  });
  assert.equal(result.status, "PENDING");
  assert.equal(reads, 3, "stopped at maxErrorReads, not the 40-read budget");
  assert.match(result.root_cause, /tfa-error/);
  assert.equal(result.turnId, "c2e1a6fd-2243-4f93-bc69-62f298db062c"); // still resumable
});

test("an error-shaped RESULT (not thrown) also trips the fast-fail", async () => {
  const fx = load("soft-pending-drain.json");
  let reads = 0;
  const result = await runRcaLoop({
    testRunId: fx.testRunId,
    submit: replaySubmit([fx.turns[0]]),
    // The MCP tool reports the wedge as a returned payload, not an exception.
    readTurn: async () => {
      reads++;
      return { status: "ERROR", message: "TFA agent run failed" };
    },
    config: { ...CONFIG, softPendingDrain: { maxWaitMs: 600_000, intervalMs: 1, maxReads: 40, maxErrorReads: 2 } },
    sleep: noSleep,
  });
  assert.equal(result.status, "PENDING");
  assert.equal(reads, 2);
  assert.match(result.root_cause, /tfa-error/);
});

test("INTERMITTENT errors do not trip the fast-fail — a good read clears the streak", async () => {
  const fx = load("soft-pending-drain.json");
  const landed = fx.reads[2];
  let reads = 0;
  const result = await runRcaLoop({
    testRunId: fx.testRunId,
    submit: replaySubmit(fx.turns),
    readTurn: async () => {
      reads++;
      // fail, ok, fail, ok, ... never 2 consecutive failures
      if (reads % 2 === 1) throw new Error("transient 502");
      return reads < 6 ? { status: "PENDING" } : landed;
    },
    config: { ...CONFIG, softPendingDrain: { maxWaitMs: 600_000, intervalMs: 1, maxReads: 40, maxErrorReads: 2 } },
    manifest: GITHUB_AVAILABLE,
    gather,
    sleep: noSleep,
  });
  assert.equal(result.status, "RESOLVED", "flaky-but-recovering reads must still land");
  assert.equal(reads, 6);
});

test("BLOCKED surfaced by a drain is terminal — no empty resubmits to the turn cap", async () => {
  const fx = load("soft-pending-drain.json");
  let submits = 0;
  const result = await runRcaLoop({
    testRunId: fx.testRunId,
    submit: async (args) => {
      submits++;
      return replaySubmit(fx.turns)(args);
    },
    readTurn: async () => ({ status: "BLOCKED", threadId: "chat:3840238857" }),
    config: CONFIG,
    sleep: noSleep,
  });
  assert.equal(result.status, "PENDING");
  assert.equal(result.root_cause, "blocked");
  assert.equal(submits, 1); // BLOCKED carries no asks; never resubmitted
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
