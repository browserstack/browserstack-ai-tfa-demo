// Executable mirror of the ai-tfa-coordinator loop (agents/ai-tfa-coordinator.md).
// It drives the collaborative loop against an injected `submit` (real = the
// tfaRcaTurn MCP tool; tests = a recorded-turn replayer), so the loop mechanics —
// status branching, ask routing, gap degradation, turn-cap, one-thread,
// soft-PENDING — are tested rather than assumed.
//
// Double duty: this is ALSO the **sequential thin-client harness** — the third
// caller of the same contract, for MCP clients without workflows/subagents.
// Pure + dependency-light (imports only the routing registry).
//
// The loop is fully autonomous: an evidence gap ALWAYS degrades to an
// `unavailable` block back to TFA. There is no user-prompt path — the /rca-build
// gate closed before this loop ever runs.
//
// tfaRcaTurn returns TRIMMED terminal shapes:
//   RESOLVED   → { status, confidence, threadId,
//                  glimpse: { root_cause (≤220 chars), failure_type, related_prs },
//                  viewRca }
//   PENDING    → { status, turnId, threadId }            (soft-pending, resumable)
//   NEEDS_INFO → { status, questions/asks/suggestions }  (verbatim — the loop needs them)
//
// Soft-PENDING is NOT an agent verdict. It is the tfaRcaTurn util abandoning its
// own in-call poll at POLL_MAX_WAIT_MS (90s) while the agent keeps working
// server-side — observed routinely, e.g. a first turn that finalized NEEDS_INFO
// at 104s. So a PENDING is DRAINED here: read that same turnId via
// `readTurn` (the getTfaTurnResult MCP tool) until it lands a real agent status,
// and only then route asks and submit the next message. Re-submitting on a
// PENDING instead would stack a second turn on one still in flight.

import { routeAsks } from "./routing.mjs";

// Drain budget for one soft-PENDING. Bounded so a wedged turn can never hang the
// batch — on exhaustion the loop still ends `PENDING` (resumable via the CSV's
// `pending-resume` row), which is the old behaviour as a floor, not a default.
const DEFAULT_DRAIN = { maxWaitMs: 600_000, intervalMs: 5_000, maxReads: 40 };

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A real agent verdict, i.e. anything the drain is allowed to stop on.
const isAgentStatus = (s) =>
  s === "RESOLVED" || s === "NEEDS_INFO" || s === "BLOCKED";

function unavailableBlock(gap) {
  const what = gap?.ask?.what ?? "";
  return [
    `ASK: ${what}`,
    `TYPE: ${gap.evidenceType}`,
    `FOUND: no`,
    `SUMMARY: unavailable — no ${gap.capability} connector for this client.`,
  ].join("\n");
}

// drainSoftPending reads one in-flight turn to a real agent status.
//
// Reads do NOT consume the turn cap — a drain is the SAME turn being read again,
// not a new turn. `readTurn` is read-only and side-effect free, so the only
// budget that applies is wall clock / read count.
//
// Returns { turn, reads }: `turn` is the landed agent turn, or null if the drain
// budget ran out (caller then ends PENDING, resumable).
async function drainSoftPending({ testRunId, pending, readTurn, sleep, drain }) {
  const { maxWaitMs, intervalMs, maxReads } = { ...DEFAULT_DRAIN, ...(drain ?? {}) };
  const turnId = pending.turnId;
  let reads = 0;

  // No turnId → nothing addressable to read; no readTurn → client lacks the
  // getTfaTurnResult tool. Either way fall back to reporting it resumable.
  if (!turnId || typeof readTurn !== "function") return { turn: null, reads };

  const started = Date.now();
  while (reads < maxReads && Date.now() - started < maxWaitMs) {
    await sleep(intervalMs);
    reads++;
    let turn;
    try {
      turn = await readTurn({ testRunId, turnId });
    } catch {
      // A failed read is not a verdict — keep reading until the budget is spent.
      continue;
    }
    if (isAgentStatus(turn?.status)) return { turn, reads };
    // still PENDING → the agent is working; read again.
  }
  return { turn: null, reads };
}

// runRcaLoop drives one test to a terminal RCA_OUTPUT object.
//
//   submit({ testRunId, message, threadId, turnId }) → Promise<turn>   (tfaRcaTurn shape)
//   readTurn({ testRunId, turnId }) → Promise<turn>                    (getTfaTurnResult shape)
//   gather(routedGatherEntry) → Promise<string>                        (one digest block)
export async function runRcaLoop({
  testRunId,
  firstMessage = "",
  submit,
  readTurn,
  config = {},
  manifest = {},
  gather = async () => "",
  turnCap = config?.turnCap ?? 6,
  drain = config?.softPendingDrain,
  sleep = defaultSleep,
}) {
  if (testRunId == null || Number.isNaN(Number(testRunId))) {
    return {
      testRunId: String(testRunId),
      status: "failed",
      root_cause: "no testRunId provided",
      turns_used: 0,
      asks_fulfilled: [],
      asks_skipped: [],
      asks_unavailable: [],
    };
  }

  let threadId;
  let turnId;
  let turns = 0;
  let message = firstMessage;
  const fulfilled = new Set();
  const skipped = new Set();
  const unavailable = new Set();

  const out = (status, turn, note) => {
    const glimpse = turn?.glimpse ?? {};
    return {
      testRunId: String(testRunId),
      status,
      confidence: turn?.confidence ?? "unknown",
      root_cause: status === "RESOLVED" ? (glimpse.root_cause ?? "") : (note ?? ""),
      failure_type: glimpse.failure_type ?? "",
      related_prs: glimpse.related_prs ?? [],
      view_rca: turn?.viewRca ?? "",
      threadId: threadId ?? null,
      turnId: turnId ?? null,
      turns_used: turns,
      asks_fulfilled: [...fulfilled],
      asks_skipped: [...skipped],
      asks_unavailable: [...unavailable],
    };
  };

  while (true) {
    turns++;
    let turn = await submit({ testRunId, message, threadId, turnId });
    threadId = turn.threadId ?? threadId;

    // Soft-PENDING → the in-call poll capped out, not a verdict. Read the SAME
    // turnId to a real status BEFORE routing asks or submitting anything else.
    if (turn.status === "PENDING") {
      turnId = turn.turnId ?? turnId;
      const drained = await drainSoftPending({
        testRunId,
        pending: turn,
        readTurn,
        sleep,
        drain,
      });
      if (!drained.turn) {
        return out(
          "PENDING",
          turn,
          `soft-pending: still working after ${drained.reads} read(s)`,
        );
      }
      turn = drained.turn;
      threadId = turn.threadId ?? threadId;
      // Landed. This was never a new turn, so `turns` is unchanged and the
      // resume handle is spent — later submits go by threadId alone.
      turnId = undefined;
    }

    if (turn.status === "RESOLVED") return out("RESOLVED", turn);
    // BLOCKED is a terminal agent verdict: TFA cannot proceed. It carries no
    // asks, so treating it as NEEDS_INFO would resubmit empty messages to the
    // cap. Reported as PENDING (the output contract's non-resolved value) with
    // the reason in the note.
    if (turn.status === "BLOCKED") return out("PENDING", turn, "blocked");

    // NEEDS_INFO. Check the turn-cap BEFORE gathering — evidence assembled on a
    // turn we will never submit is wasted work (and a side-effecting gather()
    // would run for nothing).
    if (turns >= turnCap) return out("PENDING", turn, "turn-cap");

    // Route + fulfill. Gaps degrade to `unavailable` — never a user prompt.
    const buckets = routeAsks(turn.asks ?? [], config, manifest);
    const blocks = [];
    for (const s of buckets.skip) skipped.add(s.evidenceType);
    for (const g of buckets.gather) {
      blocks.push(await gather(g));
      fulfilled.add(g.evidenceType);
    }
    for (const gap of buckets.gap) {
      unavailable.add(gap.evidenceType);
      blocks.push(unavailableBlock(gap));
    }

    message = blocks.join("\n\n");
  }
}

// Replay helper for tests: returns a submit() that yields recorded turns in order.
export function replaySubmit(turns) {
  let i = 0;
  return async () => {
    const turn = turns[Math.min(i, turns.length - 1)];
    i++;
    return turn;
  };
}

// Replay helper for tests: a readTurn() that yields recorded getTfaTurnResult
// reads in order (typically N × PENDING then the landed agent turn).
export function replayRead(reads) {
  let i = 0;
  return async () => {
    const read = reads[Math.min(i, reads.length - 1)];
    i++;
    return read;
  };
}
