// The capability table (R7) — load, merge, validate.
//
// The table is a sibling block in config/rca.config.json keyed by CAPABILITY,
// joined to evidenceRouting by capability name. It is deliberately not rows
// inside evidenceRouting: buildManifest() enumerates Object.values(evidenceRouting)
// and reads entry.capability off every value, so a capability-keyed row placed in
// there becomes an evidenceType entry, and a row naming a new capability injects a
// phantom manifest entry that unavailableCapabilities() reports to the user and to
// TFA as a missing connector.
//
// Pure and dependency-free apart from the probe validator — the caller supplies
// the parsed config (lib/routing.mjs loadConfig is the single file reader) and the
// optional overlay. Validation collects EVERY violation rather than throwing on
// the first, so one malformed row does not hide the rest.

import { isPermittedProbeLeader, isProbeRunnable } from "./tool-cache.mjs";

/** How much of a capability discovery can settle without asking a human.
 *  - partial:      discovery finds the tool; the scope is the interview's job
 *  - always-asked: nothing to fingerprint; the interview owns it end to end
 *
 * A third value, `always` (discovery resolves capability AND scope), was defined
 * and used by no row. Re-adding it is one line; carrying an unused enum value is
 * the accretion this milestone is trying to reverse. */
export const RESOLVABLE = new Set(["partial", "always-asked"]);

/** Fields the shipped table owns exclusively. An overlay that set any of these
 *  would make probe validation self-certifying: the leader allowlist would come
 *  from the same customer-controlled row as the probe it authorises. */
export const OVERLAY_FORBIDDEN = [
  // Executable surface: an overlay that set these would make probe validation
  // self-certifying — the leader allowlist would come from the same
  // customer-controlled row as the probe it authorises.
  "fingerprints", "probe", "mcpProbe", "scopeProbe", "probesByExecutable",
  // Structural surface: `mandatory` let a committed overlay MOVE the mandatory
  // capability. Setting github.mandatory=false and infra.mandatory=true produced
  // zero violations (the "exactly one mandatory" count still passed) while
  // MANDATORY_CAPABILITY in lib/verify.mjs still said "github" — so the invariant
  // the two are supposed to share was decorative. `resolvable` is here for the
  // same reason: flipping a row to always-asked silently disables its discovery.
  "mandatory", "resolvable",
];

/** Keys that are not data. Assigning `__proto__` through a plain object literal
 *  walks the prototype chain instead of creating an own property: the row became
 *  reachable as `table[cap]` and via `cap in table`, yet Object.keys/entries never
 *  listed it — so validateTable, which iterates entries, never validated it and
 *  never ran its probe through isProbeRunnable. That is precisely the
 *  self-certifying row OVERLAY_FORBIDDEN exists to prevent, arriving in a
 *  git-committed file. Rejected by name, and the table is built prototype-less so
 *  a vector we have not thought of cannot reach Object.prototype either. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * The capability names evidenceRouting actually derives.
 *
 * Entries with no `capability` key are skipped — `test_logs` carries
 * `{owner: "tfa", skip: true}` and nothing else, so a naive Object.values().map()
 * yields `undefined` and reports a phantom unseeded capability.
 */
export function capabilitiesFromRouting(config) {
  const routing = config?.evidenceRouting ?? {};
  return [
    ...new Set(
      Object.values(routing)
        // Same skip rule buildManifest applies. They agreed only by accident
        // before: `test_logs` happens to carry no `capability`, but an entry like
        // `{capability: "x", skip: true}` would have made validateTable demand a
        // row for a capability the manifest can structurally never contain.
        .filter((e) => !(e?.skip || e?.owner === "tfa"))
        .map((e) => e?.capability)
        .filter(Boolean),
    ),
  ];
}

/**
 * Capabilities worth telling a human are unavailable.
 *
 * `unavailableCapabilities(manifest)` takes only the manifest and cannot read a
 * table field, so this is where `exemptFromDiscoveryReport` is honoured. `other` is
 * the catch-all: it can never match a fingerprint, so reporting it every single run
 * is noise. The manifest and the TFA-facing declaration still mark it unavailable —
 * only the human-facing line suppresses it.
 */
export function reportableUnavailable(unavailable = [], table = {}) {
  return unavailable.filter((cap) => table[cap]?.exemptFromDiscoveryReport !== true);
}

/**
 * Merge a customer-supplied overlay over the shipped table.
 *
 * Scope data only. An overlay row that reaches for an executable field is a
 * violation naming the field, not a silently-dropped key — a customer whose
 * overlay is being partly ignored should be told.
 */
export function mergeOverlay(shipped = {}, overlay = null) {
  const table = Object.create(null);
  for (const [cap, row] of Object.entries(shipped)) table[cap] = { ...row };

  const violations = [];
  if (!overlay || typeof overlay !== "object") return { table, violations };

  for (const cap of Object.keys(overlay)) {
    const row = overlay[cap];
    if (UNSAFE_KEYS.has(cap)) {
      violations.push({
        code: "overlay-unsafe-key",
        capability: cap,
        message:
          `overlay names '${cap}', which is not a capability — it is a prototype key, and a row ` +
          `stored under it would be reachable by lookup while invisible to validation`,
      });
      continue;
    }
    if (!row || typeof row !== "object") {
      violations.push({
        code: "overlay-malformed-row",
        capability: cap,
        message: `overlay row for '${cap}' is not an object`,
      });
      continue;
    }
    const clean = {};
    for (const field of Object.keys(row)) {
      if (UNSAFE_KEYS.has(field)) {
        violations.push({
          code: "overlay-unsafe-key",
          capability: cap,
          field,
          message: `overlay row '${cap}' names '${field}', which is a prototype key, not a field`,
        });
        continue;
      }
      if (OVERLAY_FORBIDDEN.includes(field)) {
        violations.push({
          code: "overlay-forbidden-field",
          capability: cap,
          field,
          message:
            `overlay row '${cap}' may not set '${field}' — the shipped table is the sole ` +
            `source of fingerprints, probes and structure, otherwise a row could authorise its ` +
            `own probe leader or move the mandatory capability`,
        });
        continue;
      }
      clean[field] = row[field];
    }

    const base = table[cap] ?? {};
    // scopeFields MERGES rather than replaces. A shallow spread let an overlay
    // carrying `scopeFields: {}` delete every question the shipped row declared —
    // silently, with no violation — which for github meant losing the repo and
    // base-branch questions the mandatory capability depends on.
    const scopeFields = { ...(base.scopeFields ?? {}), ...(clean.scopeFields ?? {}) };
    table[cap] = { ...base, ...clean };
    if (Object.keys(scopeFields).length > 0) table[cap].scopeFields = scopeFields;
  }
  return { table, violations };
}

function validateMcpProbe(cap, mcpProbe) {
  const violations = [];
  if (typeof mcpProbe.tool !== "string" || !mcpProbe.tool.trim()) {
    violations.push({
      code: "bad-mcp-probe",
      capability: cap,
      field: "mcpProbe.tool",
      message: `capability '${cap}' mcpProbe.tool must be a non-empty string`,
    });
  }
  if (mcpProbe.args !== undefined && (typeof mcpProbe.args !== "object" || mcpProbe.args === null || Array.isArray(mcpProbe.args))) {
    violations.push({
      code: "bad-mcp-probe",
      capability: cap,
      field: "mcpProbe.args",
      message: `capability '${cap}' mcpProbe.args must be an object when present`,
    });
  }
  return violations;
}

/**
 * Validate a (post-merge) table against the config that derives its capability set.
 *
 * Returns every violation found. Deliberately runs on the MERGED table: validating
 * the shipped table alone would treat overlay data as pre-trusted.
 */
export function validateTable(config, table = {}) {
  const violations = [];
  const derived = capabilitiesFromRouting(config);

  for (const cap of derived) {
    if (!(cap in table)) {
      violations.push({
        code: "unseeded-capability",
        capability: cap,
        message: `capability '${cap}' is derived from evidenceRouting but has no table row`,
      });
    }
  }

  let mandatoryCount = 0;

  for (const [cap, row] of Object.entries(table)) {
    if (!derived.includes(cap)) {
      violations.push({
        code: "orphan-row",
        capability: cap,
        message:
          `table row '${cap}' names no capability in evidenceRouting — likely an evidenceType ` +
          `mistaken for a capability (ci, product_code and deploy route to github; k8s routes to infra)`,
      });
      continue;
    }

    if (!RESOLVABLE.has(row?.resolvable)) {
      violations.push({
        code: "bad-resolvable",
        capability: cap,
        field: "resolvable",
        message: `capability '${cap}' resolvable must be one of ${[...RESOLVABLE].join(" | ")}`,
      });
    }

    if (row?.mandatory === true) mandatoryCount += 1;

    const executables = row?.fingerprints?.executables ?? [];

    if (row?.resolvable === "always-asked" && (executables.length > 0 || (row?.fingerprints?.mcp ?? []).length > 0)) {
      violations.push({
        code: "always-asked-with-fingerprints",
        capability: cap,
        field: "fingerprints",
        message:
          `capability '${cap}' is always-asked but declares fingerprints — discovery ignores them, ` +
          `so they would describe behaviour that never happens`,
      });
    }
    for (const exe of executables) {
      const permitted = isPermittedProbeLeader(exe);
      if (!permitted.ok) {
        violations.push({
          code: "bad-fingerprint",
          capability: cap,
          field: `fingerprints.executables:${exe}`,
          message: `capability '${cap}' declares fingerprint executable '${exe}': ${permitted.reason}`,
        });
      }
    }

    // A probe is only required where discovery can resolve something. An
    // always-asked row has nothing to fingerprint by definition.
    const needsProbe = row?.resolvable === "partial";
    const byExe = row?.probesByExecutable ?? null;
    const hasCliProbe =
      (typeof row?.probe === "string" && row.probe.trim().length > 0) ||
      (byExe !== null && typeof byExe === "object" && Object.keys(byExe).length > 0);
    const hasMcpProbe = row?.mcpProbe && typeof row.mcpProbe === "object";

    // Every declared executable must have a probe that actually LEADS with it.
    // Two live defects shared this shape: `infra` fingerprinted five runtimes and
    // shipped one kubectl probe, and `logs`/`metrics` fingerprinted logcli/promtool
    // and shipped no CLI probe at all. In both cases a machine that HAD the tool was
    // told its scope was invalid — the customer blamed for our table's gap. This is
    // the structural rule that makes that unrepresentable rather than merely fixed.
    if (needsProbe) {
      for (const exe of executables) {
        const perExe = byExe?.[exe];
        const perExeProbe = typeof perExe?.probe === "string" && perExe.probe.trim().length > 0;
        const rowLeads = typeof row?.probe === "string" && row.probe.trim().split(/\s+/)[0] === exe;
        if (!perExeProbe && !rowLeads) {
          violations.push({
            code: "unprobed-executable",
            capability: cap,
            field: `fingerprints.executables:${exe}`,
            message:
              `capability '${cap}' fingerprints '${exe}' but no probe leads with it — discovery would ` +
              `report the capability available and verification would run a different tool, recording the ` +
              `failure as the customer's scope being invalid`,
          });
        }
      }
    }

    // Per-executable probes go through the same gate, with the leader narrowed to
    // the executable that keys them: a `docker` entry may not carry a kubectl probe.
    for (const [exe, spec] of Object.entries(byExe ?? {})) {
      if (exe.startsWith("$")) continue;
      if (!spec || typeof spec !== "object") {
        violations.push({
          code: "bad-probe",
          capability: cap,
          field: `probesByExecutable.${exe}`,
          message: `capability '${cap}' probesByExecutable.${exe} must be an object`,
        });
        continue;
      }
      if (!executables.includes(exe)) {
        violations.push({
          code: "orphan-probe",
          capability: cap,
          field: `probesByExecutable.${exe}`,
          message:
            `capability '${cap}' declares a probe for '${exe}', which is not one of its fingerprint ` +
            `executables — it could never be selected`,
        });
      }
      for (const f of ["probe", "scopeProbe"]) {
        const cmd = spec[f];
        if (cmd === undefined) continue;
        const r = isProbeRunnable(cmd, { leaders: [exe] });
        if (!r.ok) {
          violations.push({
            code: "bad-probe",
            capability: cap,
            field: `probesByExecutable.${exe}.${f}`,
            message: `capability '${cap}' probesByExecutable.${exe}.${f} is not a valid probe: ${r.reason}`,
          });
        }
      }
    }

    if (needsProbe) {
      const hasFingerprint =
        executables.length > 0 ||
        (row?.fingerprints?.mcp ?? []).length > 0 ||
        (row?.fingerprints?.files ?? []).length > 0;
      if (!hasFingerprint) {
        violations.push({
          code: "missing-fingerprint",
          capability: cap,
          field: "fingerprints",
          message: `capability '${cap}' is ${row.resolvable} but declares no fingerprint to discover it by`,
        });
      }
      // Either route satisfies this: a capability reachable only over MCP has no
      // runnable command string, and only the agent can invoke an MCP tool.
      if (!hasCliProbe && !hasMcpProbe) {
        violations.push({
          code: "missing-probe",
          capability: cap,
          field: "probe",
          message: `capability '${cap}' is ${row.resolvable} but declares neither a CLI probe nor an mcpProbe to verify it with`,
        });
      }
    }

    for (const field of ["probe", "scopeProbe"]) {
      const cmd = row?.[field];
      if (cmd === undefined) continue;
      const r = isProbeRunnable(cmd, { leaders: executables });
      if (!r.ok) {
        violations.push({
          code: "bad-probe",
          capability: cap,
          field,
          message: `capability '${cap}' ${field} is not a valid probe: ${r.reason}`,
        });
      }
    }

    if (hasMcpProbe) violations.push(...validateMcpProbe(cap, row.mcpProbe));

    for (const [name, spec] of Object.entries(row?.scopeFields ?? {})) {
      const consumer = spec?.consumer;
      if (typeof consumer !== "string" || !consumer.trim()) {
        violations.push({
          code: "missing-consumer",
          capability: cap,
          field: `scopeFields.${name}`,
          message:
            `capability '${cap}' scope field '${name}' names no downstream consumer — a question ` +
            `whose answer nothing reads must not be asked`,
        });
      }
    }
  }

  if (mandatoryCount !== 1) {
    violations.push({
      code: "mandatory-count",
      message: `exactly one capability must be mandatory; found ${mandatoryCount}`,
    });
  }

  return violations;
}

/**
 * Load the table from a parsed config, merge any overlay, and validate the result.
 *
 * `{ table, violations }` — an empty `violations` array is the only success signal.
 * The table is still returned when violations exist so a caller can report every
 * problem at once instead of one per run.
 */
export function loadCapabilityTable(config, overlay = null) {
  const { table, violations: mergeViolations } = mergeOverlay(config?.capabilities ?? {}, overlay);
  return { table, violations: [...mergeViolations, ...validateTable(config, table)] };
}
