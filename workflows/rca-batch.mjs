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
    mandatory_checks: { type: "array", items: { type: "string" } },
  },
  additionalProperties: true,
};

const ctx = (typeof args === "string" ? JSON.parse(args) : args) ?? {};
const clusters = ctx.clusters ?? [];
const shared = [
  `CSV state file: ${ctx.csvPath}`,
  `Capability manifest: ${JSON.stringify(ctx.manifest ?? {})}`,
  `Build-level evidence (pre-computed once, reuse — do not re-fetch): ${JSON.stringify(ctx.buildEvidence ?? {})}`,
  `Autonomous run — on an evidence gap with no valid connector, report "unavailable" back to TFA (NEVER prompt a user). Best-effort finalize.`,
  `PRODUCT_BUG / application-bug mandate: hunt the culprit PR via the github connector (deploy timeline vs last-pass window, changed paths vs failure signature) and feed the PR link(s) to TFA so related_prs populates. No PR after digging to the turn cap → state explicitly "no culprit PR identified after <what was searched>" so the CSV row records the gap.`,
  `Soft-PENDING is NOT an answer: tfaRcaTurn abandons its in-call poll at 90s while TFA keeps working. On status PENDING, call getTfaTurnResult(testRunId, turnId) FIRST and keep reading on the softPendingDrain budget (every 5s, <=40 reads / <=10min) until the status is RESOLVED / NEEDS_INFO / BLOCKED, then continue the loop. Reads do NOT count against the turn cap. Never submit a new message onto a turn still in flight. Only a fully spent drain budget ends the test PENDING.`,
  `Persist eagerly to the CSV: claim your row before turn 1, flip it on terminal (lib/csv-state.mjs).`,
  `MANDATORY CONNECTOR SWEEPS (Operating Principle 0, ai-tfa-coordinator.md): before turn 1, check every available capability's connector skill for a declared compulsory check (e.g. nl2steps-infra's "kubectl app-log check is COMPULSORY — not conditional, not a fallback"). Run any that apply NOW, unconditionally, and fold the evidence block into the turn-1 message. Do NOT wait for a NEEDS_INFO ask naming that evidenceType — TFA has been observed to label deploy/infra-shaped questions "product_code", so ask-routing alone will never trigger it. Record what ran under mandatory_checks in the RCA_OUTPUT.`,
  `MINIMUM CALL BUDGET: nl2steps-infra requires AT LEAST 5 separate real kubectl invocations per RCA turn that touches it (deploy state, pod-discovery x2 as SEPARATE calls, log-sweep x2 minimum — see the skill's "Minimum call budget" section). This is a latency-instrumentation baseline so the k8s path has comparable call volume to the github connector, not busywork — never satisfy it by combining calls, batching selectors, or reusing a cached result. Report the actual count run in mandatory_checks (e.g. "kubectl: ran (5 calls) — ...").`,
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

function repPrompt(cluster) {
  const r = cluster.representative;
  return [
    `You are the ai-tfa-coordinator for cluster ${cluster.cluster_id}.`,
    `Run the FULL collaborative RCA loop for the representative test.`,
    `testRunId=${r.testRunId}  testName=${r.testName ?? ""}`,
    `error_digest: ${r.error_summary ?? "(none)"}`,
    resumeLine(r),
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
// representative is still looping. Concurrency is bounded by the workflow runtime
// (~min(16, cores-2)) regardless of config.concurrency (50) — that value is the
// intended soft target/upper bound; the runtime queues anything beyond its own cap.
const results = await pipeline(
  clusters,
  (cluster) =>
    agent(repPrompt(cluster), {
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
