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
export const OVERLAY_FORBIDDEN = ["fingerprints", "probe", "mcpProbe", "scopeProbe"];

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
  const table = {};
  for (const [cap, row] of Object.entries(shipped)) table[cap] = { ...row };

  const violations = [];
  if (!overlay || typeof overlay !== "object") return { table, violations };

  for (const [cap, row] of Object.entries(overlay)) {
    if (!row || typeof row !== "object") {
      violations.push({
        code: "overlay-malformed-row",
        capability: cap,
        message: `overlay row for '${cap}' is not an object`,
      });
      continue;
    }
    const clean = { ...row };
    for (const field of OVERLAY_FORBIDDEN) {
      if (!(field in row)) continue;
      delete clean[field];
      violations.push({
        code: "overlay-forbidden-field",
        capability: cap,
        field,
        message:
          `overlay row '${cap}' may not set '${field}' — the shipped table is the sole ` +
          `source of fingerprints and probes, otherwise a row could authorise its own probe leader`,
      });
    }
    table[cap] = { ...(table[cap] ?? {}), ...clean };
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
    const hasCliProbe = typeof row?.probe === "string" && row.probe.trim().length > 0;
    const hasMcpProbe = row?.mcpProbe && typeof row.mcpProbe === "object";

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
