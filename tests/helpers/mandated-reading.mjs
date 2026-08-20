// Shared by tests/wiring.test.mjs and tests/prose-budget.test.mjs.
//
// Both need to answer "what does this skill's flow require loading?", and two
// implementations of that parse would drift — which is the exact bug class
// wiring.test.mjs exists to catch. One parser, two callers.
//
// Lives under tests/ rather than lib/ deliberately: a lib module would be subject
// to the API-reference guard, and a test helper has no business in a skill's
// documented surface.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

export const ROOT = new URL("../..", import.meta.url).pathname;

/** Skills whose bodies and mandated reading are subject to both guards. */
export const SKILLS = ["rca-build", "rca-setup"];

export const skillBodyPath = (skill) => join(ROOT, "skills", skill, "SKILL.md");

/**
 * The files a skill's flow requires loading: its own body, plus every
 * pluginRoot-qualified path listed under its `## Mandated reading` heading.
 *
 * The body counts as its own mandated reading because an agent always reads it.
 * That is what lets rca-build's inline API reference satisfy the documentation
 * guard where it already sits, instead of forcing a mechanical relocation.
 *
 * Returns `[{path, text}]`, nearest-to-the-agent first (body, then declared files),
 * so a caller can either concatenate for a substring search or sum line counts.
 */
export function mandatedFiles(skill) {
  const bodyPath = skillBodyPath(skill);
  const body = readFileSync(bodyPath, "utf8");
  const files = [{ path: bodyPath, text: body }];

  const section = body.split(/^## Mandated reading\s*$/m)[1];
  assert.ok(
    section !== undefined,
    `skills/${skill}/SKILL.md has no "## Mandated reading" section — neither guard ` +
      `can tell which files this skill's flow requires loading.`,
  );

  const declared = section.split(/^## /m)[0];
  for (const m of declared.matchAll(/`<pluginRoot>\/([^`]+)`/g)) {
    const p = join(ROOT, m[1]);
    if (p === bodyPath) continue; // already included
    if (existsSync(p)) files.push({ path: p, text: readFileSync(p, "utf8") });
  }
  return files;
}

/** Concatenated text of everything the skill mandates reading. */
export function mandatedReading(skill) {
  return mandatedFiles(skill).map((f) => f.text).join("\n");
}

/** Non-empty line count, so blank-line reflowing cannot game a budget. */
export function countLines(text) {
  return String(text).split("\n").filter((l) => l.trim().length > 0).length;
}

/**
 * Lines a skill's flow costs: its body plus every file it mandates reading.
 *
 * Measuring the body alone is the loophole this closes. Relocating prose from a
 * body into a file the run is told to load every time reduces the body's count and
 * changes nothing about what actually reaches the model.
 */
export function mandatedLineCount(skill, { ceiling = null } = {}) {
  const files = mandatedFiles(skill);
  const perFile = files.map((f) => ({ path: f.path.replace(ROOT, ""), lines: countLines(f.text) }));
  const total = perFile.reduce((n, f) => n + f.lines, 0);
  return { skill, total, perFile, ceiling, over: ceiling !== null && total > ceiling };
}
