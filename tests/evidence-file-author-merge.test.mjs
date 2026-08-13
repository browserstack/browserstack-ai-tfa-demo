import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readEvidenceFile,
  writeEvidenceFile,
  contributeGithubEvidence,
  initEvidenceFile,
} from "../lib/evidence-file.mjs";

let dir;
let file;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rca-ev-author-"));
  file = join(dir, "evidence.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("foldGithub: author preserved when later shard lacks it (FR-5)", () => {
  // Base has author.
  initEvidenceFile(file, "b1", 1000);
  const base = readEvidenceFile(file);
  base.github = { "org/repo": { prsInWindow: [{ pr: 42, title: "fix", author: "alice" }] } };
  writeEvidenceFile(file, base);

  // Shard overwrites same PR without author.
  contributeGithubEvidence(file, "writer1", "org/repo", {
    prsInWindow: [{ pr: 42, title: "fix v2" }],
  }, 2000);

  const folded = readEvidenceFile(file);
  const pr = folded.github["org/repo"].prsInWindow.find((p) => String(p.pr) === "42");
  assert.equal(pr.author, "alice", "author from base should survive shard without author");
  assert.equal(pr.title, "fix v2", "later shard's non-null title wins");
});

test("foldGithub: author from shard preserved when base lacks it (FR-5)", () => {
  initEvidenceFile(file, "b1", 1000);
  const base = readEvidenceFile(file);
  base.github = { "org/repo": { prsInWindow: [{ pr: 42, title: "fix" }] } };
  writeEvidenceFile(file, base);

  contributeGithubEvidence(file, "writer1", "org/repo", {
    prsInWindow: [{ pr: 42, author: "bob" }],
  }, 2000);

  const folded = readEvidenceFile(file);
  const pr = folded.github["org/repo"].prsInWindow.find((p) => String(p.pr) === "42");
  assert.equal(pr.author, "bob");
  assert.equal(pr.title, "fix", "base title preserved when shard lacks it");
});

test("foldGithub: author null when absent from all shards (FR-6)", () => {
  initEvidenceFile(file, "b1", 1000);
  const base = readEvidenceFile(file);
  base.github = { "org/repo": { prsInWindow: [{ pr: 42, title: "fix" }] } };
  writeEvidenceFile(file, base);

  contributeGithubEvidence(file, "writer1", "org/repo", {
    prsInWindow: [{ pr: 42, title: "fix updated" }],
  }, 2000);

  const folded = readEvidenceFile(file);
  const pr = folded.github["org/repo"].prsInWindow.find((p) => String(p.pr) === "42");
  assert.equal(pr.author, undefined); // neither shard had author
});

test("foldGithub: workingBranch set at base survives a shard that omits it", () => {
  initEvidenceFile(file, "b1", 1000);
  const base = readEvidenceFile(file);
  base.github = { "org/repo": { workingBranch: "regression_run", prsInWindow: [] } };
  writeEvidenceFile(file, base);

  contributeGithubEvidence(file, "writer1", "org/repo", {
    prsInWindow: [{ pr: 42, baseRefName: "regression_run" }],
  }, 2000);

  const folded = readEvidenceFile(file);
  assert.equal(folded.github["org/repo"].workingBranch, "regression_run");
});
