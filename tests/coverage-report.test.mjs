import { test } from "node:test";
import assert from "node:assert/strict";
import { coverageStamp, classifyCoverage } from "../lib/coverage.mjs";
import { renderReport } from "../lib/report.mjs";

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
    asksUnavailable: ["k8s", "metrics"],
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

// ---- report ----------------------------------------------------------------

test("empty batch renders a valid report, no crash", () => {
  const md = renderReport([], { buildId: "b1" });
  assert.match(md, /No failed tests analyzed/);
});

test("report renders a row table with status counts", () => {
  const rows = [
    {
      testRunId: "101",
      testName: "login",
      rca_done: "resolved",
      confidence: "high",
      coverage: "full",
      root_cause: "PR #7421 tightened validator",
      related_prs: "#7421",
    },
    {
      testRunId: "102",
      testName: "checkout",
      rca_done: "blocked",
      confidence: "",
      coverage: "",
      root_cause: "",
      related_prs: "",
    },
  ];
  const md = renderReport(rows, { buildId: "b1" });
  assert.match(md, /2 test\(s\)/);
  assert.match(md, /resolved: 1/);
  assert.match(md, /blocked: 1/);
  assert.match(md, /101/);
  assert.match(md, /not available/); // 102's blank fields degrade
});

test("report escapes pipes and collapses newlines in cells", () => {
  const rows = [
    {
      testRunId: "1",
      testName: "t",
      rca_done: "resolved",
      root_cause: "a | b\nsecond line",
      related_prs: "#1",
    },
  ];
  const md = renderReport(rows);
  assert.ok(!md.includes("a | b\nsecond"));
  assert.match(md, /a \\\| b second line/);
});

test("report surfaces coverage caveats for thin/partial rows", () => {
  const rows = [
    { testRunId: "1", testName: "t", rca_done: "resolved", coverage: "partial" },
  ];
  const md = renderReport(rows);
  assert.match(md, /Coverage caveats/);
  assert.match(md, /confidence band reflects evidence that was unavailable/);
});
