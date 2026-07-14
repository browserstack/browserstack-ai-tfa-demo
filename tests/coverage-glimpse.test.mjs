import { test } from "node:test";
import assert from "node:assert/strict";
import { coverageStamp, classifyCoverage } from "../lib/coverage.mjs";
import { renderGlimpse } from "../lib/glimpse.mjs";

// ---- coverage stamp --------------------------------------------------------

test("full coverage keeps TFA confidence", () => {
  const s = coverageStamp({
    asksFulfilled: ["product_code"],
    asksUnavailable: [],
    tfaConfidence: "high",
  });
  assert.equal(s.coverage, "full");
  assert.equal(s.band, "high");
});

test("partial coverage caps a high TFA confidence at medium", () => {
  const s = coverageStamp({
    asksFulfilled: ["product_code"],
    asksUnavailable: ["kibana"],
    tfaConfidence: "high",
  });
  assert.equal(s.coverage, "partial");
  assert.equal(s.band, "medium");
  assert.deepEqual(s.unavailable, ["kibana"]);
});

test("thin coverage (nothing fulfilled, gaps) caps at low", () => {
  const s = coverageStamp({
    asksFulfilled: [],
    asksUnavailable: ["infra", "metrics"],
    tfaConfidence: "high",
  });
  assert.equal(s.coverage, "thin");
  assert.equal(s.band, "low");
});

test("unknown TFA confidence floors to low even at full coverage", () => {
  const s = coverageStamp({ asksFulfilled: [], asksUnavailable: [], tfaConfidence: "unknown" });
  assert.equal(s.coverage, "full");
  assert.equal(s.band, "low");
});

test("classifyCoverage dedupes and handles empties", () => {
  assert.equal(classifyCoverage(["a", "a"], []), "full");
  assert.equal(classifyCoverage([], ["x"]), "thin");
});

// ---- glimpse (the ONLY in-client output — no local report) ------------------

test("empty batch renders a valid glimpse, no crash", () => {
  const txt = renderGlimpse([], { buildId: "b1" });
  assert.match(txt, /No failed tests analyzed/);
});

test("glimpse is a completion notice with counts — NO per-test detail", () => {
  const rows = [
    {
      testRunId: "101",
      cluster_id: "c1",
      rca_done: "resolved",
      confidence: "high",
      root_cause: "PR #7421 tightened validator",
      related_prs: "#7421",
    },
    { testRunId: "102", cluster_id: "c1", rca_done: "pending-resume" },
    { testRunId: "103", cluster_id: "c2", rca_done: "failed" },
  ];
  const txt = renderGlimpse(rows, { buildId: "b1" });
  assert.match(txt, /RCA analysis complete — build b1/);
  assert.match(txt, /3 test\(s\)/);
  assert.match(txt, /1 resolved/);
  assert.match(txt, /1 pending/); // pending-resume buckets to "pending"
  assert.match(txt, /1 failed/);
  // The trim: no per-test lines, no root cause, no PRs, no testRunIds leak.
  assert.doesNotMatch(txt, /7421|PR #|→|101|102|103|c1|c2/);
});

test("glimpse never leaks a verbose root_cause, however long", () => {
  const rows = [
    {
      testRunId: "1",
      cluster_id: "solo-1",
      rca_done: "resolved",
      confidence: "medium",
      root_cause: `line one\nline two ${"x".repeat(200)}`,
    },
  ];
  const txt = renderGlimpse(rows);
  assert.doesNotMatch(txt, /line one|line two|xxxx/); // cause stays out of Claude
  assert.match(txt, /1 test\(s\) · 1 resolved/);
});
