// Executable mirror of the ai-tfa-coordinator loop (agents/ai-tfa-coordinator.md).
// It drives the collaborative loop against an injected `submit` (real = the
// tfaRcaTurn MCP tool; tests = a recorded-turn replayer), so the loop mechanics —
// status branching, ask routing, gap resolution, turn-cap, one-thread,
// soft-PENDING — are tested rather than assumed.
//
// Double duty: this is ALSO the **sequential thin-client harness** (D5 / ideation
// #4) — the third caller of the same contract, for MCP clients without
// workflows/subagents. Pure + dependency-light (imports only the routing registry).

import { routeAsks } from "./routing.mjs";

function unavailableBlock(gap) {
  const what = gap?.ask?.what ?? "";
  return [
    `ASK: ${what}`,
    `TYPE: ${gap.evidenceType}`,
    `FOUND: no`,
    `SUMMARY: unavailable — no ${gap.capability} capability for this client.`,
  ].join("\n");
}

// runRcaLoop drives one test to a terminal RCA_OUTPUT object.
//
//   submit({ testRunId, message, threadId, turnId }) → Promise<turn>   (tfaRcaTurn shape)
//   gather(routedGatherEntry) → Promise<string>                        (one digest block)
//   resolveGap(routedGapEntry) → Promise<{ digest } | null>            (auto: null; interactive: a digest)
export async function runRcaLoop({
  testRunId,
  firstMessage = "",
  submit,
  config = {},
  manifest = {},
  gather = async () => "",
  resolveGap = async () => null,
  turnCap = config?.turnCap ?? 6,
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
    const rca = turn?.rca ?? {};
    return {
      testRunId: String(testRunId),
      status,
      confidence: turn?.confidence ?? "unknown",
      root_cause:
        status === "RESOLVED"
          ? (rca.root_cause ?? "")
          : status === "BLOCKED"
            ? (turn?.reason ?? "")
            : (note ?? ""),
      possible_fix: rca.possible_fix ?? "",
      related_prs: rca.related_prs ?? [],
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
    const turn = await submit({ testRunId, message, threadId, turnId });
    threadId = turn.threadId ?? threadId;

    if (turn.status === "RESOLVED") return out("RESOLVED", turn);
    if (turn.status === "BLOCKED") return out("BLOCKED", turn);
    if (turn.status === "PENDING") {
      turnId = turn.turnId ?? turnId;
      return out("PENDING", turn, "soft-pending");
    }

    // NEEDS_INFO. Check the turn-cap BEFORE gathering — evidence assembled on a
    // turn we will never submit is wasted work (and a side-effecting gather()
    // would run for nothing).
    if (turns >= turnCap) return out("PENDING", turn, "turn-cap");

    // Route + fulfill.
    const buckets = routeAsks(turn.asks ?? [], config, manifest);
    const blocks = [];
    for (const s of buckets.skip) skipped.add(s.evidenceType);
    for (const g of buckets.gather) {
      blocks.push(await gather(g));
      fulfilled.add(g.evidenceType);
    }
    for (const gap of buckets.gap) {
      const resolved = await resolveGap(gap);
      if (resolved && resolved.digest) {
        blocks.push(resolved.digest);
        fulfilled.add(gap.evidenceType);
      } else {
        unavailable.add(gap.evidenceType);
        blocks.push(unavailableBlock(gap));
      }
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
