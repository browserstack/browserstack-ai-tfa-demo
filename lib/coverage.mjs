// Evidence-coverage stamp (ideation #6, v1 — the per-row coverage band; the
// build-level blast-radius digest is deferred). A RESOLVED RCA built with
// k8s+kibana+metrics all "unavailable" must not read like one with full
// evidence. The client (which routed every ask) stamps each row with a coverage
// vector and derives a coverage-capped confidence band the reviewer sees:
// "low confidence BECAUSE kibana was unavailable", not "low confidence, trust me".

const BAND_ORDER = ["low", "medium", "high"];

// coverage classification from what was fulfilled vs. left unavailable.
export function classifyCoverage(asksFulfilled = [], asksUnavailable = []) {
  const unavailable = [...new Set(asksUnavailable.filter(Boolean))];
  const fulfilled = [...new Set(asksFulfilled.filter(Boolean))];
  if (unavailable.length === 0) return "full";
  if (fulfilled.length > 0) return "partial";
  return "thin";
}

// Cap the band: full coverage keeps TFA's confidence; partial caps at medium;
// thin caps at low. Unknown/absent TFA confidence floors to low.
function capBand(tfaConfidence, coverage) {
  const base = BAND_ORDER.includes(tfaConfidence) ? tfaConfidence : "low";
  const cap = coverage === "full" ? "high" : coverage === "partial" ? "medium" : "low";
  return BAND_ORDER[Math.min(BAND_ORDER.indexOf(base), BAND_ORDER.indexOf(cap))];
}

// The stamp written to a row at flip time. Returns { coverage, band, unavailable }.
export function coverageStamp({
  asksFulfilled = [],
  asksUnavailable = [],
  tfaConfidence = "unknown",
} = {}) {
  const coverage = classifyCoverage(asksFulfilled, asksUnavailable);
  return {
    coverage,
    band: capBand(tfaConfidence, coverage),
    unavailable: [...new Set(asksUnavailable.filter(Boolean))],
  };
}
