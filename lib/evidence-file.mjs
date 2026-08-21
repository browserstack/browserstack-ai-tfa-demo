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
// Write-back, WITHOUT a lock and WITHOUT lost updates — single-writer shards.
// The orchestrator's Step 4 pass is not the only writer: a coordinator that
// had to gather live (a repo/PR/workload the pre-fetch didn't cover, or
// covered only with a summary) should persist what it found so a sibling
// dispatched after it — or another cluster sharing the same repo/workload —
// reads the enriched result instead of re-fetching it.
//
// Naively that means N concurrent coordinators read-modify-writing ONE JSON
// file, which drops updates whenever two writes interleave. Instead of a lock
// (fragile, and `csv-state.mjs` already declares multi-process locking out of
// scope) the layout makes contention structurally impossible:
//
//   <tmpdir>/bstack-rca/
//     rca-evidence.<buildId>.json              <- BASE: only the orchestrator writes it
//     rca-evidence.<buildId>.contrib/
//       <writerId>.json                        <- one file per coordinator; sole writer
//       <writerId>.json
//
// Every file has exactly ONE writer, so no write can ever clobber another's.
// Reads (`readEvidenceFile`) fold base + every shard into a single view,
// deterministically (shards applied in sorted filename order). This is the
// same "the temp dir is ours, use more of it" trick the CSV path convention
// already leans on.

// Fold precedence, applied per leaf when base and shards disagree:
//   1. Real evidence beats a recorded gap — a coordinator that actually got
//      the data overrides the pre-fetch's "couldn't reach this".
//   2. Among two real values, the later shard wins (sorted order), on the
//      assumption a coordinator only writes back something deeper than what
//      it read.
//   3. `prsInWindow` is unioned by PR number rather than replaced, so two
//      coordinators finding different PRs in the same repo both survive.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const safeName = (v, fallback) =>
  String(v ?? "").replace(/[^A-Za-z0-9._-]/g, "_") || fallback;

/** Canonical evidence-file path for one build's run. Same two invariants as
 * `csvPathFor`: build id in the filename; OS temp by default; `stateDir`
 * overrides the directory only. */
export function evidencePathFor(buildId, stateDir = "") {
  const safe = safeName(buildId, "unknown-build");
  const dir = stateDir && String(stateDir).trim() !== "" ? String(stateDir) : join(tmpdir(), "bstack-rca");
  return join(dir, `rca-evidence.${safe}.json`);
}

/** Directory holding this build's per-coordinator contribution shards. Derived
 * from the base path so callers only ever have to pass `evidenceFilePath`
 * around — one input, no second path to thread through every dispatch. */
export function contribDirFor(basePath) {
  return String(basePath).replace(/\.json$/, "") + ".contrib";
}

/** The one file a given writer owns. Exactly one writer per path is the whole
 * point — never call this for a writerId that isn't yours. */
export function contribPathFor(basePath, writerId) {
  return join(contribDirFor(basePath), `${safeName(writerId, "unknown-writer")}.json`);
}

/** Shard docs in deterministic (sorted-filename) order. Missing dir → []. A
 * corrupt/half-written shard is skipped rather than throwing: a coordinator
 * killed mid-write must not break every subsequent read. */
function readContribs(basePath) {
  const dir = contribDirFor(basePath);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), "utf8")));
    } catch {
      // skip unreadable/partial shard
    }
  }
  return out;
}

// Owner-only, on create AND on an existing directory. `mkdirSync`'s `mode`
// applies only when it creates the dir, so one made before this hardening
// landed keeps its 0755 forever — and these artifacts hold root causes,
// culprit PRs and log excerpts in a shared OS temp dir. Found in practice:
// <tmpdir>/bstack-rca was drwxr-xr-x with 0600 files inside it.
function ensureOwnerOnlyDir(dir) {
  if (!existsSync(dir)) { mkdirSync(dir, { recursive: true, mode: 0o700 }); return; }
  try { chmodSync(dir, 0o700); } catch { /* not ours to tighten; leave it */ }
}

export function emptyEvidenceFile(buildId, nowMs) {
  return {
    buildId: String(buildId ?? ""),
    generatedAtMs: nowMs,
    baseline: null,
    suspectWindow: null,
    github: {},
    logs: {},
    // Where each repo can be read locally at its pinned sha, resolved ONCE at
    // the gate. Without this every coordinator re-probes the filesystem for
    // the workspace and re-checks each commit — pure duplicated setup, which
    // is the same waste the evidence file exists to remove for PRs and logs.
    localRepos: null,
    coverage: { reposCovered: [], reposGapped: [], workloadsCovered: [], workloadsGapped: [] },
  };
}

/** The BASE file alone, no shards folded in. Internal to the orchestrator's
 * write path: `set*`/`merge*` must read-modify-write base only, or they would
 * absorb shard content into base and duplicate it on the next fold. */
// Marker keys stamped on the BASE file so a raw read announces its own
// incompleteness.
//
// Telling coordinators in the prompt to use `evidence-show` was not enough:
// measured on a real run, 21 of 25 evidence-file reads were raw `cat`/`grep`/
// `Read` against the base path, and only 4 went through the folded view. A raw
// read shows the orchestrator's base ONLY and silently hides every
// contribution shard — which is precisely the representative-to-sibling
// context the file exists to carry. Three different agents each `cat`-ed the
// same file and each saw a partial picture.
//
// So the file now says so itself, in the first bytes anyone sees. JSON has no
// comments, and these keys are the closest thing: they sort first, they are
// unmissable in a `cat` or a `head`, and they name the exact command to run.
// `_` prefixed and stripped on read, so they never reach the fold logic.
const BASE_MARKERS = {
  _READ_ME_FIRST:
    "PARTIAL VIEW — this is the orchestrator's BASE file only. Every coordinator's " +
    "contribution lives in a separate shard alongside it and is NOT in this file. " +
    "Reading this path directly (cat/grep/Read) WILL miss evidence other agents already gathered.",
  _USE_INSTEAD: "node <pluginRoot>/bin/evidence-show.mjs <thisPath> --summary   (also --prs, --repo <org/repo>)",
  _WHY: "Only evidence-show folds base + all shards into the real view. A raw read has cost a real run duplicated work.",
};

/** Strip the marker keys — they are documentation for humans and agents, never
 * data. Applied on every read so nothing downstream has to know about them. */
function stripMarkers(doc) {
  if (!doc || typeof doc !== "object") return doc;
  for (const k of Object.keys(BASE_MARKERS)) delete doc[k];
  return doc;
}

export function readBaseFile(filePath) {
  if (!existsSync(filePath)) return emptyEvidenceFile("unknown-build", 0);
  try {
    return stripMarkers(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return emptyEvidenceFile("unknown-build", 0);
  }
}

// A {block, gap} leaf: real evidence beats a gap; between two real values the
// later (shard) one wins. `undefined`/`null` incoming never overwrites.
function pickLeaf(base, incoming) {
  if (incoming == null) return base ?? null;
  if (base == null) return incoming;
  if (!incoming.gap) return incoming;
  if (!base.gap) return base;
  return incoming;
}

// Dedupe key for a PR entry. Union-by-number is right ONLY when a number is
// present: `String(undefined)` is the constant "undefined", so every
// numberless PR collides on one key and the list silently collapses to the
// last one. Observed live — a coordinator wrote back a 6-PR window and the
// file kept 1, with `pr: undefined`, while still reporting the search as
// trustworthy. Fall back to a content key so unnumbered entries survive
// distinctly, and never treat two unknowns as the same PR.
function prKey(pr, index) {
  const n = pr?.pr;
  if (n !== undefined && n !== null && String(n).trim() !== "" && String(n) !== "undefined") {
    return `#${String(n).replace(/^#/, "")}`;
  }
  const t = String(pr?.title ?? "").trim();
  const u = String(pr?.url ?? pr?.link ?? "").trim();
  return u ? `url:${u}` : t ? `title:${t}` : `anon:${index}`;
}

function foldGithub(target, repo, entry) {
  const cur = target[repo] ?? { deployState: null, prsInWindow: [], gap: null };
  const next = {
    deployState: pickLeaf(cur.deployState, entry.deployState),
    prsInWindow: cur.prsInWindow ?? [],
    // Sticky: once ANY writer has genuinely run the PR search, the entry stays
    // trustworthy — a later contributor that didn't search must not silently
    // downgrade it back to "unknown".
    prsSearched: cur.prsSearched === true || entry.prsSearched === true,
    gap: cur.gap ?? null,
  };
  if (Array.isArray(entry.prsInWindow)) {
    const byPr = new Map((next.prsInWindow ?? []).map((p, i) => [prKey(p, i), p]));
    entry.prsInWindow.forEach((pr, i) => byPr.set(prKey(pr, `in-${i}`), pr));
    next.prsInWindow = [...byPr.values()];
  }
  // A contributor supplying real content clears the pre-fetch's gap.
  if (entry.gap === null || entry.gap === undefined) {
    if (entry.deployState || Array.isArray(entry.prsInWindow)) next.gap = null;
  } else if (!next.deployState && (next.prsInWindow ?? []).length === 0) {
    next.gap = entry.gap;
  }
  target[repo] = next;
}

function foldLogs(target, workload, entry) {
  const cur = target[workload] ?? { clusterIds: [], kubectlSweep: null, victorialogs: null, gap: null };
  const next = {
    clusterIds: [...new Set([...(cur.clusterIds ?? []), ...(entry.clusterIds ?? [])])],
    kubectlSweep: pickLeaf(cur.kubectlSweep, entry.kubectlSweep),
    victorialogs: pickLeaf(cur.victorialogs, entry.victorialogs),
    gap: cur.gap ?? null,
  };
  if (entry.gap === null || entry.gap === undefined) {
    if (entry.kubectlSweep || entry.victorialogs) next.gap = null;
  } else if (!next.kubectlSweep && !next.victorialogs) {
    next.gap = entry.gap;
  }
  target[workload] = next;
}

/** The full view every CONSUMER should read: the orchestrator's base pre-fetch
 * with every coordinator's contribution shard folded on top, deterministically.
 * Never throws on a missing base or a corrupt shard — an absent/partial result
 * just means those asks fall back to a live gather, which is the whole
 * degradation contract. */
export function readEvidenceFile(filePath) {
  const doc = readBaseFile(filePath);
  for (const shard of readContribs(filePath)) {
    for (const [repo, entry] of Object.entries(shard.github ?? {})) foldGithub(doc.github, repo, entry);
    for (const [wl, entry] of Object.entries(shard.logs ?? {})) foldLogs(doc.logs, wl, entry);
    if (shard.generatedAtMs > (doc.generatedAtMs ?? 0)) doc.generatedAtMs = shard.generatedAtMs;
  }
  return doc;
}

// Owner-only (0700 dir / 0600 file): this sits in a world-readable OS temp dir
// and carries private-repo PR detail and app-log digests.
export function writeEvidenceFile(filePath, doc) {
  const dir = dirname(filePath);
  // `mode` applies on CREATE only — the same trap already fixed for the files
  // themselves. A directory made before hardening stays 0755 forever, which on
  // a shared machine leaves root causes, culprit PRs and log excerpts readable
  // by every local user. Tighten an existing one too.
  if (dir) ensureOwnerOnlyDir(dir);
  const existed = existsSync(filePath);
  // Markers first, so `head` and any truncated preview show them before data.
  const stamped = { ...BASE_MARKERS, ...stripMarkers({ ...doc }) };
  writeFileSync(filePath, JSON.stringify(stamped, null, 2), { encoding: "utf8", mode: 0o600 });
  // `mode` is only honoured when the file is CREATED. A file left over from a
  // run that predates this hardening would otherwise keep its old 0644
  // forever, so tighten it explicitly on overwrite too.
  if (existed) chmodSync(filePath, 0o600);
}

function loadOrInit(filePath, nowMs) {
  if (!existsSync(filePath)) return emptyEvidenceFile("unknown-build", nowMs);
  return readBaseFile(filePath);
}

/** Idempotent: creates the file with the given `buildId` if it doesn't exist
 * yet, otherwise leaves an existing file untouched (never clobbers prior
 * writes on a resume). Call this FIRST, before any `set*` call, so `buildId`
 * is recorded correctly — the `set*` functions below fall back to
 * `"unknown-build"` only as a safety net if called without this. */
export function initEvidenceFile(filePath, buildId, nowMs) {
  if (existsSync(filePath)) return readBaseFile(filePath);
  const doc = emptyEvidenceFile(buildId, nowMs);
  writeEvidenceFile(filePath, doc);
  return doc;
}

/**
 * Persist the once-resolved local-repo map (from `repo-source.mjs`'s
 * `discoverWorkspaceRoot` + `resolveLocalRepos`). Shape:
 * `{ workspaceRoot, repos: { "org/repo": {dir, sha, usable, reason} } }`.
 *
 * A coordinator reads this and immediately knows, per repo, whether to use a
 * local sha-pinned read or go to the network — with no filesystem probing of
 * its own. `workspaceRoot: null` is a legitimate, useful answer: it means
 * discovery ran and failed, so nobody should try again.
 */
export function setLocalRepos(filePath, localRepos, nowMs) {
  const doc = loadOrInit(filePath, nowMs);
  doc.localRepos = localRepos;
  doc.generatedAtMs = nowMs;
  writeEvidenceFile(filePath, doc);
  return doc.localRepos;
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

/** Canonical top-level keys of a `doc.github[repo]` entry. Everything else is
 * a caller mistake (see `assertGithubEntry`). */
const GITHUB_ENTRY_KEYS = new Set(["deployState", "prsInWindow", "prsSearched", "gap"]);

/** Guard the code-evidence entry shape at the write boundary.
 *
 * `setCodeEvidence` stores the entry VERBATIM, so a caller that hand-rolls a
 * shape — e.g. `{ deployState, prCount5d, topPRs }` instead of the canonical
 * `{ deployState, prsInWindow, … }` — silently produces a file whose PR list
 * every reader (`evidence-show`, `hasTrustworthyPrList`, the coordinators)
 * treats as "never searched", because they only read `prsInWindow`. The whole
 * build-level pre-fetch is then defeated with no error, and every coordinator
 * re-fetches the PR list live. Fail loud here instead of shipping a dead file. */
export function assertGithubEntry(entry, repo = "?") {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    const got = entry === null ? "null" : Array.isArray(entry) ? "array" : typeof entry;
    throw new TypeError(`github entry for '${repo}' must be an object, got ${got}`);
  }
  const unknown = Object.keys(entry).filter((k) => !GITHUB_ENTRY_KEYS.has(k));
  if (unknown.length) {
    throw new Error(
      `github entry for '${repo}' has unknown key(s) [${unknown.join(", ")}]. ` +
        `Canonical shape: { deployState, prsInWindow: [{pr, files, …}], prsSearched, gap }. ` +
        `A merged-PR list MUST be stored as 'prsInWindow' with each PR's 'files' — readers ` +
        `ignore any other key, so a mis-shaped entry silently reads as "never searched".`,
    );
  }
  if (entry.prsInWindow !== undefined && !Array.isArray(entry.prsInWindow)) {
    throw new TypeError(`github entry for '${repo}': prsInWindow must be an array`);
  }
  return entry;
}

/** Read-modify-write merge into `doc.github[repo]`. `entry` shape:
 * `{ deployState: {block, gap}, prsInWindow: [{pr, files, block, verdict}],
 * gap }` — `gap` (top-level, on the repo entry) is what `recomputeCoverage`
 * checks; a repo present with a non-null `gap` is NOT counted as covered.
 * Only ever touches this one repo's key — every other repo/workload already
 * in the file is untouched. The entry shape is validated (`assertGithubEntry`). */
export function setCodeEvidence(filePath, repo, entry, nowMs) {
  assertGithubEntry(entry, repo);
  const doc = loadOrInit(filePath, nowMs);
  doc.github[repo] = entry;
  doc.generatedAtMs = nowMs;
  writeEvidenceFile(filePath, doc);
  return doc;
}

/** Read-modify-write merge into `doc.logs[workload]`. `entry` shape:
 * `{ clusterIds, kubectlSweep: {block, gap}, victorialogs: {block, gap}, gap }`.
 * Same no-clobber guarantee as `setCodeEvidence`, keyed by workload instead
 * of repo. */
export function setLogsEvidence(filePath, workload, entry, nowMs) {
  const doc = loadOrInit(filePath, nowMs);
  doc.logs[workload] = entry;
  doc.generatedAtMs = nowMs;
  writeEvidenceFile(filePath, doc);
  return doc;
}

// ---- coordinator write-back: own-shard only, never the base file ----------
//
// `writerId` must be unique per concurrent writer — the dispatched
// coordinator's `testRunId` is the natural choice (one coordinator per test).
// Because a writer only ever opens its OWN shard, two coordinators writing at
// the same instant touch different files and neither can lose the other's
// update. Reads fold every shard back together (`readEvidenceFile`).

function loadOwnShard(basePath, writerId, nowMs) {
  const p = contribPathFor(basePath, writerId);
  if (!existsSync(p)) {
    return { path: p, doc: { writerId: String(writerId), generatedAtMs: nowMs, github: {}, logs: {} } };
  }
  try {
    return { path: p, doc: JSON.parse(readFileSync(p, "utf8")) };
  } catch {
    return { path: p, doc: { writerId: String(writerId), generatedAtMs: nowMs, github: {}, logs: {} } };
  }
}

function writeShard(path, doc) {
  const dir = dirname(path);
  // `mode` applies on CREATE only — the same trap already fixed for the files
  // themselves. A directory made before hardening stays 0755 forever, which on
  // a shared machine leaves root causes, culprit PRs and log excerpts readable
  // by every local user. Tighten an existing one too.
  if (dir) ensureOwnerOnlyDir(dir);
  writeFileSync(path, JSON.stringify(doc, null, 2), { encoding: "utf8", mode: 0o600 });
}

/** Contribute what THIS coordinator gathered live for a repo — a deeper
 * `deployState` (e.g. the full diff, not just a summary), and/or PRs to fold
 * into `prsInWindow` (deduped by `pr`). `patch = { deployState?, prsInWindow?,
 * gap? }`; omit a field to leave it untouched. Writes only this writer's
 * shard, so it can never clobber another coordinator's contribution or the
 * orchestrator's base pre-fetch. */
export function contributeCodeEvidence(basePath, writerId, repo, patch, nowMs) {
  assertGithubEntry(patch, repo);
  const { path, doc } = loadOwnShard(basePath, writerId, nowMs);
  const entry = doc.github[repo] ?? { deployState: null, prsInWindow: [], gap: null };
  if (patch.deployState !== undefined) entry.deployState = patch.deployState;
  if (Array.isArray(patch.prsInWindow)) {
    const byPr = new Map((entry.prsInWindow ?? []).map((p, i) => [prKey(p, i), p]));
    patch.prsInWindow.forEach((pr, i) => byPr.set(prKey(pr, `in-${i}`), pr));
    entry.prsInWindow = [...byPr.values()];
    // Contributing a list — even an empty one — means you actually ran the
    // search, so record that. Pass `prsSearched: false` explicitly to opt out.
    entry.prsSearched = patch.prsSearched !== false;
  }
  if (patch.prsSearched !== undefined) entry.prsSearched = patch.prsSearched;
  if (patch.gap !== undefined) entry.gap = patch.gap;
  doc.github[repo] = entry;
  doc.generatedAtMs = nowMs;
  writeShard(path, doc);
  return entry;
}

/** Contribute what THIS coordinator gathered live for a workload's app-logs.
 * Same single-writer-shard discipline as `contributeCodeEvidence`;
 * `clusterIds` is unioned rather than replaced. */
export function contributeLogsEvidence(basePath, writerId, workload, patch, nowMs) {
  const { path, doc } = loadOwnShard(basePath, writerId, nowMs);
  const entry = doc.logs[workload] ?? { clusterIds: [], kubectlSweep: null, victorialogs: null, gap: null };
  if (patch.kubectlSweep !== undefined) entry.kubectlSweep = patch.kubectlSweep;
  if (patch.victorialogs !== undefined) entry.victorialogs = patch.victorialogs;
  if (Array.isArray(patch.clusterIds)) {
    entry.clusterIds = [...new Set([...(entry.clusterIds ?? []), ...patch.clusterIds])];
  }
  if (patch.gap !== undefined) entry.gap = patch.gap;
  doc.logs[workload] = entry;
  doc.generatedAtMs = nowMs;
  writeShard(path, doc);
  return entry;
}

// A requested item is "covered" only if it is present AND its own `gap` field
// is falsy. Presence with a `gap` is a recorded, deliberate miss — not
// coverage — so a coordinator (or this function) never mistakes "we looked
// and couldn't get it" for "we have it."
//
// For a github entry there is a further trap, hit for real in testing: an
// empty `prsInWindow` is byte-identical whether the PR search RAN and found
// nothing, or was never populated at all. A coordinator trusting the former
// reads "no PRs in window" and concludes "no culprit PR" — confidently wrong.
// (Observed: a file asserting 0 PRs for a repo that actually had 21, because
// the loader's search silently returned empty.) So an empty `prsInWindow`
// only counts as coverage when `prsSearched === true` explicitly records that
// the search was really performed.
// Kept deliberately at the REPO level: an entry with deploy state but no PR
// search is still real coverage of that repo. PR-list trustworthiness is a
// narrower question, reported separately as `reposWithUntrustedPrList` so it
// is visible without distorting covered/gapped.
function isCovered(doc, section, key) {
  const entry = doc[section]?.[key];
  return Boolean(entry) && !entry.gap;
}

/** True when this repo entry can be trusted to answer "which PRs were in the
 * window" — i.e. it either lists PRs, or explicitly records that the search
 * ran and legitimately found none. Coordinators should call this before
 * concluding "no culprit PR" from the pre-fetch. */
export function hasTrustworthyPrList(doc, repo) {
  const entry = doc?.github?.[repo];
  if (!entry || entry.gap) return false;
  return (entry.prsInWindow ?? []).length > 0 || entry.prsSearched === true;
}

/** Derives `doc.coverage` from exactly which requested repos/workloads have a
 * gap-free entry, and persists it. `requested = {repos:[...], workloads:[...]}`
 * — normally the Gate Part A scope-probe-validated repo list and the union of
 * workloads every cluster's representative implicates (see SKILL.md Step 4). */
export function recomputeCoverage(filePath, requested, nowMs) {
  // Coverage is judged against the FOLDED view — a gap the orchestrator
  // recorded but a coordinator later filled is genuinely covered now — while
  // the result is persisted to base, which the orchestrator solely owns.
  const folded = readEvidenceFile(filePath);
  const doc = loadOrInit(filePath, nowMs);
  const repos = requested?.repos ?? [];
  const workloads = requested?.workloads ?? [];
  doc.coverage = {
    reposCovered: repos.filter((r) => isCovered(folded, "github", r)),
    reposGapped: repos.filter((r) => !isCovered(folded, "github", r)),
    workloadsCovered: workloads.filter((w) => isCovered(folded, "logs", w)),
    workloadsGapped: workloads.filter((w) => !isCovered(folded, "logs", w)),
    // Repos whose PR list must NOT be read as "no PRs in window": the list is
    // empty and nothing recorded that a search actually ran. Surfacing this
    // separately keeps a coordinator from concluding "no culprit PR" off an
    // array that was simply never filled in.
    reposWithUntrustedPrList: repos.filter(
      (r) => isCovered(folded, "github", r) && !hasTrustworthyPrList(folded, r),
    ),
  };
  doc.generatedAtMs = nowMs;
  writeEvidenceFile(filePath, doc);
  return doc.coverage;
}

/**
 * How stale is this pre-fetch, and is it still safe to trust?
 *
 * We are careful never to read a repo at a branch name because a stale clone
 * yields a confident wrong answer — but the evidence file had exactly the same
 * exposure and no guard at all. It is keyed only by `buildId`, so a
 * `pending-resume` row hours or days later silently reuses the original
 * `deployState` and PR window. Those describe "what was deployed and what
 * merged around the build", and both keep moving after the pre-fetch is
 * written. Reusing them blind is the same failure mode, just slower to notice.
 *
 * This does not expire anything — the file stays usable, because stale
 * build-level context is still far better than none and the failure window
 * itself never moves. It returns a signal the caller can surface, so a
 * coordinator re-verifies a suspect PR instead of trusting a day-old list.
 *
 * `maxFreshMs` defaults to 6h: comfortably longer than any normal batch run
 * (minutes), short enough that an overnight resume is flagged.
 */
export function stalenessOf(filePath, nowMs, maxFreshMs = 6 * 60 * 60 * 1000) {
  const doc = readEvidenceFile(filePath);
  const generatedAtMs = doc?.generatedAtMs ?? 0;
  if (!generatedAtMs) {
    return { known: false, stale: false, ageMs: null, note: "no generatedAtMs recorded — age unknown" };
  }
  // A timestamp in the FUTURE must never read as "fresh". Clamping the age to
  // zero is the tempting one-liner and it fails in the worst direction: clock
  // skew between the gate host and a coordinator, or a hand-seeded timestamp,
  // would silently certify arbitrarily old evidence as current. We can't tell
  // the age, so say so rather than guess in the reassuring direction.
  if (generatedAtMs > nowMs) {
    return {
      known: false,
      stale: true,
      ageMs: null,
      generatedAtMs,
      note: `generatedAtMs is ${Math.round((generatedAtMs - nowMs) / 60000)}m in the future (clock skew or a seeded timestamp) — age cannot be trusted; re-verify any PR you are about to name as the cause.`,
    };
  }
  const ageMs = nowMs - generatedAtMs;
  const stale = ageMs > maxFreshMs;
  const mins = Math.round(ageMs / 60000);
  return {
    known: true,
    stale,
    ageMs,
    generatedAtMs,
    note: stale
      ? `pre-fetch is ${mins}m old (> ${Math.round(maxFreshMs / 60000)}m): deployState and the PR window may have moved since. Still usable — the failure window is fixed — but re-verify any PR you are about to name as the cause.`
      : `pre-fetch is ${mins}m old — fresh`,
  };
}

/**
 * The build-time commit sha per repo, as a structured map — the input
 * `resolveLocalRepos` needs for its `pins`.
 *
 * Step 4 SHOULD set `deployState.sha` explicitly. It historically didn't: the
 * sha lived only in the prose `summary` ("Branch tip on <branch> at build
 * start = cd88535b (deploy proxy)"), so the one consumer that needs it
 * structurally had to regex English, and got an empty map when the wording
 * drifted. That silently downgraded every local read to a network call while
 * looking like it worked.
 *
 * So: prefer the explicit field, fall back to parsing the summary, and report
 * which happened so a caller can tell "no sha recorded" from "sha recovered
 * from prose". A bare 7-40 hex word is NOT enough on its own — timestamps and
 * image tags match that too — so the fallback anchors on an `=`/`:` after a
 * build-start phrase.
 */
export function deployShas(filePathOrDoc) {
  const doc = typeof filePathOrDoc === "string" ? readEvidenceFile(filePathOrDoc) : filePathOrDoc;
  const pins = {};
  const source = {};
  for (const [repo, entry] of Object.entries(doc?.github ?? {})) {
    const ds = entry?.deployState;
    if (!ds) continue;
    if (typeof ds.sha === "string" && /^[0-9a-f]{7,40}$/i.test(ds.sha)) {
      pins[repo] = ds.sha;
      source[repo] = "field";
      continue;
    }
    const m = String(ds.summary ?? "").match(/at build start\s*[=:]\s*([0-9a-f]{7,40})\b/i);
    if (m) {
      pins[repo] = m[1];
      source[repo] = "parsed-from-summary";
    }
  }
  return { pins, source };
}
