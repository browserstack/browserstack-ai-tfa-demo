// CSV write-ahead-log spine for the batch (D4 + ideation #7). The CSV is the
// single durable, resumable source of truth for "RCA over ALL failed tests":
// every test is a row, seeded `pending`, claimed by a worker, heartbeated while
// in flight, and flipped to a terminal state with its RCA. A reaper reclaims
// rows stranded by a crashed worker.
//
// Timestamps are passed in as `nowMs` (never read from the clock here) so this
// module is deterministic in tests AND usable from the auto-mode dynamic
// workflow, whose sandbox forbids Date.now().
//
// In-session / in-workspace only — cross-session durability is deferred. Writes
// are synchronous read-modify-write; Node's single thread serializes them, which
// is sufficient for the in-process 5-concurrent workflow (true multi-process
// locking is out of scope).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const COLUMNS = [
  "buildId",
  "testRunId",
  "testName",
  "failure_category",
  "error_summary",
  "file_path",
  "cluster_id",
  "rca_done",
  "in_flight_worker",
  "heartbeat_ts",
  "threadId",
  "turnId",
  "last_evidence_digest",
  "root_cause",
  "failure_type",
  "possible_fix",
  "related_prs",
  "coverage",
  "confidence",
  "timestamp",
];

export const PENDING = "pending";
export const RESUMABLE = "pending-resume";
// Truly done — never re-claimed, listed, or reaped.
const TERMINAL_STATES = new Set(["resolved", "blocked", "failed"]);
// Valid outcomes flip() may write. `pending-resume` is a *soft* terminal: this
// attempt ended (claim cleared) but the row stays resumable — it keeps its
// threadId/turnId and is picked back up by the next fan-out / resume pass.
const FLIP_STATES = new Set(["resolved", "blocked", "failed", RESUMABLE]);

// ---- minimal RFC4180-ish CSV codec ----------------------------------------

function encodeField(value) {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function encodeRows(rows) {
  const lines = [COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(COLUMNS.map((c) => encodeField(row[c])).join(","));
  }
  return lines.join("\n") + "\n";
}

function parseCsv(text) {
  const rows = [];
  let field = "";
  let record = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      rows.push(record);
      field = "";
      record = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    rows.push(record);
  }
  return rows;
}

// ---- read / write ----------------------------------------------------------

export function readRows(csvPath) {
  if (!existsSync(csvPath)) return [];
  const text = readFileSync(csvPath, "utf8");
  const raw = parseCsv(text).filter((r) => r.some((c) => c.length > 0));
  if (raw.length === 0) return [];
  const header = raw[0];
  return raw.slice(1).map((cells) => {
    const row = {};
    header.forEach((col, idx) => {
      row[col] = cells[idx] ?? "";
    });
    return row;
  });
}

export function writeRows(csvPath, rows) {
  const dir = dirname(csvPath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(csvPath, encodeRows(rows), "utf8");
}

function emptyRow() {
  return Object.fromEntries(COLUMNS.map((c) => [c, ""]));
}

// ---- operations -------------------------------------------------------------

// Seed the CSV from a listTestIds(failed, includeFailureDetail) payload. Every
// row starts `pending`. Idempotent: existing rows are preserved (terminal rows
// are never reset; signature columns are refreshed on still-pending rows). New
// tests are appended. Returns the full row set.
export function seed(csvPath, buildId, tests) {
  const existing = readRows(csvPath);
  const byId = new Map(existing.map((r) => [String(r.testRunId), r]));

  for (const t of tests) {
    const id = String(t.test_id ?? t.testRunId);
    const sig = t.failure ?? {};
    const prior = byId.get(id);
    if (prior) {
      // Keep terminal results; only refresh signature on still-pending rows.
      if (prior.rca_done === PENDING) {
        prior.failure_category = sig.category ?? prior.failure_category;
        prior.error_summary = sig.error_summary ?? prior.error_summary;
        prior.file_path = sig.file_path ?? prior.file_path;
      }
      continue;
    }
    const row = emptyRow();
    row.buildId = buildId;
    row.testRunId = id;
    row.testName = t.test_name ?? t.testName ?? `Test ${id}`;
    row.failure_category = sig.category ?? "";
    row.error_summary = sig.error_summary ?? "";
    row.file_path = sig.file_path ?? "";
    row.rca_done = PENDING;
    byId.set(id, row);
    existing.push(row);
  }

  writeRows(csvPath, existing);
  return existing;
}

// Claim a pending row for `worker`. Refuses (returns false) if another worker
// already owns it. Returns true on success.
export function claim(csvPath, testRunId, worker, nowMs) {
  const rows = readRows(csvPath);
  const row = rows.find((r) => String(r.testRunId) === String(testRunId));
  if (!row) return false;
  if (row.in_flight_worker && row.in_flight_worker !== worker) return false;
  if (TERMINAL_STATES.has(row.rca_done)) return false;
  row.in_flight_worker = worker;
  row.heartbeat_ts = String(nowMs);
  writeRows(csvPath, rows);
  return true;
}

export function heartbeat(csvPath, testRunId, worker, nowMs) {
  const rows = readRows(csvPath);
  const row = rows.find((r) => String(r.testRunId) === String(testRunId));
  if (!row || row.in_flight_worker !== worker) return false;
  row.heartbeat_ts = String(nowMs);
  writeRows(csvPath, rows);
  return true;
}

// Flip a row to a terminal state, recording the RCA fields and clearing the
// in-flight claim. `fields` carries any of: rca_done, root_cause, failure_type,
// possible_fix, related_prs, threadId, turnId, coverage, confidence,
// last_evidence_digest, cluster_id.
export function flip(csvPath, testRunId, fields, nowMs) {
  // Enforce the contract: a flip must name a valid outcome. A partial flip with
  // a missing/non-terminal rca_done would otherwise clear the claim yet leave the
  // row `pending` — re-exposing it for a duplicate RCA that clobbers this result.
  // Reject without mutating so the worker keeps its claim and the bug surfaces.
  if (!FLIP_STATES.has(fields?.rca_done)) return false;
  const rows = readRows(csvPath);
  const row = rows.find((r) => String(r.testRunId) === String(testRunId));
  if (!row) return false;
  for (const [k, v] of Object.entries(fields)) {
    if (COLUMNS.includes(k)) {
      row[k] = Array.isArray(v) ? v.join("; ") : (v ?? "");
    }
  }
  row.in_flight_worker = "";
  row.timestamp = String(nowMs);
  writeRows(csvPath, rows);
  return true;
}

// Reclaim rows stranded in flight (heartbeat older than ttlSec) back to pending.
// Returns the testRunIds reclaimed. Run on startup before resuming a batch.
export function reaper(csvPath, ttlSec, nowMs) {
  const rows = readRows(csvPath);
  const reclaimed = [];
  for (const row of rows) {
    if (!row.in_flight_worker) continue;
    if (TERMINAL_STATES.has(row.rca_done)) continue;
    const hb = Number(row.heartbeat_ts);
    const stale = !row.heartbeat_ts || nowMs - hb > ttlSec * 1000;
    if (stale) {
      row.in_flight_worker = "";
      row.rca_done = PENDING;
      reclaimed.push(String(row.testRunId));
    }
  }
  if (reclaimed.length > 0) writeRows(csvPath, rows);
  return reclaimed;
}

// Rows still needing work: fresh/reclaimed `pending` AND `pending-resume` rows
// (soft-PENDING attempts that retain a threadId/turnId to resume). The fan-out
// work-list. Truly terminal rows (resolved/blocked/failed) are excluded.
export function pendingRows(csvPath) {
  return readRows(csvPath).filter(
    (r) => r.rca_done === PENDING || r.rca_done === RESUMABLE,
  );
}
