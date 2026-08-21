export const meta = {
  name: "rca-batch",
  description:
    "Drive autonomous collaborative RCA over all failed tests of a build: cluster representatives run the full loop, siblings one-turn-confirm, ~5 concurrent. Never prompts a user.",
  phases: [
    { title: "Representatives", detail: "full multi-turn RCA per cluster" },
    { title: "Siblings", detail: "one-turn confirm against own logs" },
  ],
};

// The /rca-build batch orchestration (fully autonomous — the gate closed before
// this runs; nothing here ever asks the user). This is a dynamic-workflow
// script: it runs in the Workflow sandbox (no filesystem, no Date.now/
// Math.random, agent()/pipeline() as globals). It therefore does NO state I/O
// itself — the orchestrator seeds the CSV, clusters, and builds the validated
// manifest at the gate and passes the work-list via `args`; each dispatched
// `ai-tfa-coordinator` agent (which HAS tool access) claims + flips its own CSV
// row eagerly (WAL); this script orchestrates concurrency and returns the
// structured results for reconciliation. The final glimpse + triggerRcaReport
// step happens back in the orchestrator (SKILL.md Step 6).
//
// args shape:
// {
//   csvPath, buildId,
//   manifest: { capability: { available, via } },
//   evidenceFilePath,                                     // lib/evidence-file.mjs artifact for this build
//   pluginRoot,                                           // absolute path to this plugin, so coordinators can call bin/cached-exec.mjs
//   buildEvidence: { baselineRef, isFallback, suspectWindow, reposCovered, workloadsCovered, gaps },
//     // ^ SHRUNK to a cheap summary/pointer only — the full PR list / log
//     //   sweeps live in the file at evidenceFilePath, read via each
//     //   coordinator's own Read tool. Repeating the full detail in every
//     //   dispatch prompt (as before) is exactly the duplication this file
//     //   removes.
//   clusters: [
//     { cluster_id,
//       representative: { testRunId, testName, error_summary,
//         // Step 4b pre-dispatch outcome (SKILL.md Step 4b, lib/turn1-registry.mjs)
//         // — at most one of these two is set, never both:
//         turn1: { status: "PENDING", threadId, turnId } |
//                { status: "NEEDS_INFO", threadId, asks },
//         // Step 4b's turn 1 already RESOLVED — no dispatch at all for this
//         // representative; `resolved` is the RCA_SCHEMA-shaped result to use
//         // directly (also already flipped into the CSV by the orchestrator).
//         resolved: <RCA_SCHEMA object> | undefined },
//       siblings: [ { testRunId, testName, error_summary } ] }
//   ]
// }

const RCA_SCHEMA = {
  type: "object",
  required: ["testRunId", "status"],
  properties: {
    testRunId: { type: "string" },
    status: { enum: ["RESOLVED", "PENDING", "failed"] },
    confidence: { enum: ["high", "medium", "low", "unknown"] },
    root_cause: { type: "string" },
    failure_type: { type: "string" },
    view_rca: { type: "string" },
    related_prs: { type: "array", items: { type: "string" } },
    suspect_signals: { type: "array", items: { type: "string" } },
    threadId: { type: "string" },
    turnId: { type: "string" },
    turns_used: { type: "number" },
    asks_fulfilled: { type: "array", items: { type: "string" } },
    asks_skipped: { type: "array", items: { type: "string" } },
    asks_unavailable: { type: "array", items: { type: "string" } },
    cluster_id: { type: "string" },
  },
  additionalProperties: true,
};

const ctx = (typeof args === "string" ? JSON.parse(args) : args) ?? {};
const clusters = ctx.clusters ?? [];
const shared = [
  `CSV state file: ${ctx.csvPath}`,
  `Capability manifest: ${JSON.stringify(ctx.manifest ?? {})}`,
  `Pre-fetched build-evidence file — READ THIS FIRST (via the Read tool) before making ANY live github/infra/logs gather call: ${ctx.evidenceFilePath}`,
  `Build-evidence summary (full detail is in the file above; this is only a pointer — do not re-fetch what the file already covers): ${JSON.stringify(ctx.buildEvidence ?? {})}`,
  `If the file's github/logs sections do not name a repo/workload/ask you need, or record a "gap" for it, that is a genuine gap — fall back to a live gather via the capability manifest above exactly as if no file existed. The file is an optimization, never a hard dependency.`,
  `The file is read-write: after any live gather that fills a gap or goes deeper than what was there, write it back via contributeCodeEvidence/contributeLogsEvidence (lib/evidence-file.mjs) passing your own testRunId as writerId, before finishing this test — so a sibling dispatched after you, or another cluster sharing the same repo/workload, reads the enriched entry instead of re-fetching it. Each writer owns its own shard file, so concurrent coordinators cannot clobber each other; readers fold base + shards automatically.`,
  `Tool cache — route read-only lookups through it so duplicate calls across coordinators become hits. Shell: node ${ctx.pluginRoot ?? "<pluginRoot>"}/bin/cached-exec.mjs <buildId> <yourTestRunId> '<gh|kubectl|curl|git command>' (behaves like the raw command; pipe to jq/grep OUTSIDE the wrapper so different filters share one fetch). MCP data queries: cached-mcp.mjs <buildId> get|put <tool> '<argsJson>' [writerId]. NEVER cache tfaRcaTurn/getTfaTurnResult/triggerRcaReport — they are stateful. Do not re-probe connectors the gate already validated.`,
  `Autonomous run — on an evidence gap with no valid connector, report "unavailable" back to TFA (NEVER prompt a user). Best-effort finalize.`,
  `PRODUCT_BUG / application-bug mandate: hunt the culprit PR via the github connector (deploy timeline vs last-pass window, changed paths vs failure signature) and feed the PR link(s) to TFA so related_prs populates. No PR after digging to the turn cap → state explicitly "no culprit PR identified after <what was searched>" so the CSV row records the gap.`,
  `Soft-PENDING is NOT an answer: tfaRcaTurn abandons its in-call poll at 90s while TFA keeps working. On status PENDING, call getTfaTurnResult(testRunId, turnId) FIRST and keep reading on the softPendingDrain budget (every 5s, <=40 reads / <=10min) until the status is RESOLVED / NEEDS_INFO / BLOCKED, then continue the loop. Reads do NOT count against the turn cap. Never submit a new message onto a turn still in flight. Only a fully spent drain budget ends the test PENDING.`,
  `Persist eagerly to the CSV: claim your row before turn 1, flip it on terminal (lib/csv-state.mjs).`,
].join("\n");

function resumeLine(row) {
  if (!row?.threadId || !row?.turnId) return null;
  return [
    `RESUME (do not start a new thread): this test already has an in-flight thread`,
    `threadId=${row.threadId} turnId=${row.turnId}.`,
    `Call getTfaTurnResult(testRunId, turnId) FIRST to read its current state`,
    `(drain any soft-PENDING per the softPendingDrain budget) before submitting`,
    `anything further — reuse this threadId for every follow-up on this test.`,
    row.last_evidence_digest ? `Prior evidence already gathered (reuse, don't re-fetch): ${row.last_evidence_digest}` : null,
    row.root_cause ? `Prior attempt note: ${row.root_cause}` : null,
  ].filter(Boolean).join("\n");
}

// Step 4b (SKILL.md Step 4b) already submitted this representative's turn 1,
// concurrently with Step 4's evidence pre-fetch. RESOLVED needs no coordinator
// dispatch at all (short-circuited in the pipeline stage below); these two
// non-terminal outcomes are handed to the coordinator instead of letting it
// submit turn 1 again — mutually exclusive per agents/ai-tfa-coordinator.md.
function turn1Line(r) {
  const t = r?.turn1;
  if (!t) return null;
  if (t.status === "PENDING" && t.turnId) {
    return [
      `RESUME (turn 1 already submitted by Step 4b — do not start a new thread):`,
      `threadId=${t.threadId} turnId=${t.turnId}.`,
      `Call getTfaTurnResult(testRunId, turnId) FIRST to read its current state`,
      `(drain any soft-PENDING per the softPendingDrain budget) before submitting`,
      `anything further — reuse this threadId for every follow-up on this test.`,
    ].join("\n");
  }
  if (t.status === "NEEDS_INFO") {
    return [
      `TURN 1 ALREADY SUBMITTED AND ANSWERED by Step 4b — do NOT submit turn 1 again.`,
      `threadId=${t.threadId}. turns_used starts at 1.`,
      `TFA's turn-1 response was NEEDS_INFO with these asks (verbatim): ${JSON.stringify(t.asks ?? [])}`,
      `Start this run at the ROUTE-the-asks step using them, then submit your first`,
      `follow-up message on this SAME thread.`,
    ].join("\n");
  }
  return null;
}

function repPrompt(cluster) {
  const r = cluster.representative;
  const resume = resumeLine(r);
  // Mutual exclusivity, enforced in code, not just by convention: a
  // representative gets AT MOST one resume-style instruction. A prior-run CSV
  // pending-resume (`r.threadId`/`r.turnId`, an already in-flight thread from
  // a run this build is resuming) takes precedence over a same-run Step 4b
  // entry (`r.turn1`) — Step 4b's pre-dispatch is supposed to skip a
  // representative already in pending-resume (SKILL.md Step 4b), but this is
  // the backstop: presenting BOTH would hand the coordinator two different
  // threadIds as "the" thread to resume, which is worse than picking one.
  const t1 = resume ? null : turn1Line(r);
  return [
    `You are the ai-tfa-coordinator for cluster ${cluster.cluster_id}.`,
    t1
      ? `Turn 1 was pre-dispatched by Step 4b — see below for how to resume it. Otherwise run the FULL collaborative RCA loop for the representative test.`
      : `Run the FULL collaborative RCA loop for the representative test.`,
    `testRunId=${r.testRunId}  testName=${r.testName ?? ""}`,
    `error_digest: ${r.error_summary ?? "(none)"}`,
    resume,
    t1,
    shared,
    `Return the structured RCA_OUTPUT for this test.`,
  ].filter(Boolean).join("\n");
}

function siblingPrompt(sibling, repResult, cluster) {
  return [
    `You are the ai-tfa-coordinator for a SIBLING of cluster ${cluster.cluster_id}.`,
    `Pre-seed: the representative resolved as:`,
    `  root_cause: ${repResult?.root_cause ?? "(representative did not resolve)"}`,
    `  related_prs: ${JSON.stringify(repResult?.related_prs ?? [])}`,
    `State this hypothesis on turn 1 and ask TFA to CONFIRM it against THIS test's own logs.`,
    `The pre-fetched evidence file's data about your OWN workload is real evidence about YOUR OWN test — reading it is NOT blind inheritance. What must stay independent is the CONFIRMATION judgment: never adopt the representative's verdict just because the file already has the answer in it.`,
    `If TFA confirms in one turn → done. If it does NOT (NEEDS_INFO), fall back to the full loop — never blindly inherit.`,
    `testRunId=${sibling.testRunId}  testName=${sibling.testName ?? ""}`,
    `error_digest: ${sibling.error_summary ?? "(none)"}`,
    resumeLine(sibling),
    shared,
    `Return the structured RCA_OUTPUT for this test.`,
  ].filter(Boolean).join("\n");
}

log(`Batch: ${clusters.length} cluster(s) over build ${ctx.buildId ?? "?"}`);

// Pipeline: each cluster flows representative → siblings independently (no barrier
// between stages), so a small cluster's siblings confirm while a big cluster's
// representative is still looping. Parallelism on this path is capped by the
// Workflow runtime itself (a machine-dependent limit), not by config.concurrency
// — the runtime queues anything beyond its own cap regardless of the JSON value.
const results = await pipeline(
  clusters,
  (cluster) =>
    // Step 4b's turn 1 already RESOLVED this representative — no dispatch at
    // all, zero added latency. The orchestrator already flipped this row's
    // CSV entry to terminal; `resolved` just needs to flow into the sibling
    // stage's pre_seed the same way a dispatched rep's result would.
    cluster.representative?.resolved
      ? Promise.resolve({ cluster, rca: cluster.representative.resolved })
      : agent(repPrompt(cluster), {
          label: `rep:${cluster.representative.testRunId}`,
          phase: "Representatives",
          agentType: "tfa-rca:ai-tfa-coordinator",
          schema: RCA_SCHEMA,
        }).then((rca) => ({ cluster, rca })),
  ({ cluster, rca }) =>
    parallel(
      (cluster.siblings ?? []).map((sib) => () =>
        agent(siblingPrompt(sib, rca, cluster), {
          label: `sib:${sib.testRunId}`,
          phase: "Siblings",
          agentType: "tfa-rca:ai-tfa-coordinator",
          schema: RCA_SCHEMA,
        }),
      ),
    ).then((sibs) => ({
      cluster_id: cluster.cluster_id,
      representative: rca,
      siblings: sibs.filter(Boolean),
    })),
);

const flat = results.filter(Boolean);
const all = flat.flatMap((r) => [r.representative, ...(r.siblings ?? [])]).filter(Boolean);
const byStatus = all.reduce((acc, r) => {
  acc[r.status] = (acc[r.status] ?? 0) + 1;
  return acc;
}, {});

log(`Batch complete: ${all.length} test(s) — ${JSON.stringify(byStatus)}`);

return { clusters: flat.length, tests: all.length, byStatus, results: flat };
