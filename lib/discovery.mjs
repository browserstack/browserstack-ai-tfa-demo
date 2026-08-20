// Discovery (R6, R8, R10) — resolve CAPABILITY without asking anyone anything.
//
// The division this module exists to hold: discovery resolves capability, the
// interview resolves scope, verification proves both. Discovery can find that
// `gh` is on PATH or that a Prometheus MCP server is in the session; it cannot
// find which namespace, log index, service name or monorepo subpath matters.
// That residue is the only thing worth asking a human about, and everything here
// is shaped to make the residue as small as it honestly can be.
//
// PURE. The environment is passed in, never sensed: no child_process, no fs, no
// Date.now(). The caller (the setup skill) collects `{executables, mcpServers,
// repoFiles, connectorSkills}` with its own tools and hands it over, which is
// what makes the whole engine replayable from a fixture.
//
// Note there is no probe executor here. Discovery is fingerprint MATCHING, not
// probing — nothing is run. Live reads belong to verification, so the probe-result
// replay seam lives there too; this module's fixtures are environment
// descriptors.

import { isProbeRunnable } from "./tool-cache.mjs";

const norm = (s) => String(s ?? "").trim().toLowerCase();

/** Does an advertised MCP server satisfy this fingerprint?
 *
 * ONE-WAY: the server name must contain the fingerprint. An earlier draft allowed
 * containment in either direction, which made the fingerprint "github-mcp" match a
 * server named "hub", "git" or "it" — reporting GitHub as discovered on a machine
 * with no GitHub MCP at all, and then disagreeing with verification, which used the
 * one-way rule and refused. A fingerprint is a distinctive substring you look for;
 * it is not a haystack. */
function mcpMatches(fingerprint, server) {
  const f = norm(fingerprint);
  const s = norm(server);
  if (!f || !s) return false;
  return s.includes(f);
}

/** A repo fingerprint may name a directory (`k8s/`) or a file
 *  (`docker-compose.yml`). Match on path prefix or basename. */
function fileMatches(fingerprint, path) {
  const f = norm(fingerprint).replace(/\/+$/, "");
  const p = norm(path);
  if (!f || !p) return false;
  // Every disjunct ends on a path boundary. A bare `p.startsWith(f)` was also here
  // and made the fingerprint "k8" match "k8s/deployment.yaml" — the extra
  // disjuncts hid how loose that made the rule.
  return p === f || p.startsWith(`${f}/`) || p.includes(`/${f}/`) || p.endsWith(`/${f}`);
}

/**
 * Match one capability row against the environment.
 *
 * Returns `{via, evidence}` when something matched, else null. `via` names the
 * KIND of route found, because a coordinator downstream needs to know whether it
 * is talking to a CLI or an MCP server, not merely that "infra" is available.
 */
export function matchRow(row, env) {
  const executables = row?.fingerprints?.executables ?? [];
  for (const exe of executables) {
    if ((env.executables ?? []).some((e) => norm(e) === norm(exe))) {
      return { via: exe, evidence: { kind: "executable", name: exe } };
    }
  }
  for (const fp of row?.fingerprints?.mcp ?? []) {
    const hit = (env.mcpServers ?? []).find((s) => mcpMatches(fp, s));
    if (hit) return { via: hit, evidence: { kind: "mcp", name: hit } };
  }
  for (const fp of row?.fingerprints?.files ?? []) {
    const hit = (env.repoFiles ?? []).find((p) => fileMatches(fp, p));
    if (hit) return { via: `file:${hit}`, evidence: { kind: "file", name: hit } };
  }
  return null;
}

/**
 * Read resolved scope out of connector skills present on this machine.
 *
 * A workspace that already has BrowserStack-authored connector skills carries a
 * repo map, branch conventions and scope probes the interview would otherwise
 * have to ask for. Reading them keeps an internal workspace at parity instead of
 * regressing it to the customer path.
 *
 * The catch: this is externally-sourced data at four filesystem paths, one of them
 * a home directory. Any scope probe it declares goes through the SAME gate as a
 * shipped table probe — the customer-row deferral exists precisely because an
 * unconstrained probe field is a code-execution surface, and a connector skill is
 * a less-trusted input than the shipped config, not a more-trusted one.
 *
 * `connectorSkills`: `[{name, path, capability, scope, scopeProbes}]` — already
 * parsed by the caller, since parsing markdown is not this module's job.
 */
export function preFillFromConnectorSkills(table = {}, connectorSkills = []) {
  const scopeByCapability = {};
  const violations = [];

  for (const skill of connectorSkills) {
    const cap = skill?.capability;
    if (!cap) continue;
    const row = table[cap];
    if (!row) {
      violations.push({
        code: "connector-unknown-capability",
        capability: cap,
        source: skill.path ?? skill.name,
        message: `connector skill '${skill.name}' declares capability '${cap}', which the table does not define`,
      });
      continue;
    }

    const leaders = row?.fingerprints?.executables ?? [];
    for (const probe of skill.scopeProbes ?? []) {
      const r = isProbeRunnable(probe, { leaders });
      if (!r.ok) {
        violations.push({
          code: "connector-bad-probe",
          capability: cap,
          source: skill.path ?? skill.name,
          message: `connector skill '${skill.name}' declares an unusable scope probe: ${r.reason}`,
        });
      }
    }

    // Only fields the table actually declares, so a connector cannot invent scope
    // nothing downstream reads.
    const declared = Object.keys(row?.scopeFields ?? {});
    const accepted = {};
    for (const [field, value] of Object.entries(skill.scope ?? {})) {
      if (declared.includes(field)) accepted[field] = value;
    }
    scopeByCapability[cap] = { ...(scopeByCapability[cap] ?? {}), ...accepted };
  }

  return { scopeByCapability, violations };
}

/**
 * Resolve every capability the environment can settle without a question.
 *
 * Returns the `discovered` array `buildManifest` consumes, plus the questions the
 * interview still owes and any custom-capability records.
 */
export function discover({ table = {}, env = {}, connectorSkills = [] } = {}) {
  const { scopeByCapability, violations } = preFillFromConnectorSkills(table, connectorSkills);

  const discovered = [];
  const questions = [];
  const claimed = new Set();

  for (const [capability, row] of Object.entries(table)) {
    const declaredFields = Object.keys(row?.scopeFields ?? {});
    const preFilled = scopeByCapability[capability] ?? {};
    const unresolvedFields = declaredFields.filter((f) => preFilled[f] === undefined);

    // An always-asked row is never resolved by discovery, even when a fingerprint
    // coincidentally matches. `other` is the catch-all: matching it by accident
    // and skipping its question would silently swallow an unrecognised stack.
    const match = row?.resolvable === "always-asked" ? null : matchRow(row, env);

    if (match) {
      if (match.evidence.kind === "executable" || match.evidence.kind === "mcp") {
        claimed.add(norm(match.evidence.name));
      }
      discovered.push({
        capability,
        via: match.via,
        evidence: match.evidence,
        resolvedScope: preFilled,
        unresolvedFields,
        tag: "detected",
      });
    }

    // Scope is asked for whenever it is missing and the capability is in play —
    // a detected capability with unresolved scope still owes questions, and an
    // always-asked capability owes them regardless.
    if (unresolvedFields.length > 0 && (match || row?.resolvable === "always-asked")) {
      for (const field of unresolvedFields) {
        questions.push({
          capability,
          field,
          consumer: row.scopeFields[field]?.consumer ?? null,
          mandatory: row?.mandatory === true,
        });
      }
    }
  }

  // Anything present in the environment that no row fingerprints. R8: one open
  // question and a custom record, never a wrong assumption. The record is routed
  // into the declared-gap list so the answer has a real consumer — an orphan
  // question is exactly what the table's consumer rule forbids elsewhere.
  const custom = [];
  for (const kind of ["executables", "mcpServers"]) {
    for (const name of env[kind] ?? []) {
      if (claimed.has(norm(name))) continue;
      if (isFingerprintedAnywhere(table, kind, name)) continue;
      custom.push({
        code: "custom-capability",
        kind: kind === "executables" ? "executable" : "mcp",
        name,
        message: `'${name}' is present but no capability row fingerprints it`,
      });
    }
  }
  if (custom.length > 0) {
    questions.push({
      capability: "other",
      field: "customCapabilities",
      consumer: "declared as a gap to the TFA agent on the first turn",
      mandatory: false,
      candidates: custom.map((c) => c.name),
    });
  }

  return { discovered, questions, custom, violations };
}

/** True when any row fingerprints this name — used to avoid reporting a tool as
 *  "custom" merely because its own capability was resolved by a different route.
 *  Reuses matchRow so the fingerprint rules cannot drift between detection and
 *  custom-capability suppression. */
function isFingerprintedAnywhere(table, kind, name) {
  return Object.values(table).some((row) => matchRow(row, { [kind]: [name] }));
}

/**
 * Fill a probe template's `{field}` placeholders from resolved scope, and
 * RE-VALIDATE the result.
 *
 * The template was validated at schema time against `{repo}`, not against the
 * string that actually runs. A resolved scope value can carry a redirect- or
 * flag-shaped token — `--base` becomes whatever the customer typed — so the
 * interpolated command is checked again here, immediately before it is handed to
 * an executor. Checking only the template is the gap this closes.
 */
export function fillPlaceholders(template, scope = {}) {
  const missing = [];
  const text = String(template ?? "").replace(/\{([A-Za-z0-9_]+)\}/g, (_, field) => {
    const value = scope[field];
    if (value === undefined || value === null || String(value).trim() === "") {
      missing.push(field);
      return `{${field}}`;
    }
    return String(value);
  });
  return { text, missing };
}

export function interpolate(template, scope = {}, { leaders = [] } = {}) {
  const { text: command, missing } = fillPlaceholders(template, scope);

  if (missing.length > 0) {
    return { ok: false, command, reason: `unresolved placeholder(s): ${missing.join(", ")}` };
  }

  const r = isProbeRunnable(command, { leaders });
  if (!r.ok) {
    return {
      ok: false,
      command,
      reason: `interpolated probe is not runnable: ${r.reason}`,
    };
  }
  return { ok: true, command };
}
