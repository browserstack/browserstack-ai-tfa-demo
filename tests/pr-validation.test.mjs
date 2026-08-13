import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSuspectPR, validateAndDeduplicatePRs } from "../lib/pr-validation.mjs";

// --- validateSuspectPR ---

test("validateSuspectPR: valid PR in evidence with merged_at before started_at", () => {
  const entry = { owner: "org", repo: "app", number: 42, merged_at: "2026-08-01T10:00:00Z" };
  const doc = {
    github: { "org/app": { prsInWindow: [{ pr: 42, title: "fix", mergedAt: "2026-08-01T10:00:00Z" }] } },
    suspectWindow: { startedAt: "2026-08-02T00:00:00Z" },
  };
  assert.deepStrictEqual(validateSuspectPR(entry, doc), { valid: true });
});

test("validateSuspectPR: PR not in evidence returns not-in-evidence", () => {
  const entry = { owner: "org", repo: "app", number: 999 };
  const doc = {
    github: { "org/app": { prsInWindow: [{ pr: 42 }] } },
    suspectWindow: { startedAt: "2026-08-02T00:00:00Z" },
  };
  assert.deepStrictEqual(validateSuspectPR(entry, doc), { valid: false, reason: "not-in-evidence" });
});

test("validateSuspectPR: PR merged after started_at returns shipped-after", () => {
  const entry = { owner: "org", repo: "app", number: 42, merged_at: "2026-08-03T00:00:00Z" };
  const doc = {
    github: { "org/app": { prsInWindow: [{ pr: 42 }] } },
    suspectWindow: { startedAt: "2026-08-02T00:00:00Z" },
  };
  assert.deepStrictEqual(validateSuspectPR(entry, doc), { valid: false, reason: "shipped-after" });
});

test("validateSuspectPR: owner/repo extracted from link when fields absent", () => {
  const entry = { link: "https://github.com/org/app/pull/42", number: 42 };
  const doc = {
    github: { "org/app": { prsInWindow: [{ pr: 42 }] } },
    suspectWindow: { startedAt: "2026-08-10T00:00:00Z" },
  };
  assert.deepStrictEqual(validateSuspectPR(entry, doc), { valid: true });
});

test("validateSuspectPR: missing startedAt skips window check (valid)", () => {
  const entry = { owner: "org", repo: "app", number: 42 };
  const doc = {
    github: { "org/app": { prsInWindow: [{ pr: 42 }] } },
    suspectWindow: {},
  };
  assert.deepStrictEqual(validateSuspectPR(entry, doc), { valid: true });
});

test("validateSuspectPR: no repo key at all returns not-in-evidence", () => {
  const entry = { number: 42 };
  const doc = { github: {}, suspectWindow: {} };
  assert.deepStrictEqual(validateSuspectPR(entry, doc), { valid: false, reason: "not-in-evidence" });
});

test("validateSuspectPR: repo in evidence but empty prsInWindow returns not-in-evidence", () => {
  const entry = { owner: "org", repo: "app", number: 42 };
  const doc = {
    github: { "org/app": { prsInWindow: [] } },
    suspectWindow: { startedAt: "2026-08-02T00:00:00Z" },
  };
  assert.deepStrictEqual(validateSuspectPR(entry, doc), { valid: false, reason: "not-in-evidence" });
});

test("validateSuspectPR: PR number with # prefix matches", () => {
  const entry = { owner: "org", repo: "app", number: "#42" };
  const doc = {
    github: { "org/app": { prsInWindow: [{ pr: "42" }] } },
    suspectWindow: { startedAt: "2026-08-10T00:00:00Z" },
  };
  assert.deepStrictEqual(validateSuspectPR(entry, doc), { valid: true });
});

test("validateSuspectPR: uses mergedAt from evidence when entry lacks merged_at", () => {
  const entry = { owner: "org", repo: "app", number: 42 };
  const doc = {
    github: { "org/app": { prsInWindow: [{ pr: 42, mergedAt: "2026-08-03T00:00:00Z" }] } },
    suspectWindow: { startedAt: "2026-08-02T00:00:00Z" },
  };
  assert.deepStrictEqual(validateSuspectPR(entry, doc), { valid: false, reason: "shipped-after" });
});

// --- validateAndDeduplicatePRs ---

test("validateAndDeduplicatePRs: deduplicates by repo+number, enriches from evidence", () => {
  const prs = [
    { owner: "org", repo: "app", number: 42, title: "wrong title", verdict: "supported" },
    { owner: "org", repo: "app", number: 42, title: "also wrong" },
  ];
  const doc = {
    github: { "org/app": { prsInWindow: [{ pr: 42, title: "correct title", author: "alice" }] } },
    suspectWindow: { startedAt: "2026-08-10T00:00:00Z" },
  };
  const result = validateAndDeduplicatePRs(prs, doc);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "correct title");
  assert.equal(result[0].author, "alice");
});

test("validateAndDeduplicatePRs: invalid entry is ruled-out, not dropped", () => {
  const prs = [
    { owner: "org", repo: "app", number: 999, verdict: "supported" },
    { owner: "org", repo: "app", number: 42, verdict: "supported" },
  ];
  const doc = {
    github: { "org/app": { prsInWindow: [{ pr: 42 }] } },
    suspectWindow: { startedAt: "2026-08-10T00:00:00Z" },
  };
  const result = validateAndDeduplicatePRs(prs, doc);
  assert.equal(result.length, 2);
  assert.equal(result[0].verdict, "ruled-out (not-in-evidence)");
  assert.equal(result[1].number, 42);
});

test("validateAndDeduplicatePRs: empty input returns empty", () => {
  assert.deepStrictEqual(validateAndDeduplicatePRs([], {}), []);
  assert.deepStrictEqual(validateAndDeduplicatePRs(null, {}), []);
});

test("validateAndDeduplicatePRs: shipped-after verdict", () => {
  const prs = [{ owner: "org", repo: "app", number: 42, merged_at: "2026-08-05T00:00:00Z", verdict: "supported" }];
  const doc = {
    github: { "org/app": { prsInWindow: [{ pr: 42 }] } },
    suspectWindow: { startedAt: "2026-08-02T00:00:00Z" },
  };
  const result = validateAndDeduplicatePRs(prs, doc);
  assert.equal(result.length, 1);
  assert.equal(result[0].verdict, "ruled-out (shipped-after)");
});
