#!/usr/bin/env node
// Deterministically pre-fetch a repo's merged-PR window into the build evidence
// file, in the CANONICAL shape, in ONE call — so the orchestrator never hand-rolls
// the entry (the failure mode: a `{deployState, prCount5d, topPRs}` blob that
// readers ignore because they only read `prsInWindow`, defeating the whole
// pre-fetch and forcing every coordinator to re-run `gh pr list` live).
//
//   node bin/prefetch-prs.mjs <buildId> <org/repo> <branch> <fromISO> <toISO>
//
// Runs the FIRST PR-list call WITH `files` (per SKILL.md Step 4), writes
// `prsInWindow: [{pr, title, mergedAt, url, files:[…]}]` + `prsSearched: true`
// via setCodeEvidence — merging, so an existing `deployState` is preserved.
// Emits a one-line summary. Uses the GitHub CLI (`gh`); a different GitHub
// capability should pre-fetch through its own connector and write the same shape.

import { execFileSync } from "node:child_process";
import {
  evidencePathFor, setCodeEvidence, readBaseFile,
} from "../lib/evidence-file.mjs";

/** Pure: map `gh pr list --json …,files` output to canonical prsInWindow rows.
 * Exported for tests — no I/O, no network. */
export function normalizePrs(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((pr) => ({
    pr: pr.number ?? pr.pr ?? null,
    title: pr.title ?? "",
    mergedAt: pr.mergedAt ?? null,
    url: pr.url ?? null,
    files: Array.isArray(pr.files)
      ? pr.files.map((f) => (typeof f === "string" ? f : f?.path)).filter(Boolean)
      : [],
  }));
}

// --- CLI ---
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [, , buildId, repo, branch, from, to] = process.argv;
  if (!buildId || !repo || !branch || !from || !to) {
    console.error("usage: prefetch-prs.mjs <buildId> <org/repo> <branch> <fromISO> <toISO>");
    process.exit(2);
  }

  let raw;
  try {
    const out = execFileSync(
      "gh",
      [
        "pr", "list", "-R", repo, "--state", "merged", "--base", branch,
        "--search", `merged:${from}..${to}`,
        "--json", "number,title,mergedAt,url,files",
        "--limit", "100",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    raw = JSON.parse(out || "[]");
  } catch (err) {
    // A failed search is a genuine gap, never a blocker — record it so readers
    // know the list was ATTEMPTED (not silently empty) and can fall back to live.
    const path = evidencePathFor(buildId, process.env.RCA_STATE_DIR ?? "");
    const base = readBaseFile(path);
    const prev = (base.github ?? {})[repo] ?? {};
    setCodeEvidence(path, repo, {
      deployState: prev.deployState ?? null,
      prsInWindow: [],
      prsSearched: false,
      gap: `pr-list search failed: ${String(err.message || err).slice(0, 120)}`,
    }, Date.now());
    console.error(`[prefetch-prs] ${repo}: search FAILED — recorded gap, readers will fall back to live`);
    process.exit(1);
  }

  const prsInWindow = normalizePrs(raw);
  const path = evidencePathFor(buildId, process.env.RCA_STATE_DIR ?? "");
  const base = readBaseFile(path);
  const prev = (base.github ?? {})[repo] ?? {};
  setCodeEvidence(path, repo, {
    deployState: prev.deployState ?? null,   // preserve an already-fetched deployState
    prsInWindow,
    prsSearched: true,
    gap: null,
  }, Date.now());

  const withFiles = prsInWindow.filter((p) => p.files.length > 0).length;
  console.log(`[prefetch-prs] ${repo}: ${prsInWindow.length} PR(s) in window, ${withFiles} with files → prsInWindow`);
}
