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
// Pure and dependency-free: the caller supplies the parsed config and the optional
// overlay. Validation collects EVERY violation rather than throwing on
// the first, so one malformed row does not hide the rest.

/** How much of a capability discovery can settle without asking a human.
 *  - partial:      discovery finds the tool; the scope is the interview's job
 *  - always-asked: nothing to fingerprint; the interview owns it end to end
 *
 * A third value, `always` (discovery resolves capability AND scope), was defined
 * and used by no row. Re-adding it is one line; carrying an unused enum value is
 * the accretion this milestone is trying to reverse. */
export const RESOLVABLE = new Set(["partial", "always-asked"]);

/**
 * Fields the shipped table owns exclusively.
 *
 * Notably NOT here any more: `seedHints` and `scopeFields`. A customer may seed
 * hints for a stack this table does not name, and may add a scope field with a
 * consumer — that is how the product becomes generic without a code change. It is
 * only safe because a hint no longer authorises a command: there are no commands in
 * the table, so the worst a bad hint does is propose a route that then has to be
 * verified by a reported check.
 *
 * What remains is structure a row must not decide about itself:
 *
 *   mandatory   — setting github.mandatory=false and infra.mandatory=true produced
 *                 ZERO violations, because the "exactly one" count still came to
 *                 one. The mandatory capability moved silently while
 *                 MANDATORY_CAPABILITY still said github.
 *   resolvable  — flipping a row to always-asked silently disables its discovery.
 *   intent      — what "verified" means for a capability is ours to define; a row
 *                 redefining it could declare itself verified by anything.
 *   exemptFromDiscoveryReport — this controls what the HUMAN is told at the one
 *                 confirmation gate. Set on infra, logs and metrics it suppresses
 *                 all three, so the customer confirms a setup that silently has no
 *                 infra, log or metric route. The row deciding what is said about
 *                 the row is the same shape as the `mandatory` hole above.
 */
export const OVERLAY_FORBIDDEN = ["mandatory", "resolvable", "intent", "exemptFromDiscoveryReport"];

/** Keys that are not data. Assigning `__proto__` through a plain object literal
 *  walks the prototype chain instead of creating an own property: the row became
 *  reachable as `table[cap]` and via `cap in table`, yet Object.keys/entries never
 *  listed it — so validateTable, which iterates entries, never validated it and
 *  never listed it, so validateTable — which iterates entries — never validated it.
 *  Rejected by name, and the table is built prototype-less so a vector we have not
 *  thought of cannot reach Object.prototype either. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Strip prototype keys from a nested object the overlay supplied.
 *
 * The top-level check covers capability names and immediate row fields, but the
 * overlay may now supply `scopeFields` and `seedHints`, so that nesting is newly
 * customer-reachable — and JSON.parse makes `__proto__` an OWN property that spread
 * copies faithfully, so it merged with zero violations and appeared in
 * Object.keys. It caused no pollution, but the docstring above claimed these are
 * "rejected by name" and that was true at two of the three levels the overlay can
 * reach. */
function withoutUnsafeKeys(obj, onFound) {
  if (!obj || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const k of Object.keys(obj)) {
    if (UNSAFE_KEYS.has(k)) { onFound(k); continue; }
    out[k] = obj[k] && typeof obj[k] === "object" ? withoutUnsafeKeys(obj[k], onFound) : obj[k];
  }
  return out;
}

/** A scope field asks a HUMAN to type its answer, and the answer is written to a
 *  committed file. A field named like a credential invites exactly the value the
 *  write guard then refuses — so it is refused up front, where the fix is obvious.
 *  Credentials are referenced by CREDENTIAL_KIND, never collected as scope. */
const CREDENTIAL_NAMED = /token|secret|password|passwd|credential|api[_-]?key|auth|bearer/i;

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
      if (UNSAFE_KEYS.has(field)) continue;
      clean[field] = withoutUnsafeKeys(row[field], (k) => {
        violations.push({
          code: "overlay-unsafe-key",
          capability: cap,
          field: `${field}.${k}`,
          message: `overlay row '${cap}' nests '${k}' under '${field}', which is a prototype key, not a field`,
        });
      });
    }

    for (const name of Object.keys(clean.scopeFields ?? {})) {
      if (!CREDENTIAL_NAMED.test(name)) continue;
      violations.push({
        code: "overlay-credential-field",
        capability: cap,
        field: `scopeFields.${name}`,
        message:
          `overlay row '${cap}' declares scope field '${name}', which names a credential. A scope ` +
          `field is typed by a human and written to a committed file — reference the credential by ` +
          `environment-variable NAME instead (see CREDENTIAL_KIND).`,
      });
      delete clean.scopeFields[name];
    }

    const base = table[cap] ?? {};

    // The mandatory capability's scope fields define what the gate must see
    // COVERED, so an overlay-added field would let an invented answer satisfy the
    // one gate that can stop a run: `{github:{scopeFields:{dashboardUrl:…}}}`
    // verified with repos and baseBranch never checked.
    if (base.mandatory === true && clean.scopeFields !== undefined) {
      violations.push({
        code: "overlay-forbidden-field",
        capability: cap,
        field: "scopeFields",
        message:
          `overlay row '${cap}' may not add scope fields to the mandatory capability — they ` +
          `define what its gate requires, so an added field could satisfy the gate without ` +
          `the real scope being verified`,
      });
      delete clean.scopeFields;
    }

    // scopeFields and seedHints both MERGE rather than replace. A shallow spread
    // let an overlay carrying `{}` delete everything the shipped row declared,
    // silently and with no violation. That was fixed for scopeFields and missed
    // for seedHints in the same commit — and `{github:{seedHints:{}}}` then left
    // the mandatory capability unrecognisable on a machine that had `gh`, so its
    // gate blocked a fully capable setup.
    const scopeFields = { ...(base.scopeFields ?? {}), ...(clean.scopeFields ?? {}) };
    const seedHints = { ...(base.seedHints ?? {}), ...(clean.seedHints ?? {}) };
    table[cap] = { ...base, ...clean };
    if (Object.keys(scopeFields).length > 0) table[cap].scopeFields = scopeFields;
    if (Object.keys(seedHints).length > 0) table[cap].seedHints = seedHints;
  }
  return { table, violations };
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

    // Hints are hints. An always-asked row has nothing to recognise by definition,
    // so hints on it would describe behaviour that never happens.
    const hints = row?.seedHints ?? null;
    if (row?.resolvable === "always-asked" && hints && Object.keys(hints).length > 0) {
      violations.push({
        code: "always-asked-with-hints",
        capability: cap,
        field: "seedHints",
        message:
          `capability '${cap}' is always-asked but declares seedHints — nothing consults them for ` +
          `an always-asked row, so they would describe behaviour that never happens`,
      });
    }

    for (const kind of ["executables", "mcp", "files"]) {
      const list = hints?.[kind];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.some((v) => typeof v !== "string" || !v.trim())) {
        violations.push({
          code: "bad-seed-hint",
          capability: cap,
          field: `seedHints.${kind}`,
          message: `capability '${cap}' seedHints.${kind} must be an array of non-empty strings`,
        });
      }
    }

    // `intent` is what the agent reads to know what this capability IS and what
    // counts as verified for it. It replaces the probe templates: a sentence the
    // agent can reason about generalises to a stack nobody listed, and a command
    // string does not.
    if (row?.resolvable === "partial" && !String(row?.intent ?? "").trim()) {
      violations.push({
        code: "missing-intent",
        capability: cap,
        field: "intent",
        message:
          `capability '${cap}' is discoverable but states no intent — without one sentence saying ` +
          `what it is and what "verified" means for it, the agent has nothing to reason from`,
      });
    }


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
