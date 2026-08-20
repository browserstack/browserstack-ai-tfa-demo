// Discovery — plan the interview. The AGENT decides what each tool is.
//
// The division this module holds: discovery resolves CAPABILITY, the interview
// resolves SCOPE, verification proves both. What changed is who resolves the
// capability. It used to be a fingerprint list in config/rca.config.json, and that
// list only ever knew the vendors someone had written down — so a New Relic,
// Dynatrace, Coralogix or Honeycomb customer matched nothing, was never even ASKED
// for their metrics scope, and was finally told to "Install promtool".
//
// Now the agent assigns tools to capabilities, because it knows what `newrelic-cli`
// is and a list cannot. `seedHints` in the table are exactly that — hints, to
// recognise the common cases cheaply and to keep a workspace that already has
// authored connector skills at parity. They are never authoritative, and an agent
// assignment always wins.
//
// What is left here is the part that must not vary: given an assignment, work out
// which scope questions are still owed, and refuse an assignment the table cannot
// honour. That is bookkeeping, and bookkeeping belongs in code.
//
// PURE. The environment and the assignment are passed in, never sensed: no
// child_process, no fs, no Date.now(). There is no probe executor and no command
// building at all — an earlier version interpolated customer scope into command
// templates from config, which is what produced a shell-injection escape, an
// attached-flag bypass, and a write-tool dispatch on the MCP route.

const norm = (s) => String(s ?? "").trim().toLowerCase();

/** Does an advertised MCP server or tool satisfy this hint?
 *
 * ONE-WAY: the server name must contain the hint. Two-way containment made the hint
 * "github-mcp" match a server named "hub", "git" or "it" — reporting GitHub present
 * on a machine with none. A hint is a distinctive substring you look for; it is not
 * a haystack. */
function mcpMatches(hint, server) {
  const h = norm(hint);
  const s = norm(server);
  if (!h || !s) return false;
  return s.includes(h);
}

/** A repo hint may name a directory (`k8s/`) or a file (`docker-compose.yml`).
 *  Every disjunct ends on a path boundary, so the hint "k8" cannot match
 *  "k8something/deployment.yaml". */
function fileMatches(hint, path) {
  const h = norm(hint).replace(/\/+$/, "");
  const p = norm(path);
  if (!h || !p) return false;
  return p === h || p.startsWith(`${h}/`) || p.includes(`/${h}/`) || p.endsWith(`/${h}`);
}

/**
 * Does anything in the environment match this row's hints?
 *
 * A CONVENIENCE, not a decision. It exists so the common cases need no thought. The
 * agent may ignore it entirely, and must, whenever the customer's stack is not one
 * of the names that happen to be listed — which is most customers.
 *
 * `kind` distinguishes a route from mere relevance: an executable or an MCP tool is
 * something you can call; a repo FILE is not. `k8s/` in the tree says infra matters
 * here and its questions are worth asking — it says nothing about whether this
 * machine can reach a cluster. Treating a file as a route made discovery report a
 * capability that verification then refused on the same machine.
 */
export function matchHint(row, env) {
  for (const exe of row?.seedHints?.executables ?? []) {
    if ((env.executables ?? []).some((e) => norm(e) === norm(exe))) {
      return { via: exe, kind: "executable", name: exe };
    }
  }
  for (const hint of row?.seedHints?.mcp ?? []) {
    const hit = (env.mcpServers ?? []).find((s) => mcpMatches(hint, s));
    if (hit) return { via: hit, kind: "mcp", name: hit };
  }
  for (const hint of row?.seedHints?.files ?? []) {
    const hit = (env.repoFiles ?? []).find((p) => fileMatches(hint, p));
    if (hit) return { via: `file:${hit}`, kind: "file", name: hit };
  }
  return null;
}

/**
 * Read resolved scope out of connector skills present on this machine.
 *
 * A workspace that already has authored connector skills carries a repo map, branch
 * conventions and scope the interview would otherwise ask for. Reading them keeps an
 * internal workspace at parity instead of regressing it to the customer path.
 *
 * The catch: this is externally-sourced data at four filesystem paths, one of them a
 * home directory. It may only fill fields the table DECLARES, so a connector cannot
 * invent scope nothing downstream reads. It no longer carries probe commands — there
 * are no probe commands anywhere now, which removes the reason this input needed a
 * command gate at all.
 *
 * `connectorSkills`: `[{name, path, capability, scope}]`, already parsed by the
 * caller, since parsing markdown is not this module's job.
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

    const declared = Object.keys(row?.scopeFields ?? {});
    const accepted = {};
    for (const [field, value] of Object.entries(skill.scope ?? {})) {
      if (declared.includes(field)) {
        accepted[field] = value;
      } else {
        violations.push({
          code: "connector-undeclared-field",
          capability: cap,
          field,
          source: skill.path ?? skill.name,
          message:
            `connector skill '${skill.name}' supplies '${field}', which the '${cap}' row does not ` +
            `declare — an answer nothing reads must not be accepted`,
        });
      }
    }
    scopeByCapability[cap] = { ...(scopeByCapability[cap] ?? {}), ...accepted };
  }

  return { scopeByCapability, violations };
}

/**
 * Plan the interview.
 *
 * `assigned` is the agent's own judgement: `{capability: {via, kind, why}}`. It wins
 * over hints unconditionally — that is the entire point. Anything the agent did not
 * assign falls back to `matchHint`, so familiar cases still need no thought.
 *
 * Returns:
 *   `routes`     — capabilities with a callable route. `buildManifest` consumes this.
 *   `relevant`   — capabilities the repo shows evidence for but this machine cannot
 *                  reach. Their questions ARE still asked, and the gate says why.
 *   `questions`  — the scope still owed, each naming the consumer that reads it.
 *   `unassigned` — tools present that no capability claims. One question, never an
 *                  assumption; the agent judges whether they matter.
 *   `violations` — an assignment the table cannot honour.
 */
export function planInterview({ table = {}, env = {}, assigned = {}, connectorSkills = [] } = {}) {
  const { scopeByCapability, violations } = preFillFromConnectorSkills(table, connectorSkills);

  const routes = [];
  const relevant = [];
  const questions = [];
  const claimed = new Set();

  for (const [capability, spec] of Object.entries(assigned)) {
    if (!table[capability]) {
      violations.push({
        code: "assigned-unknown-capability",
        capability,
        message:
          `'${capability}' is not a capability the table defines (${Object.keys(table).join(", ")}). ` +
          `Route an unfamiliar tool to the capability it SERVES, or leave it unassigned.`,
      });
    } else if (!String(spec?.via ?? "").trim()) {
      violations.push({
        code: "assigned-without-route",
        capability,
        message: `'${capability}' was assigned with no 'via' — name the tool or server that serves it`,
      });
    }
  }

  for (const [capability, row] of Object.entries(table)) {
    const declaredFields = Object.keys(row?.scopeFields ?? {});
    const preFilled = scopeByCapability[capability] ?? {};
    const unresolvedFields = declaredFields.filter((f) => preFilled[f] === undefined);

    // An always-asked row is never resolved without asking, even when something
    // coincidentally matches. `other` is the catch-all: resolving it by accident
    // would swallow the very unrecognised stack it exists to surface.
    const alwaysAsked = row?.resolvable === "always-asked";
    const byAgent = assigned[capability];
    const agentVia = String(byAgent?.via ?? "").trim();
    const hint = alwaysAsked ? null : matchHint(row, env);

    let route = null;
    if (!alwaysAsked && agentVia) {
      route = {
        via: agentVia,
        kind: byAgent.kind ?? "agent",
        name: agentVia,
        source: "agent",
        why: byAgent.why ?? null,
      };
    } else if (hint) {
      route = { ...hint, source: "hint", why: null };
    }

    if (route && route.kind === "file") {
      relevant.push({ capability, via: route.via, kind: "file", source: route.source });
    } else if (route) {
      claimed.add(norm(route.name));
      routes.push({
        capability,
        via: route.via,
        kind: route.kind,
        source: route.source,
        why: route.why,
        resolvedScope: preFilled,
        unresolvedFields,
      });
    }

    // Scope is owed whenever it is missing and the capability is in play. A relevant
    // capability owes its questions too: the repo shows `k8s/`, so the team HAS a
    // namespace even if this laptop cannot reach it, and a teammate who can will
    // inherit the answer.
    const inPlay = route !== null || alwaysAsked;
    if (unresolvedFields.length > 0 && inPlay) {
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

  // Tools present that no capability claims. One open record, never a wrong
  // assumption — the agent judges whether an unfamiliar CLI matters, which is
  // exactly the judgement a hardcoded ignore-list got wrong in both directions: it
  // reported `git` on every single run, and could never have reported a vendor
  // nobody had listed.
  const unassigned = [];
  for (const kind of ["executables", "mcpServers"]) {
    for (const name of env[kind] ?? []) {
      if (claimed.has(norm(name))) continue;
      if (hintedAnywhere(table, kind, name)) continue;
      unassigned.push({ kind: kind === "executables" ? "executable" : "mcp", name });
    }
  }

  return { routes, relevant, questions, unassigned, violations };
}

/** True when any row hints at this name — so a tool is not reported unassigned
 *  merely because its capability was resolved by a different route. Reuses
 *  matchHint so the rules cannot drift between the two uses. */
function hintedAnywhere(table, kind, name) {
  return Object.values(table).some((row) => matchHint(row, { [kind]: [name] }));
}
