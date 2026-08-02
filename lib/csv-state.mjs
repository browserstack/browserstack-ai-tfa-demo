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

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Canonical state-file path for one build's run. Two invariants (D-temp):
 *   1. The BUILD ID IS IN THE FILENAME — runs over different builds can never
 *      collide/"resume" into each other's state.
 *   2. Default location is OS TEMP (`<tmpdir>/bstack-rca/`), not the invoking
 *      workspace — a background harness must not pollute the repo it runs from.
 * `stateDir` (config `paths.stateDir`) overrides the directory only — e.g. a CI
 * job that wants the CSV as a retained artifact. Resume-safety is per build:
 * same buildId → same path.
 */
export function csvPathFor(buildId, stateDir = "") {
  const safe = String(buildId ?? "").replace(/[^A-Za-z0-9._-]/g, "_") || "unknown-build";
  const dir = stateDir && String(stateDir).trim() !== "" ? String(stateDir) : join(tmpdir(), "bstack-rca");
  return join(dir, `rca-state.${safe}.csv`);
}

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
  // Both are part of the RCA_OUTPUT contract but had no column, so `flip`
  // silently discarded them — `view_rca` in particular is the dashboard link
  // the whole run exists to produce.
  "view_rca",
  "turns_used",
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
  // Normalise the HEADER, not just flip()'s field names. writeRows only ever
  // emits COLUMNS, so any header name we fail to recognise here is silently
  // dropped the next time the file is written. That is not theoretical: a
  // legacy 10-column state file (`test_id,test_name,…`) round-tripped through
  // flip() came back with test_id and test_name gone and cluster_id blanked,
  // reporting success the whole way. Losing which test a row describes is
  // worse than any error we could raise.
  const header = raw[0].map((c) => COLUMN_ALIASES.get(c) ?? c);
  const unknown = header.filter((c) => c && !COLUMNS.includes(c));
  if (unknown.length) {
    // Loud, and it names the columns — a foreign schema means this file was
    // written by a different version, and guessing an alignment for it would
    // reintroduce exactly the silent corruption above.
    throw new Error(
      `[csv-state] ${csvPath} has ${unknown.length} unrecognised column(s): ${unknown.join(", ")}. ` +
        `This file was written by a different schema version; writing it back would DROP those columns. ` +
        `Re-seed the build instead of resuming this file.`,
    );
  }
  return raw.slice(1).map((cells) => {
    const row = {};
    header.forEach((col, idx) => {
      row[col] = cells[idx] ?? "";
    });
    return row;
  });
}

// Owner-only (0700 dir / 0600 file): the state CSV lives in a world-readable
// OS temp dir and records root causes, culprit PRs and evidence digests.
export function writeRows(csvPath, rows) {
  const dir = dirname(csvPath);
  // `mode` applies on CREATE only — the same trap already fixed for the files
  // themselves. A directory made before hardening stays 0755 forever, which on
  // a shared machine leaves root causes, culprit PRs and log excerpts readable
  // by every local user. Tighten an existing one too.
  if (dir) ensureOwnerOnlyDir(dir);
  const existed = existsSync(csvPath);
  writeFileSync(csvPath, encodeRows(rows), { encoding: "utf8", mode: 0o600 });
  // `mode` applies on create only — tighten a pre-hardening leftover too.
  if (existed) chmodSync(csvPath, 0o600);
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
// The RCA_OUTPUT contract speaks `RESOLVED | PENDING | failed`, while the CSV
// stores `resolved | blocked | failed | pending-resume`. Callers naturally pass
// the vocabulary their own output block mandates, so accept it and translate
// rather than silently rejecting — a silent `false` here cost a whole batch of
// results, since the row simply stayed `pending` and looked un-run.
const FLIP_ALIASES = new Map([
  ["resolved", "resolved"],
  ["pending", RESUMABLE],
  ["pending-resume", RESUMABLE],
  ["blocked", "blocked"],
  ["failed", "failed"],
  ["done", "resolved"],
]);

// Column aliases for the same reason: the output block says `thread_id` and
// `status`, the CSV says `threadId` and `rca_done`.
const COLUMN_ALIASES = new Map([
  ["thread_id", "threadId"],
  ["turn_id", "turnId"],
  ["status", "rca_done"],
  ["test_run_id", "testRunId"],
]);

export function flip(csvPath, testRunId, fields, nowMs) {
  // Arity guard. `flip` is positional with csvPath FIRST, and a caller that
  // drops it — `flip(testRunId, fields)` — otherwise binds an object to
  // testRunId, reads a nonexistent CSV, and gets a bare `false` that is easy
  // to mistake for success. Name the mistake precisely instead.
  if (typeof csvPath !== "string" || (testRunId !== null && typeof testRunId === "object")) {
    console.warn(
      "[csv-state] flip called with the wrong arguments. Signature is " +
      "flip(csvPath, testRunId, fields, nowMs) — csvPath FIRST, e.g. " +
      "flip(csvPathFor(buildId), '3904695279', { status: 'RESOLVED', ... }, Date.now()). " +
      `Got csvPath=${JSON.stringify(csvPath)?.slice(0, 60)}, testRunId=${JSON.stringify(testRunId)?.slice(0, 60)}. Row NOT written.`,
    );
    return false;
  }
  // Enforce the contract: a flip must name a valid outcome. A partial flip with
  // a missing/non-terminal rca_done would otherwise clear the claim yet leave the
  // row `pending` — re-exposing it for a duplicate RCA that clobbers this result.
  // Reject without mutating so the worker keeps its claim and the bug surfaces.
  const raw = fields?.rca_done ?? fields?.status;
  const state = FLIP_ALIASES.get(String(raw ?? "").trim().toLowerCase());
  if (!state) {
    // Loud, not silent: the previous bare `false` was indistinguishable from
    // success to a caller that didn't check, and results were lost that way.
    console.warn(
      `[csv-state] flip REJECTED for testRunId=${testRunId}: rca_done=${JSON.stringify(raw)} ` +
      `is not one of ${[...new Set(FLIP_ALIASES.values())].join(" | ")} (case-insensitive). Row NOT written.`,
    );
    return false;
  }
  const rows = readRows(csvPath);
  const row = rows.find((r) => String(r.testRunId) === String(testRunId));
  if (!row) {
    console.warn(`[csv-state] flip REJECTED: no row for testRunId=${testRunId} in ${csvPath}`);
    return false;
  }
  const dropped = [];
  for (const [k0, v] of Object.entries(fields)) {
    const k = COLUMN_ALIASES.get(k0) ?? k0;
    if (COLUMNS.includes(k)) {
      row[k] = Array.isArray(v) ? v.join("; ") : (v ?? "");
    } else {
      dropped.push(k0);
    }
  }
  row.rca_done = state; // normalized, whatever spelling arrived
  if (dropped.length) {
    console.warn(`[csv-state] flip ignored unknown field(s) for ${testRunId}: ${dropped.join(", ")}`);
  }
  row.in_flight_worker = "";
  row.timestamp = String(nowMs);

  // A `pending-resume` row is a PROMISE that this thread can be picked up
  // again, and the resume path keeps that promise by calling
  // getTfaTurnResult(testRunId, turnId) BEFORE submitting anything new. TFA
  // returns a `turnId` only on a soft-`PENDING` turn — precisely the case that
  // produces this state — so a resumable row without one cannot be drained: the
  // resume would submit blind on a thread that still has an in-flight turn.
  //
  // Not an error, because losing the row entirely would be worse than resuming
  // imperfectly. But it must be loud: silently un-resumable rows look identical
  // to healthy ones in the CSV.
  if (state === RESUMABLE && !String(row.turnId ?? "").trim()) {
    console.warn(
      `[csv-state] testRunId=${testRunId} flipped to ${RESUMABLE} with NO turnId — ` +
        `resume cannot drain the in-flight turn and will submit blind. ` +
        `Capture turnId from the PENDING tfaRcaTurn response and pass it to flip().`,
    );
  }

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
