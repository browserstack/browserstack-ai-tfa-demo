// Evidence-routing registry (D3). Maps a TFA `ask.evidenceType` onto an
// action, given the run's validated capability manifest. Pure + dependency-free
// so it is testable and reusable by the batch workflow, subagents, and the
// sequential harness alike.
//
// `test_logs` is the TFA agent's own evidence and is always skipped. Every
// other type routes to a capability; whether that capability is *available* is
// decided by the manifest (built once per run — see U6 / buildManifest).


export const TEST_LOGS = "test_logs";

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

// Load and parse config/rca.config.json from an absolute or cwd-relative path.
// Order a turn's asks high → medium → low (unknown priority sorts last).
export function orderAsks(asks = []) {
  return [...asks].sort(
    (a, b) =>
      (PRIORITY_RANK[a?.priority] ?? 99) - (PRIORITY_RANK[b?.priority] ?? 99),
  );
}

// Classify one ask. Returns one of:
//   { action: "skip",   ... }  — test_logs / TFA-owned; the coordinator emits nothing
//   { action: "gather", ... }  — a capability is available; gather + digest
//   { action: "gap",    ... }  — no valid connector; the caller emits an
//                                "unavailable" block back to TFA (never a prompt)
//
// `manifest` shape: { [capability]: { available: boolean, via?: string } }.
export function routeAsk(ask, config, manifest = {}) {
  const evidenceType = ask?.evidenceType ?? "other";
  const routing = config?.evidenceRouting ?? {};
  const entry = routing[evidenceType] ?? routing.other ?? { capability: "other" };

  if (entry.skip || entry.owner === "tfa") {
    return { evidenceType, action: "skip", reason: "tfa-owned" };
  }

  const capability = entry.capability ?? "other";
  const cap = manifest[capability];
  if (cap && cap.available) {
    return {
      evidenceType,
      action: "gather",
      capability,
      via: cap.via ?? null,
    };
  }

  return {
    evidenceType,
    action: "gap",
    capability,
    reason: "no-capability",
  };
}

// Split a turn's asks into the three buckets, in priority order. The
// coordinator gathers `gather`, emits an "unavailable" block for each `gap`,
// and records `skip` (test_logs) without emitting anything.
export function routeAsks(asks, config, manifest = {}) {
  const ordered = orderAsks(asks);
  const buckets = { skip: [], gather: [], gap: [] };
  for (const ask of ordered) {
    const routed = routeAsk(ask, config, manifest);
    buckets[routed.action].push({ ask, ...routed });
  }
  return buckets;
}

// ---- capability manifest (ideation #3) -------------------------------------

// Build the capability manifest ONCE per run from the capabilities the client
// agent actually discovered. `discovered` is a list of
// { capability, via } the orchestrator collected by asking "what skills/tools
// are available?". Every capability the routing registry references (except the
// TFA-owned test_logs) appears in the manifest, marked available iff discovered.
// Declaring this to TFA lets it avoid asking for evidence the client can't get.
export function buildManifest(config, discovered = []) {
  const byCap = new Map(discovered.map((d) => [d.capability, d]));
  const manifest = {};
  for (const entry of Object.values(config?.evidenceRouting ?? {})) {
    if (entry.skip || entry.owner === "tfa") continue;
    const cap = entry.capability;
    if (!cap || cap in manifest) continue;
    const found = byCap.get(cap);
    // Deliberately just {available, via}. An earlier draft widened this with
    // resolvedScope/unresolvedFields/tag/gapClass for the setup gate, but nothing
    // read them HERE: routeAsk branches on `available` and reads `via`, and the
    // setup flow consumes those fields off discover()'s own `discovered[]` array
    // without ever calling buildManifest. Four unread fields on a shared run-path
    // entry is the accretion this plugin is trying to get out of, not a head start.
    manifest[cap] = found
      ? { available: true, via: found.via ?? null }
      : { available: false, via: null };
  }
  return manifest;
}

// Capabilities that will be unavailable this run — declared to the user up front
// ("infra + metrics not available") and to TFA so it plans asks around them.
export function unavailableCapabilities(manifest) {
  return Object.entries(manifest)
    .filter(([, v]) => !v.available)
    .map(([cap]) => cap);
}
