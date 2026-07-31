// Build-level evidence pre-fetch artifact (see docs/plan: evidence-file). PR
// windows, deploy state, and app-log sweeps are properties of the BUILD, not
// of any one test — a naive batch re-fetches them once per dispatched
// coordinator. This module persists them to a file ONCE so every
// representative and sibling `ai-tfa-coordinator` dispatch can `Read` the same
// artifact instead of re-running the same `gh`/`kubectl`/`grafana` calls.
//
// Layered under `lib/evidence-cache.mjs`, not merged with it: the cache is an
// in-process, function-scoped Map that dedups compute *within* the
// orchestrator's own Step 4 pass; this module is what makes that result
// visible to OTHER processes (the independently-dispatched coordinator
// subagents, which share no memory with the orchestrator or each other).
//
// Path convention mirrors `lib/csv-state.mjs`'s `csvPathFor` exactly: the
// build id is in the filename (no cross-build collisions) and the default
// directory is OS temp (`<tmpdir>/bstack-rca/`), so a build's evidence file
// sits right next to its state CSV. `stateDir` overrides the directory only.
//
// Invariant: this file NEVER carries `test_logs` content. `logs` is keyed by
// *workload* (an infra/pod concept), populated only via the `infra`/`logs`
// capability — TFA remains the sole owner of test-side SDK/driver/session
// logs, which structurally cannot land here.
//
// Timestamps are passed in as `nowMs` (never read from the clock here), same
// discipline as `csv-state.mjs`, so this stays usable from the Workflow-tool
// sandbox (which forbids `Date.now()`).
//
// Write-back (mergeGithubEvidence / mergeLogsEvidence): the orchestrator's
// Step 4 pass is not the only writer. A coordinator that had to gather live
// (a repo/PR/workload the pre-fetch didn't cover, or covered only with a
// summary) should write what it found back into this SAME file — a
// representative's deep dive then benefits its own siblings (dispatched
// after it resolves) and any other cluster that turns out to share the same
// repo/workload, without re-fetching. Concurrency caveat, same philosophy as
// `csv-state.mjs`'s "true multi-process locking is out of scope": this is a
// synchronous read-modify-write with no file lock, so two coordinators
// writing to the SAME repo/workload key at truly the same moment can lose an
// update. In practice this is low-risk for the case this exists to serve —
// a sibling is dispatched only after its representative resolves, i.e.
// sequentially, never concurrently with it — and acceptable for the rarer
// case of two parallel representatives happening to touch the same repo.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/** Canonical evidence-file path for one build's run. Same two invariants as
 * `csvPathFor`: build id in the filename; OS temp by default; `stateDir`
 * overrides the directory only. */
export function evidencePathFor(buildId, stateDir = "") {
  const safe = String(buildId ?? "").replace(/[^A-Za-z0-9._-]/g, "_") || "unknown-build";
  const dir = stateDir && String(stateDir).trim() !== "" ? String(stateDir) : join(tmpdir(), "bstack-rca");
  return join(dir, `rca-evidence.${safe}.json`);
}

export function emptyEvidenceFile(buildId, nowMs) {
  return {
    buildId: String(buildId ?? ""),
    generatedAtMs: nowMs,
    baseline: null,
    suspectWindow: null,
    github: {},
    logs: {},
    coverage: { reposCovered: [], reposGapped: [], workloadsCovered: [], workloadsGapped: [] },
  };
}

/** Read-only; never throws on a missing file — a coordinator (or the
 * orchestrator, before Step 4 has run) always gets a well-shaped, empty-covered
 * result rather than an exception. Graceful degradation is the point: an
 * absent/partial file just means every ask falls back to a live gather. */
export function readEvidenceFile(filePath) {
  if (!existsSync(filePath)) return emptyEvidenceFile("unknown-build", 0);
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function writeEvidenceFile(filePath, doc) {
  const dir = dirname(filePath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(doc, null, 2), "utf8");
}

function loadOrInit(filePath, nowMs) {
  if (!existsSync(filePath)) return emptyEvidenceFile("unknown-build", nowMs);
  return readEvidenceFile(filePath);
}

/** Idempotent: creates the file with the given `buildId` if it doesn't exist
 * yet, otherwise leaves an existing file untouched (never clobbers prior
 * writes on a resume). Call this FIRST, before any `set*` call, so `buildId`
 * is recorded correctly — the `set*` functions below fall back to
 * `"unknown-build"` only as a safety net if called without this. */
export function initEvidenceFile(filePath, buildId, nowMs) {
  if (existsSync(filePath)) return readEvidenceFile(filePath);
  const doc = emptyEvidenceFile(buildId, nowMs);
  writeEvidenceFile(filePath, doc);
  return doc;
}

/** Records the diff/PR-window baseline once, at the start of the Step 4 pass.
 * `baseline` is `resolveBaseline(...)`'s return value from `evidence-cache.mjs`
 * (`{ref, isFallback}`); `suspectWindow` is whatever shape the active connector
 * skill uses to describe the window (e.g. `{reposRequested, startedAt}`). */
export function setBaseline(filePath, baseline, suspectWindow, nowMs) {
  const doc = loadOrInit(filePath, nowMs);
  doc.baseline = baseline;
  doc.suspectWindow = suspectWindow;
  doc.generatedAtMs = nowMs;
  writeEvidenceFile(filePath, doc);
  return doc;
}

/** Read-modify-write merge into `doc.github[repo]`. `entry` shape:
 * `{ deployState: {block, gap}, prsInWindow: [{pr, files, block, verdict}],
 * gap }` — `gap` (top-level, on the repo entry) is what `recomputeCoverage`
 * checks; a repo present with a non-null `gap` is NOT counted as covered.
 * Only ever touches this one repo's key — every other repo/workload already
 * in the file is untouched. */
export function setGithubEvidence(filePath, repo, entry, nowMs) {
  const doc = loadOrInit(filePath, nowMs);
  doc.github[repo] = entry;
  doc.generatedAtMs = nowMs;
  writeEvidenceFile(filePath, doc);
  return doc;
}

/** Read-modify-write merge into `doc.logs[workload]`. `entry` shape:
 * `{ clusterIds, kubectlSweep: {block, gap}, victorialogs: {block, gap}, gap }`.
 * Same no-clobber guarantee as `setGithubEvidence`, keyed by workload instead
 * of repo. */
export function setLogsEvidence(filePath, workload, entry, nowMs) {
  const doc = loadOrInit(filePath, nowMs);
  doc.logs[workload] = entry;
  doc.generatedAtMs = nowMs;
  writeEvidenceFile(filePath, doc);
  return doc;
}

// Read-modify-write, preserving whatever isn't in `patch`. Returns an existing
// repo entry, or a blank one — this is what lets a coordinator enrich a repo
// the pre-fetch never named at all (a brand-new candidate it found live), not
// just one that's already there with a gap.
function findRepoEntry(doc, repo) {
  return doc.github[repo] ?? { deployState: null, prsInWindow: [], gap: null };
}

function findWorkloadEntry(doc, workload) {
  return doc.logs[workload] ?? { clusterIds: [], kubectlSweep: null, victorialogs: null, gap: null };
}

/** Write back what a coordinator gathered LIVE for a repo — a deeper
 * `deployState` (e.g. the full diff/patch, not just a summary), and/or one or
 * more PRs to fold into `prsInWindow` (deduped by `pr`; a PR with a `pr` that
 * already exists is REPLACED, since the coordinator's fresh finding is
 * presumably deeper than a placeholder). `patch = { deployState?, prsInWindow?,
 * gap? }` — omit a field to leave it untouched. Passing `gap: null` clears a
 * previously-recorded gap now that real evidence exists. Never removes a PR
 * or a field this call doesn't mention. */
export function mergeGithubEvidence(filePath, repo, patch, nowMs) {
  const doc = loadOrInit(filePath, nowMs);
  const entry = findRepoEntry(doc, repo);
  if (patch.deployState !== undefined) entry.deployState = patch.deployState;
  if (Array.isArray(patch.prsInWindow)) {
    const byPr = new Map((entry.prsInWindow ?? []).map((p) => [String(p.pr), p]));
    for (const pr of patch.prsInWindow) byPr.set(String(pr.pr), pr);
    entry.prsInWindow = [...byPr.values()];
  }
  if (patch.gap !== undefined) entry.gap = patch.gap;
  doc.github[repo] = entry;
  doc.generatedAtMs = nowMs;
  writeEvidenceFile(filePath, doc);
  return entry;
}

/** Write back what a coordinator gathered LIVE for a workload's logs — same
 * merge discipline as `mergeGithubEvidence`. `patch = { kubectlSweep?,
 * victorialogs?, clusterIds?, gap? }`; `clusterIds` is unioned, not replaced,
 * since more than one cluster can end up sharing a workload over the run. */
export function mergeLogsEvidence(filePath, workload, patch, nowMs) {
  const doc = loadOrInit(filePath, nowMs);
  const entry = findWorkloadEntry(doc, workload);
  if (patch.kubectlSweep !== undefined) entry.kubectlSweep = patch.kubectlSweep;
  if (patch.victorialogs !== undefined) entry.victorialogs = patch.victorialogs;
  if (Array.isArray(patch.clusterIds)) {
    entry.clusterIds = [...new Set([...(entry.clusterIds ?? []), ...patch.clusterIds])];
  }
  if (patch.gap !== undefined) entry.gap = patch.gap;
  doc.logs[workload] = entry;
  doc.generatedAtMs = nowMs;
  writeEvidenceFile(filePath, doc);
  return entry;
}

// A requested item is "covered" only if it is present AND its own `gap` field
// is falsy. Presence with a `gap` is a recorded, deliberate miss — not
// coverage — so a coordinator (or this function) never mistakes "we looked
// and couldn't get it" for "we have it."
function isCovered(doc, section, key) {
  const entry = doc[section]?.[key];
  return Boolean(entry) && !entry.gap;
}

/** Derives `doc.coverage` from exactly which requested repos/workloads have a
 * gap-free entry, and persists it. `requested = {repos:[...], workloads:[...]}`
 * — normally the Gate Part A scope-probe-validated repo list and the union of
 * workloads every cluster's representative implicates (see SKILL.md Step 4). */
export function recomputeCoverage(filePath, requested, nowMs) {
  const doc = loadOrInit(filePath, nowMs);
  const repos = requested?.repos ?? [];
  const workloads = requested?.workloads ?? [];
  doc.coverage = {
    reposCovered: repos.filter((r) => isCovered(doc, "github", r)),
    reposGapped: repos.filter((r) => !isCovered(doc, "github", r)),
    workloadsCovered: workloads.filter((w) => isCovered(doc, "logs", w)),
    workloadsGapped: workloads.filter((w) => !isCovered(doc, "logs", w)),
  };
  doc.generatedAtMs = nowMs;
  writeEvidenceFile(filePath, doc);
  return doc.coverage;
}
