// Step 4b pre-dispatch registry (see skills/rca-build/SKILL.md Step 4b).
//
// Step 4b submits tfaRcaTurn's FIRST turn for every cluster representative
// directly from the orchestrator, in the same tool-call batch as Step 4's
// evidence pre-fetch — so the representative's turn 1 is already in flight
// (or already answered) by the time Step 5 would otherwise submit it fresh.
//
// A RESOLVED turn 1 needs no registry entry at all: the orchestrator flips
// that row straight to terminal in the CSV (lib/csv-state.mjs) and Step 5
// skips dispatching a coordinator for it entirely. Only the two non-terminal
// outcomes are recorded here, for Step 5 to hand to the representative's
// coordinator instead of letting it submit turn 1 again:
//   - PENDING     -> {threadId, turnId}   (drain via the existing `resume` input)
//   - NEEDS_INFO  -> {threadId, asks}     (new `turn1_result` input — see
//                     agents/ai-tfa-coordinator.md and lib/loop.mjs)
//
// Single-writer: only the Step 4b orchestrator pass ever writes this file (one
// process, one point in time, before any coordinator is dispatched). Step 5
// only reads it once per representative while building dispatch prompts, so —
// unlike the evidence file's per-coordinator shards — a plain read-modify-write
// is safe; there is no concurrent-writer race to design around here.
//
// Path convention mirrors csvPathFor/evidencePathFor exactly: build id in the
// filename, OS temp by default, `stateDir` overrides the directory only.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const safeName = (v, fallback) =>
  String(v ?? "").replace(/[^A-Za-z0-9._-]/g, "_") || fallback;

export function turn1PathFor(buildId, stateDir = "") {
  const safe = safeName(buildId, "unknown-build");
  const dir = stateDir && String(stateDir).trim() !== "" ? String(stateDir) : join(tmpdir(), "bstack-rca");
  return join(dir, `rca-turn1.${safe}.json`);
}

// Owner-only, on create AND on an existing directory — same rationale as
// csv-state.mjs / evidence-file.mjs: a directory made before this hardening
// landed keeps its 0755 forever, and this file carries thread ids and NEEDS_INFO
// ask text in a shared OS temp dir.
function ensureOwnerOnlyDir(dir) {
  if (!existsSync(dir)) { mkdirSync(dir, { recursive: true, mode: 0o700 }); return; }
  try { chmodSync(dir, 0o700); } catch { /* not ours to tighten; leave it */ }
}

function emptyRegistry(buildId, nowMs) {
  return { buildId: String(buildId ?? ""), generatedAtMs: nowMs, entries: {} };
}

function readDoc(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeDoc(filePath, doc) {
  const dir = dirname(filePath);
  if (dir) ensureOwnerOnlyDir(dir);
  const existed = existsSync(filePath);
  writeFileSync(filePath, JSON.stringify(doc, null, 2), { encoding: "utf8", mode: 0o600 });
  // `mode` is only honoured on create — tighten a pre-hardening leftover too.
  if (existed) chmodSync(filePath, 0o600);
}

/** Idempotent: creates the file with the given `buildId` if it doesn't exist
 * yet; leaves an existing file untouched otherwise (never clobbers prior
 * entries on a resume). */
export function initTurn1Registry(filePath, buildId, nowMs) {
  const existing = readDoc(filePath);
  if (existing) return existing;
  const doc = emptyRegistry(buildId, nowMs);
  writeDoc(filePath, doc);
  return doc;
}

/**
 * Record a representative's non-terminal turn-1 outcome.
 * `entry` shape: `{ threadId, turnId, status: "PENDING" | "NEEDS_INFO", asks, note }`.
 * `turnId` only applies to PENDING (per the tfaRcaTurn contract — RESOLVED and
 * NEEDS_INFO never carry one). `asks` only applies to NEEDS_INFO.
 * Read-modify-write against the whole file — safe because Step 4b is this
 * file's only writer.
 */
export function recordTurn1(filePath, testRunId, entry, nowMs) {
  const doc = readDoc(filePath) ?? emptyRegistry("unknown-build", nowMs);
  doc.entries[String(testRunId)] = { ...entry, submittedAtMs: nowMs };
  doc.generatedAtMs = nowMs;
  writeDoc(filePath, doc);
  return doc.entries[String(testRunId)];
}

/** This representative's pre-dispatched turn-1 outcome, or `null` if Step 4b
 * never ran for it (not clustered as a representative, resolved already and
 * flipped straight to the CSV, or the registry doesn't exist at all). */
export function readTurn1(filePath, testRunId) {
  const doc = readDoc(filePath);
  return doc?.entries?.[String(testRunId)] ?? null;
}

/** Every recorded entry, keyed by testRunId — used for run-end stats only. */
export function readAllTurn1(filePath) {
  return readDoc(filePath)?.entries ?? {};
}

