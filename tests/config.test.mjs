// The shipped config's schema, checked at BUILD time — which is where a build-time
// property belongs.
//
// This used to be lib/capability-table.mjs: 360 lines of runtime validation over a
// file that ships inside the plugin and cannot change between runs. Validating our
// own constant on every invocation is not a safety property, it is a test that
// happened to be written as a library — so it is a test now, and the runtime is
// 360 lines lighter.
//
// The one thing that genuinely varied at runtime — a customer-supplied overlay —
// is gone too: with no probe commands and no hint list, an overlay had nothing
// dangerous left to carry, and a customer who needs a capability the table does
// not define is better served by the agent assigning it than by editing schema.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MANDATORY_CAPABILITY } from "../lib/verify.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const config = JSON.parse(readFileSync(join(ROOT, "config/rca.config.json"), "utf8"));
const rows = Object.fromEntries(Object.entries(config.capabilities).filter(([k]) => !k.startsWith("$")));
const real = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !k.startsWith("$")));

test("every capability evidenceRouting derives has a row, and no row is an orphan", () => {
  const derived = new Set(
    Object.entries(real(config.evidenceRouting))
      .filter(([, e]) => !(e?.skip || e?.owner === "tfa"))
      .map(([, e]) => e?.capability)
      .filter(Boolean),
  );
  assert.deepEqual([...derived].sort(), Object.keys(rows).sort(),
    "an unseeded capability reports as a phantom missing connector; an orphan row can never be selected");
});

test("exactly one capability is mandatory, and it is the one the gate names", () => {
  // The count and the identity used to be checked in two places that could drift:
  // validateTable counted, lib/verify.mjs named, and nothing compared them.
  const mandatory = Object.entries(rows).filter(([, r]) => r.mandatory === true).map(([k]) => k);
  assert.deepEqual(mandatory, [MANDATORY_CAPABILITY]);
});

test("every discoverable capability states what verified means for it", () => {
  // `intent` is the whole replacement for the probe table and the hint list. It is
  // what an agent reasons from when the customer's stack matches nothing anyone
  // wrote down — which is most customers.
  for (const [cap, row] of Object.entries(rows)) {
    if (row.resolvable !== "partial") continue;
    assert.ok(String(row.intent ?? "").trim().length > 40, `'${cap}' needs a real intent sentence`);
    assert.match(row.intent, /[Vv]erified means/, `'${cap}' must say what verified means`);
  }
  assert.equal(rows.other.intent, undefined, "the always-asked catch-all has nothing to recognise");
});

test("resolvable is one of the two real values", () => {
  for (const [cap, row] of Object.entries(rows)) {
    assert.ok(["partial", "always-asked"].includes(row.resolvable), `${cap}: ${row.resolvable}`);
  }
});

test("every scope field names the step that reads its answer", () => {
  // A question whose answer nothing reads must not be asked. The check can only
  // prove the string is non-empty, so each consumer names a STEP — which is what
  // makes it reviewable. Three fields once carried plausible-sounding consumers
  // that nothing read at all.
  for (const [cap, row] of Object.entries(rows)) {
    for (const [field, spec] of Object.entries(real(row.scopeFields))) {
      assert.ok(String(spec?.consumer ?? "").trim().length > 10, `${cap}.${field} has no real consumer`);
    }
  }
});

test("no row carries a command, a hint list, or a vendor name", () => {
  // The property, not a spot check. Both previous designs are re-addable in one
  // commit, and each looked reasonable at the time: `probe` because a command is
  // precise, `seedHints`/`fingerprints` because recognising the common case is
  // cheap. This is what says no.
  const banned = ["probe", "scopeProbe", "mcpProbe", "probesByExecutable", "fingerprints", "seedHints",
                  "discoveryHints", "executables", "mcp", "files"];
  for (const [cap, row] of Object.entries(rows)) {
    for (const key of banned) {
      assert.ok(!(key in row), `'${cap}' declares '${key}' — rows describe, they do not instruct or list vendors`);
    }
  }

  // And no product name anywhere in the capabilities block. `k8s`/`kibana` survive
  // as evidenceRouting KEYS only: those are the sender's wire vocabulary, not ours.
  const text = JSON.stringify(rows);
  for (const vendor of ["kubectl", "prometheus", "grafana", "instana", "datadog", "splunk", "kibana",
                        "loki", "logcli", "promtool", "nomad", "pm2", "newrelic", "dynatrace",
                        "coralogix", "flyctl", "victorialogs"]) {
    assert.doesNotMatch(text, new RegExp(vendor, "i"), `the capability table names '${vendor}'`);
  }
});
