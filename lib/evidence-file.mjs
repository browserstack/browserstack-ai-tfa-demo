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
