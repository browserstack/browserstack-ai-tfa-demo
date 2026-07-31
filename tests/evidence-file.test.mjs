import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evidencePathFor,
  emptyEvidenceFile,
  initEvidenceFile,
  readEvidenceFile,
  writeEvidenceFile,
  setBaseline,
  setGithubEvidence,
  setLogsEvidence,
  mergeGithubEvidence,
  mergeLogsEvidence,
  recomputeCoverage,
} from "../lib/evidence-file.mjs";

let dir;
let file;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rca-evidence-"));
  file = join(dir, "evidence.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("evidencePathFor: build id is in the filename, default dir is OS temp", () => {
  const p = evidencePathFor("abc123XYZ");
  assert.ok(p.startsWith(join(tmpdir(), "bstack-rca")));
  assert.ok(p.endsWith("rca-evidence.abc123XYZ.json"));
});

test("evidencePathFor: different builds never share a path", () => {
  assert.notEqual(evidencePathFor("build-A"), evidencePathFor("build-B"));
});

test("evidencePathFor: sanitizes hostile ids and handles empty", () => {
  assert.ok(evidencePathFor("../../etc/passwd").endsWith("rca-evidence..._.._etc_passwd.json"));
  assert.ok(evidencePathFor("").endsWith("rca-evidence.unknown-build.json"));
});

test("evidencePathFor: stateDir override wins over temp", () => {
  const p = evidencePathFor("b1", "/ci/artifacts");
  assert.equal(p, join("/ci/artifacts", "rca-evidence.b1.json"));
});

test("readEvidenceFile on a missing path returns the empty shape, never throws", () => {
  const doc = readEvidenceFile(file);
  assert.deepEqual(doc, emptyEvidenceFile("unknown-build", 0));
});

test("initEvidenceFile creates the file with the given buildId", () => {
  const doc = initEvidenceFile(file, "build-1", 1000);
  assert.equal(doc.buildId, "build-1");
  assert.equal(doc.generatedAtMs, 1000);
  assert.deepEqual(readEvidenceFile(file), doc);
});

test("initEvidenceFile is idempotent — does not clobber an existing file", () => {
  initEvidenceFile(file, "build-1", 1000);
  setGithubEvidence(file, "org/a", { gap: null, deployState: { block: "x" } }, 2000);
  const before = readEvidenceFile(file);
  const again = initEvidenceFile(file, "build-1", 9999);
  assert.deepEqual(again, before);
});

test("setGithubEvidence and setLogsEvidence coexist without clobbering each other", () => {
  setGithubEvidence(file, "org/a", { gap: null, deployState: { block: "a-deploy" } }, 1000);
  setLogsEvidence(file, "workload-1", { gap: null, kubectlSweep: { block: "w1-logs" } }, 1000);
  const doc = readEvidenceFile(file);
  assert.equal(doc.github["org/a"].deployState.block, "a-deploy");
  assert.equal(doc.logs["workload-1"].kubectlSweep.block, "w1-logs");
});

test("setGithubEvidence for a second repo does not disturb the first", () => {
  setGithubEvidence(file, "org/a", { gap: null, deployState: { block: "a" } }, 1000);
  setGithubEvidence(file, "org/b", { gap: null, deployState: { block: "b" } }, 1000);
  const doc = readEvidenceFile(file);
  assert.equal(doc.github["org/a"].deployState.block, "a");
  assert.equal(doc.github["org/b"].deployState.block, "b");
});

test("setGithubEvidence twice for the SAME repo overwrites only that repo", () => {
  setGithubEvidence(file, "org/a", { gap: null, deployState: { block: "old" } }, 1000);
  setGithubEvidence(file, "org/b", { gap: null, deployState: { block: "b" } }, 1000);
  setGithubEvidence(file, "org/a", { gap: null, deployState: { block: "new" } }, 2000);
  const doc = readEvidenceFile(file);
  assert.equal(doc.github["org/a"].deployState.block, "new");
  assert.equal(doc.github["org/b"].deployState.block, "b"); // untouched
});

test("setBaseline records baseline and suspectWindow without touching github/logs", () => {
  setGithubEvidence(file, "org/a", { gap: null, deployState: { block: "a" } }, 1000);
  setBaseline(file, { ref: "sha123", isFallback: false }, { reposRequested: ["org/a"] }, 2000);
  const doc = readEvidenceFile(file);
  assert.deepEqual(doc.baseline, { ref: "sha123", isFallback: false });
  assert.deepEqual(doc.suspectWindow, { reposRequested: ["org/a"] });
  assert.equal(doc.github["org/a"].deployState.block, "a"); // untouched
});

test("recomputeCoverage: a covered repo/workload has no gap; a missing one is gapped", () => {
  setGithubEvidence(file, "org/a", { gap: null, deployState: { block: "a" } }, 1000);
  setLogsEvidence(file, "w1", { gap: null, kubectlSweep: { block: "w1" } }, 1000);
  const coverage = recomputeCoverage(
    file,
    { repos: ["org/a", "org/b"], workloads: ["w1", "w2"] },
    2000,
  );
  assert.deepEqual(coverage.reposCovered, ["org/a"]);
  assert.deepEqual(coverage.reposGapped, ["org/b"]);
  assert.deepEqual(coverage.workloadsCovered, ["w1"]);
  assert.deepEqual(coverage.workloadsGapped, ["w2"]);
});

test("recomputeCoverage: a present entry with a non-null gap is NOT covered", () => {
  setGithubEvidence(file, "org/a", { gap: "gh auth failed for this repo" }, 1000);
  const coverage = recomputeCoverage(file, { repos: ["org/a"], workloads: [] }, 2000);
  assert.deepEqual(coverage.reposCovered, []);
  assert.deepEqual(coverage.reposGapped, ["org/a"]);
});

test("recomputeCoverage persists onto the file (readable afterwards)", () => {
  setGithubEvidence(file, "org/a", { gap: null, deployState: { block: "a" } }, 1000);
  recomputeCoverage(file, { repos: ["org/a"], workloads: [] }, 2000);
  const doc = readEvidenceFile(file);
  assert.deepEqual(doc.coverage.reposCovered, ["org/a"]);
});

test("a block string with newlines and quotes round-trips through JSON unchanged", () => {
  const block = 'ASK: did X change?\nTYPE: product_code\nFOUND: yes\nSUMMARY: "quoted" finding\nSNIPPET: line1\nline2';
  setGithubEvidence(file, "org/a", { gap: null, deployState: { block } }, 1000);
  const doc = readEvidenceFile(file);
  assert.equal(doc.github["org/a"].deployState.block, block);
});

test("mergeGithubEvidence on a repo the pre-fetch never named creates a fresh entry", () => {
  const entry = mergeGithubEvidence(file, "org/new-repo", {
    prsInWindow: [{ pr: "#8912", verdict: "supported", block: "found live" }],
  }, 1000);
  assert.equal(entry.prsInWindow.length, 1);
  assert.equal(entry.gap, null);
  const doc = readEvidenceFile(file);
  assert.equal(doc.github["org/new-repo"].prsInWindow[0].pr, "#8912");
});

test("mergeGithubEvidence appends a new PR without dropping an existing one", () => {
  setGithubEvidence(file, "org/a", {
    gap: null,
    deployState: { block: "a" },
    prsInWindow: [{ pr: "#1", verdict: "not-live" }],
  }, 1000);
  mergeGithubEvidence(file, "org/a", {
    prsInWindow: [{ pr: "#2", verdict: "supported", block: "found live during coordinator's own hunt" }],
  }, 2000);
  const doc = readEvidenceFile(file);
  const prs = doc.github["org/a"].prsInWindow.map((p) => p.pr);
  assert.deepEqual(prs.sort(), ["#1", "#2"]);
  assert.equal(doc.github["org/a"].deployState.block, "a"); // untouched
});

test("mergeGithubEvidence replaces a PR entry with the same pr number (deeper finding wins)", () => {
  setGithubEvidence(file, "org/a", {
    gap: null,
    deployState: { block: "a" },
    prsInWindow: [{ pr: "#9011", verdict: "unassessed", files: null }],
  }, 1000);
  mergeGithubEvidence(file, "org/a", {
    prsInWindow: [{ pr: "#9011", verdict: "supported", files: ["Foo.java"], block: "full diff fetched" }],
  }, 2000);
  const doc = readEvidenceFile(file);
  assert.equal(doc.github["org/a"].prsInWindow.length, 1);
  assert.equal(doc.github["org/a"].prsInWindow[0].verdict, "supported");
  assert.deepEqual(doc.github["org/a"].prsInWindow[0].files, ["Foo.java"]);
});

test("mergeGithubEvidence with gap:null clears a previously-recorded gap", () => {
  setGithubEvidence(file, "org/a", { gap: "gh auth failed" }, 1000);
  mergeGithubEvidence(file, "org/a", { gap: null, deployState: { block: "found it after all" } }, 2000);
  const doc = readEvidenceFile(file);
  assert.equal(doc.github["org/a"].gap, null);
});

test("mergeLogsEvidence unions clusterIds instead of replacing them", () => {
  setLogsEvidence(file, "w1", { gap: null, clusterIds: ["c-A"], kubectlSweep: { block: "x" } }, 1000);
  mergeLogsEvidence(file, "w1", { clusterIds: ["c-B"] }, 2000);
  const doc = readEvidenceFile(file);
  assert.deepEqual(doc.logs["w1"].clusterIds.sort(), ["c-A", "c-B"]);
  assert.equal(doc.logs["w1"].kubectlSweep.block, "x"); // untouched
});

test("mergeLogsEvidence upgrades one sub-field without touching the other", () => {
  setLogsEvidence(file, "w1", {
    gap: null,
    kubectlSweep: { gap: "stale pods" },
    victorialogs: { block: "clean, 0 5xx" },
  }, 1000);
  mergeLogsEvidence(file, "w1", {
    kubectlSweep: { block: "found a fresh pod after all, 3 matched lines" },
  }, 2000);
  const doc = readEvidenceFile(file);
  assert.equal(doc.logs["w1"].kubectlSweep.block, "found a fresh pod after all, 3 matched lines");
  assert.equal(doc.logs["w1"].victorialogs.block, "clean, 0 5xx"); // untouched
});

test("writeEvidenceFile creates the parent directory if missing", () => {
  const nested = join(dir, "nested", "sub", "evidence.json");
  writeEvidenceFile(nested, emptyEvidenceFile("build-1", 0));
  assert.deepEqual(readEvidenceFile(nested).buildId, "build-1");
});
