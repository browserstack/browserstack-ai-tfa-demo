# Template — evidence block (one per fulfilled/unfulfilled ask)

The unit of evidence sent back to TFA in a turn message. Rules, size caps and
the forbidden list: `../references/evidence-routing.md`.

Fulfilled ask:

```
ASK: <verbatim `what` from the TfaAsk, ≤ 120 chars>
TYPE: <evidenceType>
FOUND: <yes | no | partial>
SUMMARY: <1–3 sentences — the finding, in the agent's words. ≤ 400 chars>
SNIPPET:
  <the load-bearing excerpt only — see size caps. Omit if a LINK fully carries it.>
LINK: <permalink to the source — PR/commit/log-search/metrics panel/deploy record. Omit if N/A.>
```

Unfulfillable ask (report, don't drop — machine-generated for absent connectors
by `lib/loop.mjs` `unavailableBlock`):

```
ASK: <verbatim what>
TYPE: <evidenceType>
FOUND: no
SUMMARY: not-found | unreachable | unavailable | out-of-scope — <one line: what was checked or why blocked>
```
