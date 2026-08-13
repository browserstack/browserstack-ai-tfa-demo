import { test } from "node:test";
import assert from "node:assert/strict";
import { runRcaLoop } from "../lib/loop.mjs";

const CONFIG = {
  turnCap: 6,
  evidenceRouting: { test_logs: { owner: "tfa", skip: true } },
};

test("loop out(): PR not in evidence is ruled-out when evidenceDoc provided", async () => {
  const submit = async () => ({
    status: "RESOLVED",
    threadId: "t1",
    confidence: "high",
    glimpse: {
      root_cause: "code change",
      failure_type: "product_regression",
      related_prs: [
        { owner: "org", repo: "app", number: 42, verdict: "supported" },
        { owner: "org", repo: "app", number: 999, verdict: "supported" },
      ],
    },
    viewRca: "https://example.com",
  });

  const evidenceDoc = {
    github: { "org/app": { prsInWindow: [{ pr: 42, author: "alice" }] } },
    suspectWindow: { startedAt: "2026-08-10T00:00:00Z" },
  };

  const result = await runRcaLoop({
    testRunId: "1",
    submit,
    config: CONFIG,
    evidenceDoc,
  });

  assert.equal(result.status, "RESOLVED");
  assert.equal(result.related_prs.length, 2, "both entries should be present (ruled-out, not dropped)");
  const valid = result.related_prs.find((p) => p.number === 42);
  const invalid = result.related_prs.find((p) => p.number === 999);
  assert.ok(valid);
  assert.ok(invalid);
  assert.ok(!String(valid.verdict ?? "").startsWith("ruled-out"));
  assert.equal(invalid.verdict, "ruled-out (not-in-evidence)");
});

test("loop out(): without evidenceDoc, PRs pass through unvalidated", async () => {
  const submit = async () => ({
    status: "RESOLVED",
    threadId: "t1",
    confidence: "high",
    glimpse: {
      root_cause: "code change",
      failure_type: "product_regression",
      related_prs: [{ owner: "org", repo: "app", number: 999, verdict: "supported" }],
    },
    viewRca: "https://example.com",
  });

  const result = await runRcaLoop({
    testRunId: "2",
    submit,
    config: CONFIG,
  });

  assert.equal(result.related_prs.length, 1);
  assert.equal(result.related_prs[0].verdict, "supported");
});

test("loop out(): deduplicates PRs with same repo+number", async () => {
  const submit = async () => ({
    status: "RESOLVED",
    threadId: "t1",
    confidence: "high",
    glimpse: {
      root_cause: "code change",
      failure_type: "product_regression",
      related_prs: [
        { owner: "org", repo: "app", number: 42, title: "title A", verdict: "supported" },
        { owner: "org", repo: "app", number: 42, title: "title B", verdict: "supported" },
      ],
    },
    viewRca: "https://example.com",
  });

  const evidenceDoc = {
    github: { "org/app": { prsInWindow: [{ pr: 42, title: "real title" }] } },
    suspectWindow: { startedAt: "2026-08-10T00:00:00Z" },
  };

  const result = await runRcaLoop({
    testRunId: "3",
    submit,
    config: CONFIG,
    evidenceDoc,
  });

  assert.equal(result.related_prs.length, 1);
  assert.equal(result.related_prs[0].title, "real title");
});
