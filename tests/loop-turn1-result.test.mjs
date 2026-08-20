import { test } from "node:test";
import assert from "node:assert/strict";
import { runRcaLoop } from "../lib/loop.mjs";

// Step 4b (SKILL.md Step 4b) pre-submits turn 1 for a cluster representative,
// concurrently with Step 4's evidence pre-fetch. When it lands NEEDS_INFO,
// `turn1Result` carries that thread + those asks in so the loop never
// resubmits turn 1 — this file is the conformance coverage for that skip-ahead
// path, mirroring tests/conformance.test.mjs's fixture style but inline since
// there's nothing to replay: turn 1 already happened before runRcaLoop starts.

const CONFIG = {
  turnCap: 6,
  evidenceRouting: {
    test_logs: { owner: "tfa", skip: true },
    product_code: { capability: "github" },
    other: { capability: "other" },
  },
};
const GITHUB_AVAILABLE = { github: { available: true, via: "gh" } };
const gather = async (g) => `ASK: ${g.ask.what}\nTYPE: ${g.evidenceType}\nFOUND: yes\nSUMMARY: stub`;

test("turn1Result: never resubmits turn 1, starts at ROUTE, turns_used counts the pre-dispatched turn", async () => {
  const submits = [];
  // The only submit() call the loop makes is the FOLLOW-UP — turn 1 already
  // happened in Step 4b and is represented purely by `turn1Result`.
  const submit = async (args) => {
    submits.push(args);
    return {
      status: "RESOLVED",
      threadId: "chat:99",
      confidence: "high",
      glimpse: { root_cause: "root cause found", failure_type: "product_regression", related_prs: ["#1"] },
      viewRca: "https://automation.browserstack.com/x",
    };
  };

  const result = await runRcaLoop({
    testRunId: "99",
    submit,
    config: CONFIG,
    manifest: GITHUB_AVAILABLE,
    gather,
    turn1Result: { threadId: "chat:99", asks: [{ evidenceType: "product_code", ask: { what: "diff" } }] },
  });

  assert.equal(submits.length, 1, "turn 1 must never be submitted — only the follow-up");
  assert.equal(submits[0].threadId, "chat:99", "the follow-up reuses Step 4b's thread");
  assert.equal(submits[0].turnId, undefined, "no turnId — NEEDS_INFO never carries one");
  assert.equal(result.status, "RESOLVED");
  assert.equal(result.turns_used, 2, "1 = Step 4b's pre-dispatched turn, 2 = this follow-up");
  assert.equal(result.threadId, "chat:99");
});

test("turn1Result only short-circuits the FIRST pass — later iterations submit normally", async () => {
  let calls = 0;
  const submit = async () => {
    calls++;
    if (calls === 1) {
      return { status: "NEEDS_INFO", threadId: "chat:99", asks: [{ evidenceType: "other", ask: { what: "logs excerpt" } }] };
    }
    return {
      status: "RESOLVED",
      threadId: "chat:99",
      confidence: "medium",
      glimpse: { root_cause: "resolved on turn 3", failure_type: "infra", related_prs: [] },
      viewRca: "https://automation.browserstack.com/y",
    };
  };

  const result = await runRcaLoop({
    testRunId: "99",
    submit,
    config: CONFIG,
    manifest: GITHUB_AVAILABLE,
    gather,
    turn1Result: { threadId: "chat:99", asks: [{ evidenceType: "product_code", ask: { what: "diff" } }] },
  });

  assert.equal(calls, 2, "one real submit for the ROUTE follow-up, one more to resolve");
  assert.equal(result.status, "RESOLVED");
  assert.equal(result.turns_used, 3, "1 pre-dispatched + 2 real submits");
});

test("without turn1Result, behaviour is unchanged: turn 1 IS submitted normally", async () => {
  const submits = [];
  const submit = async (args) => {
    submits.push(args);
    return {
      status: "RESOLVED",
      threadId: "chat:1",
      confidence: "high",
      glimpse: { root_cause: "root", failure_type: "product_regression", related_prs: [] },
      viewRca: "https://automation.browserstack.com/z",
    };
  };

  const result = await runRcaLoop({
    testRunId: "1",
    firstMessage: "Initiating collaborative RCA for test run 1.",
    submit,
    config: CONFIG,
    manifest: GITHUB_AVAILABLE,
    gather,
  });

  assert.equal(submits.length, 1);
  assert.equal(submits[0].message, "Initiating collaborative RCA for test run 1.");
  assert.equal(result.turns_used, 1);
});
