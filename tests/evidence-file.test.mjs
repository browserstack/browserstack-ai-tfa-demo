import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evidencePathFor,
  emptyEvidenceFile,
  initEvidenceFile,
  readEvidenceFile,
  writeEvidenceFile,
  setBaseline,
  setCodeEvidence,
  setLogsEvidence,
  contributeCodeEvidence,
  contributeLogsEvidence,
  contribDirFor,
  contribPathFor,
  readBaseFile,
  hasTrustworthyPrList,
  recomputeCoverage,
  assertGithubEntry,
} from "../lib/evidence-file.mjs";

let dir;
let file;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rca-evidence-"));
  file = join(dir, "evidence.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// --- assertGithubEntry: the write-boundary guard that would have caught the
// real prod bug (a hand-rolled {deployState, prCount5d, topPRs} blob that
// readers ignore because they only read prsInWindow). ---

test("assertGithubEntry: rejects the exact prod mis-shape (topPRs/prCount5d)", () => {
  assert.throws(
    () => assertGithubEntry({ deployState: { sha: "x" }, prCount5d: 6, topPRs: [] }, "repo-A"),
    /unknown key\(s\) \[prCount5d, topPRs\]/,
  );
});

test("assertGithubEntry: accepts the canonical shape", () => {
  assert.doesNotThrow(() =>
    assertGithubEntry({ deployState: { sha: "x" }, prsInWindow: [{ pr: 1, files: ["a.js"] }], prsSearched: true, gap: null }, "repo-A"),
  );
  assert.doesNotThrow(() => assertGithubEntry({ gap: "unreachable" }, "repo-A"));
  assert.doesNotThrow(() => assertGithubEntry({ deployState: null }, "repo-A"));
});

test("assertGithubEntry: rejects non-object and non-array prsInWindow", () => {
  assert.throws(() => assertGithubEntry(null, "r"), /must be an object/);
  assert.throws(() => assertGithubEntry([], "r"), /must be an object/);
  assert.throws(() => assertGithubEntry({ prsInWindow: "nope" }, "r"), /prsInWindow must be an array/);
});

test("setCodeEvidence: propagates the guard — a mis-shaped entry throws, no dead file shipped", () => {
  initEvidenceFile(file, "b1", 1000);
  assert.throws(
    () => setCodeEvidence(file, "repo-A", { deployState: { sha: "x" }, topPRs: [{ number: 1 }] }, 2000),
    /unknown key\(s\) \[topPRs\]/,
  );
});

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
  setCodeEvidence(file, "org/a", { gap: null, deployState: { block: "x" } }, 2000);
  const before = readEvidenceFile(file);
  const again = initEvidenceFile(file, "build-1", 9999);
  assert.deepEqual(again, before);
});

test("setCodeEvidence and setLogsEvidence coexist without clobbering each other", () => {
  setCodeEvidence(file, "org/a", { gap: null, deployState: { block: "a-deploy" } }, 1000);
  setLogsEvidence(file, "workload-1", { gap: null, kubectlSweep: { block: "w1-logs" } }, 1000);
  const doc = readEvidenceFile(file);
  assert.equal(doc.github["org/a"].deployState.block, "a-deploy");
  assert.equal(doc.logs["workload-1"].kubectlSweep.block, "w1-logs");
});

test("setCodeEvidence for a second repo does not disturb the first", () => {
  setCodeEvidence(file, "org/a", { gap: null, deployState: { block: "a" } }, 1000);
  setCodeEvidence(file, "org/b", { gap: null, deployState: { block: "b" } }, 1000);
  const doc = readEvidenceFile(file);
  assert.equal(doc.github["org/a"].deployState.block, "a");
  assert.equal(doc.github["org/b"].deployState.block, "b");
});

test("setCodeEvidence twice for the SAME repo overwrites only that repo", () => {
  setCodeEvidence(file, "org/a", { gap: null, deployState: { block: "old" } }, 1000);
  setCodeEvidence(file, "org/b", { gap: null, deployState: { block: "b" } }, 1000);
  setCodeEvidence(file, "org/a", { gap: null, deployState: { block: "new" } }, 2000);
  const doc = readEvidenceFile(file);
  assert.equal(doc.github["org/a"].deployState.block, "new");
  assert.equal(doc.github["org/b"].deployState.block, "b"); // untouched
});

test("setBaseline records baseline and suspectWindow without touching github/logs", () => {
  setCodeEvidence(file, "org/a", { gap: null, deployState: { block: "a" } }, 1000);
  setBaseline(file, { ref: "sha123", isFallback: false }, { reposRequested: ["org/a"] }, 2000);
  const doc = readEvidenceFile(file);
  assert.deepEqual(doc.baseline, { ref: "sha123", isFallback: false });
  assert.deepEqual(doc.suspectWindow, { reposRequested: ["org/a"] });
  assert.equal(doc.github["org/a"].deployState.block, "a"); // untouched
});

test("recomputeCoverage: a covered repo/workload has no gap; a missing one is gapped", () => {
  setCodeEvidence(file, "org/a", { gap: null, deployState: { block: "a" } }, 1000);
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
  setCodeEvidence(file, "org/a", { gap: "gh auth failed for this repo" }, 1000);
  const coverage = recomputeCoverage(file, { repos: ["org/a"], workloads: [] }, 2000);
  assert.deepEqual(coverage.reposCovered, []);
  assert.deepEqual(coverage.reposGapped, ["org/a"]);
});

test("recomputeCoverage persists onto the file (readable afterwards)", () => {
  setCodeEvidence(file, "org/a", { gap: null, deployState: { block: "a" } }, 1000);
  recomputeCoverage(file, { repos: ["org/a"], workloads: [] }, 2000);
  const doc = readEvidenceFile(file);
  assert.deepEqual(doc.coverage.reposCovered, ["org/a"]);
});

test("a block string with newlines and quotes round-trips through JSON unchanged", () => {
  const block = 'ASK: did X change?\nTYPE: product_code\nFOUND: yes\nSUMMARY: "quoted" finding\nSNIPPET: line1\nline2';
  setCodeEvidence(file, "org/a", { gap: null, deployState: { block } }, 1000);
  const doc = readEvidenceFile(file);
  assert.equal(doc.github["org/a"].deployState.block, block);
});

test("contribute writes a shard, never the base file", () => {
  setCodeEvidence(file, "org/a", { gap: null, deployState: { block: "base" } }, 1000);
  contributeCodeEvidence(file, "3895581484", "org/a", {
    deployState: { block: "coordinator's full diff" },
  }, 2000);
  // base is untouched...
  assert.equal(readBaseFile(file).github["org/a"].deployState.block, "base");
  // ...but the folded view shows the contribution
  assert.equal(readEvidenceFile(file).github["org/a"].deployState.block, "coordinator's full diff");
});

test("contribPathFor: one file per writer, under the build's contrib dir", () => {
  const p = contribPathFor(file, "3895581484");
  assert.ok(p.startsWith(contribDirFor(file)));
  assert.ok(p.endsWith("3895581484.json"));
  assert.notEqual(contribPathFor(file, "w1"), contribPathFor(file, "w2"));
});

test("contribPathFor sanitizes a hostile writerId", () => {
  assert.ok(contribPathFor(file, "../../etc/passwd").endsWith("_.._etc_passwd.json"));
});

test("CONCURRENCY: two writers on the same repo both survive (no lost update)", () => {
  setCodeEvidence(file, "org/a", {
    gap: null, deployState: { block: "base" }, prsInWindow: [{ pr: "#1" }],
  }, 1000);
  // Interleave the two writers the way real concurrent coordinators would:
  // each reads, then each writes — under a single shared file this is exactly
  // the sequence that drops the first writer's update.
  contributeCodeEvidence(file, "writerA", "org/a", { prsInWindow: [{ pr: "#2", by: "A" }] }, 2000);
  contributeCodeEvidence(file, "writerB", "org/a", { prsInWindow: [{ pr: "#3", by: "B" }] }, 2000);
  const prs = readEvidenceFile(file).github["org/a"].prsInWindow.map((p) => p.pr).sort();
  assert.deepEqual(prs, ["#1", "#2", "#3"]); // base + BOTH contributions
});

test("CONCURRENCY: two writers on the same workload both survive", () => {
  contributeLogsEvidence(file, "writerA", "w1", { kubectlSweep: { block: "A found 3 lines" } }, 1000);
  contributeLogsEvidence(file, "writerB", "w1", { victorialogs: { block: "B found 5xx" } }, 1000);
  const w = readEvidenceFile(file).logs["w1"];
  assert.equal(w.kubectlSweep.block, "A found 3 lines");
  assert.equal(w.victorialogs.block, "B found 5xx");
});

test("fold: real contributed evidence beats a base-recorded gap", () => {
  setCodeEvidence(file, "org/a", { gap: "gh auth failed" }, 1000);
  contributeCodeEvidence(file, "w1", "org/a", {
    gap: null, deployState: { block: "reachable after all" },
  }, 2000);
  const entry = readEvidenceFile(file).github["org/a"];
  assert.equal(entry.gap, null);
  assert.equal(entry.deployState.block, "reachable after all");
});

test("fold: a contributed gap does NOT overwrite real base evidence", () => {
  setCodeEvidence(file, "org/a", { gap: null, deployState: { block: "real base evidence" } }, 1000);
  contributeCodeEvidence(file, "w1", "org/a", { deployState: { gap: "my call failed" } }, 2000);
  assert.equal(readEvidenceFile(file).github["org/a"].deployState.block, "real base evidence");
});

test("fold: same PR number contributed later wins (deeper finding replaces placeholder)", () => {
  setCodeEvidence(file, "org/a", {
    gap: null, prsInWindow: [{ pr: "#9011", verdict: "unassessed", files: null }],
  }, 1000);
  contributeCodeEvidence(file, "w1", "org/a", {
    prsInWindow: [{ pr: "#9011", verdict: "supported", files: ["Foo.java"] }],
  }, 2000);
  const prs = readEvidenceFile(file).github["org/a"].prsInWindow;
  assert.equal(prs.length, 1);
  assert.equal(prs[0].verdict, "supported");
});

test("fold: contributing a repo the pre-fetch never named", () => {
  contributeCodeEvidence(file, "w1", "org/brand-new", {
    prsInWindow: [{ pr: "#8912", verdict: "supported" }],
  }, 1000);
  assert.equal(readEvidenceFile(file).github["org/brand-new"].prsInWindow[0].pr, "#8912");
});

test("fold: clusterIds union across base and multiple shards", () => {
  setLogsEvidence(file, "w1", { gap: null, clusterIds: ["c-A"], kubectlSweep: { block: "x" } }, 1000);
  contributeLogsEvidence(file, "w1writer", "w1", { clusterIds: ["c-B"] }, 2000);
  contributeLogsEvidence(file, "w2writer", "w1", { clusterIds: ["c-C"] }, 2000);
  assert.deepEqual(readEvidenceFile(file).logs["w1"].clusterIds.sort(), ["c-A", "c-B", "c-C"]);
});

test("fold: a corrupt shard is skipped, not fatal", () => {
  setCodeEvidence(file, "org/a", { gap: null, deployState: { block: "base" } }, 1000);
  contributeCodeEvidence(file, "good", "org/a", { prsInWindow: [{ pr: "#2" }] }, 2000);
  writeFileSync(contribPathFor(file, "corrupt"), "{not json", "utf8");
  const doc = readEvidenceFile(file); // must not throw
  assert.equal(doc.github["org/a"].prsInWindow[0].pr, "#2");
});

test("recomputeCoverage counts a coordinator-filled gap as covered", () => {
  setCodeEvidence(file, "org/a", { gap: "unreachable at pre-fetch time" }, 1000);
  let cov = recomputeCoverage(file, { repos: ["org/a"], workloads: [] }, 2000);
  assert.deepEqual(cov.reposGapped, ["org/a"]);
  contributeCodeEvidence(file, "w1", "org/a", { gap: null, deployState: { block: "got it" } }, 3000);
  cov = recomputeCoverage(file, { repos: ["org/a"], workloads: [] }, 4000);
  assert.deepEqual(cov.reposCovered, ["org/a"]);
  assert.deepEqual(cov.reposGapped, []);
});

// Regression: an empty prsInWindow with gap:null used to read as "searched,
// found none" when it may simply never have been populated. Observed live —
// a file asserted 0 PRs for a repo that actually had 21, which would have let
// a coordinator conclude "no culprit PR" with false confidence.
test("empty prsInWindow is NOT coverage unless the search is recorded", () => {
  setCodeEvidence(file, "org/never-searched", { gap: null, deployState: { block: "d" }, prsInWindow: [] }, 1000);
  setCodeEvidence(file, "org/searched-empty", { gap: null, deployState: { block: "d" }, prsInWindow: [], prsSearched: true }, 1000);
  const cov = recomputeCoverage(file, { repos: ["org/never-searched", "org/searched-empty"], workloads: [] }, 2000);
  // Both repos ARE covered (each has deploy state) — but only one has a PR
  // list safe to read as "no PRs in window".
  assert.deepEqual(cov.reposCovered.sort(), ["org/never-searched", "org/searched-empty"]);
  assert.deepEqual(cov.reposWithUntrustedPrList, ["org/never-searched"]);
});

test("hasTrustworthyPrList distinguishes searched-empty from never-populated", () => {
  setCodeEvidence(file, "org/a", { gap: null, prsInWindow: [] }, 1000);
  setCodeEvidence(file, "org/b", { gap: null, prsInWindow: [], prsSearched: true }, 1000);
  setCodeEvidence(file, "org/c", { gap: null, prsInWindow: [{ pr: "#1" }] }, 1000);
  const doc = readEvidenceFile(file);
  assert.equal(hasTrustworthyPrList(doc, "org/a"), false);
  assert.equal(hasTrustworthyPrList(doc, "org/b"), true);
  assert.equal(hasTrustworthyPrList(doc, "org/c"), true);
});

test("contributing a PR list records that the search actually ran", () => {
  contributeCodeEvidence(file, "w1", "org/a", { prsInWindow: [] }, 1000);
  assert.equal(hasTrustworthyPrList(readEvidenceFile(file), "org/a"), true);
});

test("prsSearched is sticky — a later non-searching contributor cannot downgrade it", () => {
  setCodeEvidence(file, "org/a", { gap: null, prsInWindow: [{ pr: "#1" }], prsSearched: true }, 1000);
  contributeCodeEvidence(file, "w1", "org/a", { deployState: { block: "just deploy info" } }, 2000);
  assert.equal(readEvidenceFile(file).github["org/a"].prsSearched, true);
});

test("a pre-existing loose-mode file is tightened to 0600 on the next write", () => {
  writeEvidenceFile(file, emptyEvidenceFile("b", 0));
  chmodSync(file, 0o644); // simulate a file left by a pre-hardening run
  setCodeEvidence(file, "org/a", { gap: null, deployState: { block: "x" } }, 1000);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("evidence file and contribution shards are owner-only (0600)", () => {
  setCodeEvidence(file, "org/a", { gap: null, deployState: { block: "private PR detail" } }, 1000);
  contributeCodeEvidence(file, "w1", "org/a", { prsInWindow: [{ pr: "#1" }] }, 2000);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(contribPathFor(file, "w1")).mode & 0o777, 0o600);
});

test("writeEvidenceFile creates the parent directory if missing", () => {
  const nested = join(dir, "nested", "sub", "evidence.json");
  writeEvidenceFile(nested, emptyEvidenceFile("build-1", 0));
  assert.deepEqual(readEvidenceFile(nested).buildId, "build-1");
});

// Staleness: the resume-path analogue of refusing a branch name.
test("stalenessOf flags an old pre-fetch but never invalidates it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rca-stale-"));
  const { evidencePathFor, initEvidenceFile, stalenessOf, readEvidenceFile } =
    await import("../lib/evidence-file.mjs");
  const t0 = 1_700_000_000_000;
  const p = evidencePathFor("b-stale", dir);
  initEvidenceFile(p, "b-stale", t0);

  const fresh = stalenessOf(p, t0 + 5 * 60 * 1000);
  assert.equal(fresh.stale, false, "5m into a run is fresh");
  assert.equal(fresh.known, true);

  const old = stalenessOf(p, t0 + 20 * 60 * 60 * 1000);
  assert.equal(old.stale, true, "an overnight resume must be flagged");
  assert.match(old.note, /re-verify/, "must say what to do, not just that it is old");

  // Crucially it is a SIGNAL, not an expiry — the data is still there, because
  // stale build-level context still beats none and the failure window is fixed.
  assert.ok(readEvidenceFile(p), "file must remain readable when stale");

  rmSync(dir, { recursive: true, force: true });
});

// The clamp-to-zero trap: a future timestamp must not read as "fresh".
test("stalenessOf refuses to call a future timestamp fresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rca-skew-"));
  const { evidencePathFor, initEvidenceFile, stalenessOf } = await import("../lib/evidence-file.mjs");
  const t0 = 1_700_000_000_000;
  const p = evidencePathFor("b-skew", dir);
  initEvidenceFile(p, "b-skew", t0);

  // Coordinator's clock is behind the gate's, or the stamp was seeded by hand.
  const s = stalenessOf(p, t0 - 11 * 60 * 60 * 1000);
  assert.equal(s.stale, true, "unknown age must fail closed, not report fresh");
  assert.equal(s.known, false, "we genuinely cannot compute an age here");
  assert.match(s.note, /future/);

  rmSync(dir, { recursive: true, force: true });
});

// The sha lived only in prose, so the one consumer that needs it structurally
// got an empty map — silently downgrading every local read to a network call.
test("deployShas prefers the explicit field and falls back to the summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rca-pins-"));
  const { evidencePathFor, initEvidenceFile, setCodeEvidence, deployShas } =
    await import("../lib/evidence-file.mjs");
  const p = evidencePathFor("b-pins", dir);
  initEvidenceFile(p, "b-pins", 1);

  setCodeEvidence(p, "org/explicit", { deployState: { sha: "abc1234", summary: "" } }, 2);
  setCodeEvidence(p, "org/prose", {
    deployState: { summary: "Branch tip on main at build start = cd88535b (deploy proxy). Redeploy stamped 260731135020Z." },
  }, 3);
  setCodeEvidence(p, "org/none", { deployState: { summary: "no sha here" } }, 4);

  const { pins, source } = deployShas(p);
  assert.equal(pins["org/explicit"], "abc1234");
  assert.equal(source["org/explicit"], "field");
  assert.equal(pins["org/prose"], "cd88535b", "must recover the sha from prose");
  assert.equal(source["org/prose"], "parsed-from-summary");
  assert.equal(pins["org/none"], undefined, "absent must stay absent, not guess");

  // The timestamp 260731135020Z is hex-ish and long — anchoring on the
  // build-start phrase is what stops it being mistaken for a commit.
  assert.notEqual(pins["org/prose"], "260731135020");

  rmSync(dir, { recursive: true, force: true });
});

// Observed live: a coordinator wrote back a 6-PR window and the file kept ONE,
// with `pr: undefined`, while still flagging the search trustworthy. Cause:
// String(undefined) is the constant "undefined", so every numberless PR
// collided on a single dedupe key.
test("numberless PRs do not collapse into one another", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rca-prkey-"));
  const { evidencePathFor, initEvidenceFile, contributeCodeEvidence, readEvidenceFile } =
    await import("../lib/evidence-file.mjs");
  const p = evidencePathFor("b-prkey", dir);
  initEvidenceFile(p, "b-prkey", 1);

  contributeCodeEvidence(p, "w1", "org/r", {
    prsSearched: true,
    prsInWindow: [{ title: "first" }, { title: "second" }, { title: "third" }],
  }, 2);
  const got = readEvidenceFile(p).github["org/r"].prsInWindow;
  assert.equal(got.length, 3, "three distinct unnumbered PRs must all survive");
  assert.deepEqual(got.map((x) => x.title), ["first", "second", "third"]);

  rmSync(dir, { recursive: true, force: true });
});

test("numbered PRs still merge across writers, string or numeric", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rca-prnum-"));
  const { evidencePathFor, initEvidenceFile, contributeCodeEvidence, readEvidenceFile } =
    await import("../lib/evidence-file.mjs");
  const p = evidencePathFor("b-prnum", dir);
  initEvidenceFile(p, "b-prnum", 1);

  contributeCodeEvidence(p, "w1", "org/r", { prsInWindow: [{ pr: "#10", title: "a" }] }, 2);
  contributeCodeEvidence(p, "w2", "org/r", { prsInWindow: [{ pr: 10, title: "a-updated" }] }, 3);

  const got = readEvidenceFile(p).github["org/r"].prsInWindow;
  assert.equal(got.length, 1, "'#10' and 10 are the same PR");
  assert.equal(got[0].title, "a-updated", "later writer wins");

  rmSync(dir, { recursive: true, force: true });
});

// Prompting agents to use evidence-show wasn't enough: 21 of 25 reads on a real
// run were raw cat/grep/Read against the base path, each silently missing every
// contribution shard. The file now announces that in its own first bytes.
test("a raw read of the base file announces that it is partial", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rca-warn-"));
  const { evidencePathFor, initEvidenceFile, setCodeEvidence, readEvidenceFile, readBaseFile } =
    await import("../lib/evidence-file.mjs");
  const { readFileSync } = await import("node:fs");
  const p = evidencePathFor("b-warn", dir);
  initEvidenceFile(p, "b-warn", 1);
  setCodeEvidence(p, "org/r", { deployState: { sha: "abc1234" } }, 2);

  const raw = readFileSync(p, "utf8");
  const head = raw.slice(0, 400);
  assert.match(head, /PARTIAL VIEW/, "warning must be in the first bytes a cat/head shows");
  assert.match(raw, /evidence-show\.mjs/, "must name the command that gives the real view");

  // Markers are documentation, never data — nothing downstream should see them.
  for (const doc of [readBaseFile(p), readEvidenceFile(p)]) {
    assert.equal(doc._READ_ME_FIRST, undefined);
    assert.equal(doc._USE_INSTEAD, undefined);
    assert.equal(doc._WHY, undefined);
  }
  // And the real content still round-trips.
  assert.equal(readEvidenceFile(p).github["org/r"].deployState.sha, "abc1234");

  rmSync(dir, { recursive: true, force: true });
});

test("markers survive repeated writes without accumulating", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rca-warn2-"));
  const { evidencePathFor, initEvidenceFile, setCodeEvidence } = await import("../lib/evidence-file.mjs");
  const { readFileSync } = await import("node:fs");
  const p = evidencePathFor("b-w2", dir);
  initEvidenceFile(p, "b-w2", 1);
  for (let i = 0; i < 3; i++) setCodeEvidence(p, `org/r${i}`, { deployState: { sha: "abc1234" } }, i + 2);

  const raw = readFileSync(p, "utf8");
  assert.equal(raw.split("_READ_ME_FIRST").length - 1, 1, "exactly one marker, not one per write");

  rmSync(dir, { recursive: true, force: true });
});
