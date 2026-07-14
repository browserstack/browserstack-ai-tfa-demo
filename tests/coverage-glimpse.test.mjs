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

test("glimpse renders one arrow line per test with status counts", () => {
  const rows = [
    {
      testRunId: "101",
      cluster_id: "c1",
      rca_done: "resolved",
      confidence: "high",
      root_cause: "PR #7421 tightened validator",
    },
    {
      testRunId: "102",
      cluster_id: "c1",
      rca_done: "failed",
      confidence: "",
      root_cause: "",
    },
  ];
  const txt = renderGlimpse(rows, { buildId: "b1" });
  assert.match(txt, /2 test\(s\)/);
  assert.match(txt, /resolved: 1/);
  assert.match(txt, /failed: 1/);
  assert.match(txt, /101 → c1 → resolved → high: PR #7421 tightened validator/);
  assert.match(txt, /102 → c1 → failed → -/); // blank fields degrade to "-"
});

test("glimpse one-liner truncates and collapses newlines (stays terse)", () => {
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
  const line = txt.split("\n").find((l) => l.startsWith("1 →"));
  assert.ok(line.includes("line one line two"));
  assert.ok(line.endsWith("…"));
  assert.ok(line.length < 120);
});
