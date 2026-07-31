#!/usr/bin/env node
// Print the FOLDED evidence view: the orchestrator's base pre-fetch with every
// coordinator's contribution shard merged on top.
//
// Why this exists: coordinators are handed one path — the base file — and
// naturally read it with `cat`/`jq`. That shows base ONLY, so every
// contribution written by a sibling is invisible. A real run hit this: an
// agent reported "the file has 2 repos" when the folded view had 5, including
// the 11-PR observability-api entry a prior coordinator had contributed. The
// shard layout is what makes concurrent write-back safe, so the fix is to give
// the merged view its own command rather than to abandon shards.
//
// Usage:
//   node bin/evidence-show.mjs <evidenceFilePath>            # full folded JSON
//   node bin/evidence-show.mjs <evidenceFilePath> --summary  # one line per repo/workload
//   node bin/evidence-show.mjs <evidenceFilePath> --repo <name>

import { readEvidenceFile, readBaseFile, contribDirFor, hasTrustworthyPrList } from "../lib/evidence-file.mjs";
import { existsSync, readdirSync } from "node:fs";

const [, , filePath, mode, arg] = process.argv;
if (!filePath) {
  console.error("usage: evidence-show.mjs <evidenceFilePath> [--summary | --repo <name>]");
  process.exit(2);
}

const folded = readEvidenceFile(filePath);

if (mode === "--repo") {
  console.log(JSON.stringify(folded.github?.[arg] ?? null, null, 2));
  process.exit(0);
}

if (mode !== "--summary") {
  console.log(JSON.stringify(folded, null, 2));
  process.exit(0);
}

const base = readBaseFile(filePath);
const dir = contribDirFor(filePath);
const shards = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];

console.log(`build            : ${folded.buildId}`);
console.log(`base repos       : ${Object.keys(base.github ?? {}).length}`);
console.log(`contribution shards: ${shards.length} (${shards.map((s) => s.replace(".json", "")).join(", ") || "none"})`);
console.log("");
console.log("github (folded):");
for (const [repo, e] of Object.entries(folded.github ?? {})) {
  const prs = (e.prsInWindow ?? []).length;
  const trust = hasTrustworthyPrList(folded, repo) ? "trustworthy" : "PR LIST NOT TRUSTWORTHY (never searched)";
  console.log(`  ${repo}: ${prs} PR(s), deployState=${e.deployState ? "yes" : "no"}, gap=${e.gap ?? "none"} — ${trust}`);
}
console.log("");
console.log("logs (folded):");
for (const [wl, e] of Object.entries(folded.logs ?? {})) {
  const k = e.kubectlSweep?.gap ? "gapped" : e.kubectlSweep ? "present" : "absent";
  const v = e.victorialogs?.gap ? "gapped" : e.victorialogs ? "present" : "absent";
  console.log(`  ${wl}: kubectl=${k}, victorialogs=${v}, gap=${e.gap ?? "none"}`);
}
if (folded.coverage?.reposWithUntrustedPrList?.length) {
  console.log("");
  console.log(`WARNING untrusted PR lists: ${folded.coverage.reposWithUntrustedPrList.join(", ")}`);
  console.log("  an empty prsInWindow here does NOT mean 'no PRs' — search live before concluding.");
}
