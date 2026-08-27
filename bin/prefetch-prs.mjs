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
// `prsInWindow: [{pr, title, author, mergedAt, url, files:[…]}]` + `prsSearched: true`
// via setCodeEvidence — merging, so an existing `deployState` is preserved.
// Emits a one-line summary. Uses the GitHub CLI (`gh`); a different GitHub
// capability should pre-fetch through its own connector and write the same shape.

import { execFileSync } from "node:child_process";
import {
  evidencePathFor, setCodeEvidence, readBaseFile,
} from "../lib/evidence-file.mjs";

/** Pure: map `gh pr list --json …,files` output to canonical prsInWindow rows.
 * Exported for tests — no I/O, no network.
 *
 * `author` is projected because `tfaRcaTurn`'s `prDetails` REQUIRES it per PR, and this
 * is the only place PRs are fetched once for every coordinator to share. Without it each
 * coordinator pays a `gh pr view` per suspect just to fill one field — which is exactly
 * the per-coordinator re-fetching this pre-fetch exists to remove. `gh` returns it as
 * `{login}`, so it is flattened here rather than at each of the readers. */
export function normalizePrs(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((pr) => ({
    pr: pr.number ?? pr.pr ?? null,
    title: pr.title ?? "",
    author: typeof pr.author === "string" ? pr.author : (pr.author?.login ?? null),
    mergedAt: pr.mergedAt ?? null,
    url: pr.url ?? null,
    files: Array.isArray(pr.files)
      ? pr.files.map((f) => (typeof f === "string" ? f : f?.path)).filter(Boolean)
      : [],
  }));
}

/** The default per-PR fetch. Separated so `hydrateSuppliedPrs` can be tested for its
 * skip-one-keep-the-rest behaviour without a network — that behaviour was designed and
 * then shipped untested, and a mutation that failed the whole run instead survived. */
function ghViewPr(repo, n) {
  return JSON.parse(execFileSync(
    "gh",
    ["pr", "view", String(n), "-R", repo, "--json", "number,title,author,mergedAt,url,files"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ));
}

/** Fetch each supplied PR individually. A supplied list is not a search, so there is no
 * `--search` to project — `gh pr view` is the per-PR call `references/github-evidence.md`
 * § Ask routing already documents.
 *
 * A PR that cannot be fetched is dropped with a warning rather than failing the run: the
 * customer named several, and losing all of them because one number was mistyped is worse
 * than proceeding with the rest. The count printed at the end is what reveals the loss. */
export function hydrateSuppliedPrs(repo, numbers, fetchOne = ghViewPr) {
  const out = [];
  for (const n of numbers) {
    try {
      out.push(fetchOne(repo, n));
    } catch (err) {
      console.error(`[prefetch-prs] ${repo}#${n}: could not fetch — skipped (${String(err.message || err).split("\n")[0].slice(0, 80)})`);
    }
  }
  if (out.length === 0) throw new Error(`none of the ${numbers.length} supplied PR(s) could be fetched from ${repo}`);
  return out;
}

/** Pure: the PR numbers in a `--prs` value. Accepts commas, spaces, `#` prefixes and
 * full PR URLs, because the customer pastes whatever their bot wrote rather than a
 * normalised list. Exported for tests — no I/O.
 *
 * Deliberately NOT a validator of intent: it extracts numbers and nothing else. Deciding
 * WHICH repo a bare number belongs to is judgement over the profile's repos and stays
 * with the agent (`SKILL.md` § Step 0). */
export function parsePrList(value) {
  if (typeof value !== "string") return [];
  const seen = new Set();
  const add = (raw) => {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) seen.add(n);
  };

  // A bare list — `7900,7892` — is the flag's own form and every number in it is a PR.
  if (/^[\s,]*\d+(?:[\s,]+\d+)*[\s,]*$/u.test(value)) {
    for (const m of value.matchAll(/\d+/gu)) add(m[0]);
    return [...seen];
  }

  // Anything else is pasted prose, and a bare integer in prose is NOT a PR number. The
  // real paste this exists for — a regression-bot message — carries a JIRA ticket
  // (`.../browse/TRAP-4767`) and a timestamp (`[2:55 PM]`) alongside the PR links, and
  // scraping every integer turned those into `gh pr view 4767`, `2` and `55`: three
  // unrelated PRs silently added to the candidate set. So in prose only an explicit
  // marker counts — a `/pull/<n>` URL, or a `#<n>` reference.
  for (const m of value.matchAll(/\/pull\/(\d+)|#(\d+)\b/gu)) add(m[1] ?? m[2]);
  return [...seen];
}

// --- CLI ---
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [, , buildId, repo, ...rest] = process.argv;
  // Two enumeration sources, one writer. `--prs` is the customer's list, supplied at
  // invocation; the positional form is our own window search. Everything after
  // enumeration — hydration, the row shape, `prsSearched: true`, the `deployState`
  // preservation — is identical, which is the point of keeping one binary.
  const prsFlagAt = rest.indexOf("--prs");
  const supplied = prsFlagAt === -1 ? null : parsePrList(rest[prsFlagAt + 1] ?? "");
  const [branch, from, to] = rest;

  const usage = "usage: prefetch-prs.mjs <buildId> <org/repo> <branch> <fromISO> <toISO>\n" +
                "   or: prefetch-prs.mjs <buildId> <org/repo> --prs <n,n,n>";
  if (!buildId || !repo) { console.error(usage); process.exit(2); }
  if (prsFlagAt !== -1) {
    // An empty list is a caller bug, not an empty window: silently writing
    // `prsSearched: true` with no PRs would assert "searched, found none" about a search
    // that never happened — the exact confusion prsSearched exists to prevent.
    if (supplied.length === 0) {
      console.error("prefetch-prs: --prs was given but no PR number could be read from it");
      process.exit(2);
    }
  } else if (!branch || !from || !to) {
    console.error(usage);
    process.exit(2);
  }

  let raw;
  try {
    raw = supplied
      ? hydrateSuppliedPrs(repo, supplied)
      : JSON.parse(execFileSync(
          "gh",
          [
            "pr", "list", "-R", repo, "--state", "merged", "--base", branch,
            "--search", `merged:${from}..${to}`,
            "--json", "number,title,author,mergedAt,url,files",
            "--limit", "100",
          ],
          { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
        ) || "[]");
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
  const source = supplied
    ? `${prsInWindow.length}/${supplied.length} supplied PR(s) hydrated`
    : `${prsInWindow.length} PR(s) in window`;
  console.log(`[prefetch-prs] ${repo}: ${source}, ${withFiles} with files → prsInWindow`);
}
