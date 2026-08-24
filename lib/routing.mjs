// Evidence-routing registry (D3). Maps a TFA `ask.evidenceType` onto an
// action, given the run's validated capability manifest. Pure + dependency-free
// so it is testable and reusable by the batch workflow, subagents, and the
// sequential harness alike.
//
// `test_logs` is the TFA agent's own evidence and is always skipped. Every
// other type routes to a capability; whether that capability is *available* is
// decided by the manifest (built once per run — see U6 / buildManifest).

import { readFileSync } from "node:fs";

export const TEST_LOGS = "test_logs";

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

// Load and parse config/rca.config.json from an absolute or cwd-relative path.
export function loadConfig(configPath) {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

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

  // No `discoveryHints` here. It was a list of vendor names carried from config
  // into this payload and read by NOTHING but this module's own test — so it
  // taught a default while informing no decision. What serves a capability is
  // judgement, recorded in the setup context, not a list shipped by us.
  return { evidenceType, action: "gap", capability, reason: "no-capability" };
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
  const routes = Object.values(config?.evidenceRouting ?? {}).filter(
    (e) => !e.skip && e.owner !== "tfa" && e.capability,
  );

  const manifest = {};
  for (const entry of routes) {
    const cap = entry.capability;
    if (cap in manifest) continue;
    const found = byCap.get(cap);
    manifest[cap] = found
      ? { available: true, via: found.via ?? null }
      : { available: false, via: null };
  }

  // Resolve `fallbackCapability` HERE rather than in routeAsk, in a second pass so
  // declaration order cannot decide the outcome.
  //
  // `ci` is its own capability because a team's CI system is frequently not their
  // git forge. But for the many teams where it IS, flipping `ci` off `github`
  // would silently turn every ci ask into a gap — and, worse,
  // `unavailableCapabilities` would declare ci missing to TFA on turn 1 while
  // nothing was actually wrong. Resolving it here means both readers see one
  // consistent answer; doing it in routeAsk would have left this function
  // reporting a gap the router then quietly served.
  //
  // Single hop only: the fallback target is looked up in `discovered`, never in
  // `manifest`, so a fallback never chains to another fallback — `a -> b -> c`
  // cannot smuggle in a third capability, and no cycle is possible.
  //
  // There is deliberately no `fb === cap` check: it would be unreachable. Reaching
  // this line means `cap` was not discovered, so `byCap.get(cap)` is empty too and
  // the `!target` guard below already returns. A test for it could not be made to
  // fail, and this repo has shipped four guards like that already.
  for (const entry of routes) {
    const cap = entry.capability;
    const fb = entry.fallbackCapability;
    if (!fb || manifest[cap]?.available) continue;
    const target = byCap.get(fb);
    if (!target) continue;
    manifest[cap] = { available: true, via: target.via ?? null, viaFallback: fb };
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
