// The prose budget (R29 mechanism).
//
// The failure this exists to prevent is documented in the run skill's own history:
// SKILL.md was 124 lines on 2026-06-23, 204 on 2026-07-13, and 1185 at the point
// this milestone started. Almost none of that growth was procedure. Each production
// bug got written back as more prose in the same file, and past a few hundred lines
// compliance with any single rule drops — which produces more violations, which
// produces more prose. Commit 164962f added 52 lines enforcing parallel dispatch;
// 395960c added 82 more because the same rule was violated again; the file itself
// concedes "Restating the rule again clearly did not prevent that."
//
// Two design choices, both load-bearing:
//
//   1. The budget measures the body PLUS every file the skill mandates reading.
//      Measuring the body alone is a loophole: relocating prose into a file the run
//      is told to load every time reduces the body's count and changes nothing
//      about what reaches the model.
//   2. The ceiling is a PARAMETER. A loose placeholder measured against real bodies
//      would pass by construction, shipping a check whose failure path has never
//      run. The over-ceiling case is asserted against a fixture instead.
//
// The binding numbers are deliberately loose in milestone 1 and get set in
// milestone 2 against the rewritten bodies. What ships here is the mechanism, with
// its failure path proven.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT,
  SKILLS,
  countLines,
  mandatedFiles,
  mandatedLineCount,
} from "./helpers/mandated-reading.mjs";

/** Measured at milestone 1, with just enough headroom to absorb a genuine procedure
 *  addition and not enough to absorb a paragraph of scolding. Deliberately NOT a
 *  round placeholder: a ceiling far above reality passes by construction and stops
 *  being a budget. Milestone 2 tightens rca-build as its body shrinks — the failure
 *  message prints every measured total so that number comes from recorded data. */
const CEILINGS = {
  "rca-build": 1500, // 1487 today. The whole point of milestone 2 is to move this down.
  "rca-setup": 650, // 617 today.
};

const measure = (skill) => mandatedLineCount(skill);
// Parameterised so the comparison itself is testable. As a closure over CEILINGS
// it could only ever be called with a ceiling the real bodies pass, which is why
// the test below asserted around it instead of through it.
const over = (skill, ceiling = CEILINGS[skill]) => measure(skill).total > ceiling;

test("every skill's mandated reading stays inside its budget", () => {
  const report = SKILLS.map(measure);
  assert.deepEqual(
    SKILLS.filter((s) => over(s)).map((s) => `${s}: ${measure(s).total} > ${CEILINGS[s]}`),
    [],
    `over budget. Measured totals (body + mandated reading):\n` +
      report
        .map(
          (r) =>
            `  ${r.skill}: ${r.total}/${CEILINGS[r.skill]}\n` +
            r.perFile.map((f) => `      ${f.lines.toString().padStart(5)}  ${f.path}`).join("\n"),
        )
        .join("\n") +
      `\n\nA bug fix may not add prose to a skill body. Add a test, a code guard, or a ` +
      `required output shape instead.`,
  );
});

test("the measured total is the body PLUS mandated reading, not the body alone", () => {
  for (const skill of SKILLS) {
    const files = mandatedFiles(skill);
    assert.ok(files.length > 1, `${skill} must mandate at least one reference file`);
    assert.ok(
      measure(skill).total > countLines(files[0].text),
      `${skill}: total must exceed body-only`,
    );
  }
});

test("relocating prose from a body into mandated reading does not reduce the total", () => {
  // Sum the same file set three ways. An earlier version carried a term identical
  // on both sides of the equality, so it cancelled out and proved nothing.
  const texts = mandatedFiles("rca-setup").map((f) => f.text);
  const sum = (ts) => ts.reduce((n, t) => n + countLines(t), 0);
  const block = "\n\nSome relocated paragraph.\nA second line of it.\n";

  const inBody = sum([texts[0] + block, ...texts.slice(1)]);
  const inReference = sum([texts[0], texts[1] + block, ...texts.slice(2)]);

  assert.equal(inBody, inReference, "a relocation must be budget-neutral");
  assert.equal(inBody, sum(texts) + 2, "and two added lines must cost exactly two");
});

test("the over-ceiling comparison fails when the ceiling is below the measured total", () => {
  // This test previously asserted `r.total > 1` and `r.perFile.length > 1` and never
  // called over() at all — so rewriting over() to `return false` would have left it
  // green, which is precisely the "failure path never executed" problem its own
  // comment warned about. Now it drives the comparison in both directions.
  const r = measure("rca-setup");
  assert.equal(over("rca-setup", 1), true, "a ceiling of 1 must be exceeded");
  assert.equal(over("rca-setup", r.total), false, "the measured total is not OVER itself");
  assert.equal(over("rca-setup", r.total - 1), true, "one line below the total is over");
  assert.ok(r.perFile.length > 1, "and the report must name every file that contributed");
});

test("blank lines cannot game the budget", () => {
  assert.equal(countLines("a\n\n\n\nb"), 2);
  assert.equal(countLines("   \n\t\n"), 0);
});

// ---- the worked example must match the fixtures it claims to match ----------

test("the worked example names only capabilities and routes the discovery fixtures contain", () => {
  // Without this the example rots: it is the first thing a human reads and the last
  // thing anyone re-checks, so it drifts from the behaviour it illustrates and then
  // teaches the wrong shape.
  const examplePath = join(ROOT, "skills/rca-setup/examples/sample-setup.md");
  assert.ok(existsSync(examplePath), "the worked example must exist");
  const example = readFileSync(examplePath, "utf8");

  const fixtureDir = join(ROOT, "tests/fixtures/discovery");
  const fixtures = readdirSync(fixtureDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(fixtureDir, f), "utf8")));

  const knownCapabilities = new Set(
    fixtures.flatMap((fx) => [...(fx.expect.available ?? []), ...(fx.expect.unavailable ?? [])]),
  );
  // Includes repoFiles: a file fingerprint like `k8s/` legitimately matches a
  // fixture's `k8s/deployment.yaml`, the same prefix rule discovery itself applies.
  const knownRoutes = new Set([
    ...fixtures.flatMap((fx) => Object.values(fx.expect.via ?? {})),
    ...fixtures.flatMap((fx) => fx.env.executables ?? []),
    ...fixtures.flatMap((fx) => fx.env.mcpServers ?? []),
    ...fixtures.flatMap((fx) => fx.env.repoFiles ?? []),
  ]);

  // Parse ONLY the digest's `Capabilities:` block. A looser line-shape regex also
  // matched per-target rows such as "main ✅ 7 PRs merged in the last 30 days",
  // which are verification targets, not capabilities — and then reported `main` as
  // an unknown capability, which is a false positive that would teach people to
  // ignore this test.
  const capBlocks = [...example.matchAll(/^Capabilities:\n((?: {2}.+\n)+)/gmu)].map((m) => m[1]);
  assert.ok(capBlocks.length > 0, "the example must contain a gate digest with a Capabilities block");
  const claimedCapabilities = capBlocks
    .flatMap((b) => [...b.matchAll(/^ {2}(\w+)\s/gmu)])
    .map((m) => m[1]);
  assert.ok(claimedCapabilities.length > 0, "the example must show capability rows");
  for (const cap of new Set(claimedCapabilities)) {
    assert.ok(
      knownCapabilities.has(cap),
      `the example shows capability '${cap}', which no discovery fixture contains`,
    );
  }

  // Routes the example claims discovery found, from its own found-on-this-machine list.
  const claimed = [...example.matchAll(/^ {2}(\S+)\s+→\s+(\w+)/gmu)];
  assert.ok(claimed.length > 0, "the example must show what discovery found");
  for (const [, route, cap] of claimed) {
    const bare = route.replace(/\/$/, "");
    assert.ok(
      knownCapabilities.has(cap),
      `the example routes '${route}' to capability '${cap}', which no fixture contains`,
    );
    assert.ok(
      knownRoutes.has(route) || knownRoutes.has(bare) || [...knownRoutes].some((r) => r.includes(bare)),
      `the example claims discovery finds '${route}', which no fixture's environment provides`,
    );
  }
});
