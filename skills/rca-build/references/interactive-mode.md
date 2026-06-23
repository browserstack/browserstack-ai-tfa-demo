# Interactive mode — subagents with a user in the loop

Interactive mode (D2) puts the human (A1) in the loop **only at the orchestrator
layer**. The main session spawns `ai-tfa-coordinator` subagents to investigate in
parallel; when a subagent needs evidence it can't get, it hands the gap back up to
the orchestrator, which asks the user and feeds the answer down.

This is the **same coordinator** the auto workflow uses — only the gap-resolver
differs (auto → "unavailable"; interactive → return the gap).

## Why a subagent can't just "ask the user"

A dispatched subagent runs to completion and returns one final message — it
cannot pause mid-run, prompt the user, and resume. So the gap-return is modeled
as **early termination with resume handles**, and the orchestrator drives the
ask-and-resume loop.

## The orchestrator loop (per batch of ≤ `concurrency`, default 5)

```
1. Take the next ≤5 pending work items (representatives first, then siblings).
2. Dispatch one ai-tfa-coordinator subagent per item, mode=interactive, passing
   the manifest + pre-computed build evidence + (for siblings) the pre-seed.
3. Each subagent runs its loop until either:
     - a terminal status → returns RCA_OUTPUT (the orchestrator flips the CSV row), or
     - an interactive GAP → returns GAP_OUTPUT (status=PENDING) carrying:
         { testRunId, threadId, turnId, gap: { evidenceType, what, why } }
4. For each GAP_OUTPUT: ASK A1 for that evidence (one focused question).
     - A1 answers → re-dispatch a coordinator with resume={threadId,turnId} and
       the answer digested into the next turn's message. Continue its loop.
     - A1 has nothing → tell the coordinator to report "unavailable" on resume
       (degrade exactly like auto for that one ask).
5. Repeat until every row is terminal. Then dispatch the next batch.
```

## Aggregation discipline (large batches)

Subagents return **compact `RCA_OUTPUT` / `GAP_OUTPUT` blocks, never transcripts**
— mirroring the auto workflow's "results in script vars" rule — so the main
agent's context stays lean even over hundreds of tests. The orchestrator never
holds full per-test loop transcripts; it holds one block per test.

## Partial-first

A subagent that dies becomes a recorded `failed` row (the orchestrator
synthesizes it). One stuck test never sinks the batch — same contract as auto.

## When to prefer interactive over auto

- The client is missing infra skills the failures clearly need (k8s/kibana), and
  the user can supply that evidence by hand.
- The user wants to steer or sign off mid-run.

Otherwise auto is cheaper (no human round-trips). Both write the same CSV rows
and the same report, so a run can start auto and the residual BLOCKED/gap tests
can be re-run interactively (the auto-first / escalate-the-residue pattern).
