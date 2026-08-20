// Loads tests/fixtures/discovery/*.json for both tests/discovery.test.mjs and the
// worked-example drift check in tests/prose-budget.test.mjs.
//
// Shared because both encode the fixture SCHEMA. Two copies meant renaming a
// fixture key would break the doc-drift guard in a way that looked unrelated to
// discovery.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./mandated-reading.mjs";

export const FIXTURE_DIR = join(ROOT, "tests/fixtures/discovery");

export function discoveryFixtures() {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ file: f, ...JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) }));
}

/** Every capability name any fixture mentions, available or not. */
export function knownCapabilities(fixtures = discoveryFixtures()) {
  return new Set(
    fixtures.flatMap((fx) => [...(fx.expect.available ?? []), ...(fx.expect.unavailable ?? [])]),
  );
}

/** Every route any fixture's environment provides, plus the `via` values expected
 *  and anything an agent assignment names. */
export function knownRoutes(fixtures = discoveryFixtures()) {
  return new Set([
    ...fixtures.flatMap((fx) => Object.values(fx.expect.via ?? {})),
    ...fixtures.flatMap((fx) => fx.env.executables ?? []),
    ...fixtures.flatMap((fx) => fx.env.mcpServers ?? []),
    ...fixtures.flatMap((fx) => fx.env.repoFiles ?? []),
    ...fixtures.flatMap((fx) => Object.values(fx.assigned ?? {}).map((a) => a.via)),
  ]);
}
