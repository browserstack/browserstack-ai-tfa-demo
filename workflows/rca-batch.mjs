export const meta = {
  name: "rca-batch",
  description:
    "Drive collaborative RCA over all failed tests of a build (auto mode): cluster representatives run the full loop, siblings one-turn-confirm, ~5 concurrent.",
  phases: [
    { title: "Representatives", detail: "full multi-turn RCA per cluster" },
    { title: "Siblings", detail: "one-turn confirm against own logs" },
  ],
};

// AUTO MODE orchestration (D2). This is a dynamic-workflow script: it runs in the
// Workflow sandbox (no filesystem, no Date.now/Math.random, agent()/pipeline()
// as globals). It therefore does NO state I/O itself — the orchestrator seeds the
// CSV, clusters, and builds the manifest in normal context and passes the
// work-list via `args`; each dispatched `ai-tfa-coordinator` agent (which HAS
// tool access) claims + flips its own CSV row eagerly (WAL); this script
// orchestrates concurrency and returns the structured results for reconciliation.
//
// args shape:
// {
//   csvPath, buildId, mode: "auto",
//   manifest: { capability: { available, via } },
//   buildEvidence: { baselineRef, suspectWindow, ... },   // pre-computed once
//   clusters: [
//     { cluster_id, representative: { testRunId, testName, error_summary },
//       siblings: [ { testRunId, testName, error_summary } ] }
//   ]
// }

const RCA_SCHEMA = {
  type: "object",
  required: ["testRunId", "status"],
  properties: {
    testRunId: { type: "string" },
    status: { enum: ["RESOLVED", "BLOCKED", "PENDING", "failed"] },
    confidence: { enum: ["high", "medium", "low", "unknown"] },
    root_cause: { type: "string" },
    possible_fix: { type: "string" },
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

const ctx = args ?? {};
const clusters = ctx.clusters ?? [];
const shared = [
  `CSV state file: ${ctx.csvPath}`,
  `Capability manifest: ${JSON.stringify(ctx.manifest ?? {})}`,
  `Build-level evidence (pre-computed once, reuse — do not re-fetch): ${JSON.stringify(ctx.buildEvidence ?? {})}`,
  `Mode: auto — on an evidence gap with no capability, report "unavailable" back to TFA (NEVER prompt a user). Best-effort finalize.`,
  `Persist eagerly to the CSV: claim your row before turn 1, flip it on terminal (lib/csv-state.mjs).`,
].join("\n");

function repPrompt(cluster) {
  const r = cluster.representative;
  return [
    `You are the ai-tfa-coordinator for cluster ${cluster.cluster_id}.`,
    `Run the FULL collaborative RCA loop for the representative test.`,
    `testRunId=${r.testRunId}  testName=${r.testName ?? ""}`,
    `error_digest: ${r.error_summary ?? "(none)"}`,
    shared,
    `Return the structured RCA_OUTPUT for this test.`,
  ].join("\n");
}

function siblingPrompt(sibling, repResult, cluster) {
  return [
    `You are the ai-tfa-coordinator for a SIBLING of cluster ${cluster.cluster_id}.`,
    `Pre-seed: the representative resolved as:`,
    `  root_cause: ${repResult?.root_cause ?? "(representative did not resolve)"}`,
    `  related_prs: ${JSON.stringify(repResult?.related_prs ?? [])}`,
    `State this hypothesis on turn 1 and ask TFA to CONFIRM it against THIS test's own logs.`,
    `If TFA confirms in one turn → done. If it does NOT (NEEDS_INFO/BLOCKED), fall back to the full loop — never blindly inherit.`,
    `testRunId=${sibling.testRunId}  testName=${sibling.testName ?? ""}`,
    `error_digest: ${sibling.error_summary ?? "(none)"}`,
    shared,
    `Return the structured RCA_OUTPUT for this test.`,
  ].join("\n");
}

log(`Auto-mode batch: ${clusters.length} cluster(s) over build ${ctx.buildId ?? "?"}`);

// Pipeline: each cluster flows representative → siblings independently (no barrier
// between stages), so a small cluster's siblings confirm while a big cluster's
// representative is still looping. Concurrency is bounded by the workflow runtime
// (~min(16, cores-2)); config.concurrency (5) is the intended soft target.
const results = await pipeline(
  clusters,
  (cluster) =>
    agent(repPrompt(cluster), {
      label: `rep:${cluster.representative.testRunId}`,
      phase: "Representatives",
      agentType: "ai-tfa-coordinator",
      schema: RCA_SCHEMA,
    }).then((rca) => ({ cluster, rca })),
  ({ cluster, rca }) =>
    parallel(
      (cluster.siblings ?? []).map((sib) => () =>
        agent(siblingPrompt(sib, rca, cluster), {
          label: `sib:${sib.testRunId}`,
          phase: "Siblings",
          agentType: "ai-tfa-coordinator",
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

log(`Auto-mode batch complete: ${all.length} test(s) — ${JSON.stringify(byStatus)}`);

return { clusters: flat.length, tests: all.length, byStatus, results: flat };
