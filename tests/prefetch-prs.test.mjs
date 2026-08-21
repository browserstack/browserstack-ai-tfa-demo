import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePrs } from "../bin/prefetch-prs.mjs";

// normalizePrs maps `gh pr list --json …,files` output to the canonical
// prsInWindow rows — the shape readers actually consume. The prod bug was a
// hand-rolled `topPRs` that dropped `files`; this keeps `files` first-class.

test("normalizePrs: keeps pr number, metadata, and flattens files to paths", () => {
  const raw = [
    { number: 7867, title: "TRAP-4119", mergedAt: "2026-08-20T12:26:06Z", url: "u1",
      files: [{ path: "a/b.js" }, { path: "c.js" }] },
  ];
  assert.deepEqual(normalizePrs(raw), [
    { pr: 7867, title: "TRAP-4119", mergedAt: "2026-08-20T12:26:06Z", url: "u1", files: ["a/b.js", "c.js"] },
  ]);
});

test("normalizePrs: tolerates string-file arrays and missing fields", () => {
  const raw = [{ number: 1, files: ["x.ts"] }, { number: 2 }];
  const out = normalizePrs(raw);
  assert.deepEqual(out[0].files, ["x.ts"]);
  assert.deepEqual(out[1].files, []);
  assert.equal(out[1].pr, 2);
});

test("normalizePrs: non-array input yields empty list", () => {
  assert.deepEqual(normalizePrs(null), []);
  assert.deepEqual(normalizePrs(undefined), []);
});
