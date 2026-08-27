import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizePrs } from "../bin/prefetch-prs.mjs";

// normalizePrs maps `gh pr list --json …,files` output to the canonical
// prsInWindow rows — the shape readers actually consume. The prod bug was a
// hand-rolled `topPRs` that dropped `files`; this keeps `files` first-class.

test("normalizePrs: keeps pr number, metadata, and flattens files to paths", () => {
  const raw = [
    { number: 7867, title: "TRAP-4119", author: { login: "jdoe" },
      mergedAt: "2026-08-20T12:26:06Z", url: "u1",
      files: [{ path: "a/b.js" }, { path: "c.js" }] },
  ];
  assert.deepEqual(normalizePrs(raw), [
    { pr: 7867, title: "TRAP-4119", author: "jdoe", mergedAt: "2026-08-20T12:26:06Z", url: "u1",
      files: ["a/b.js", "c.js"] },
  ]);
});

test("normalizePrs: author is first-class, and flattened to a login", () => {
  // `tfaRcaTurn`'s `prDetails` REQUIRES author per PR, and this pre-fetch is the only
  // place PRs are read once for every coordinator to share. Missing here, each
  // coordinator pays a `gh pr view` per suspect to fill one field — the per-coordinator
  // re-fetching this binary exists to remove. Same reason `files` is first-class: the
  // prod bug was a hand-rolled projection that dropped a field readers needed.
  //
  // MUTATION: drop `author` from the mapping, or from the --json projection -> fails.
  const out = normalizePrs([
    { number: 1, author: { login: "fromobject" } },
    { number: 2, author: "fromstring" },
    { number: 3 },
    { number: 4, author: {} },
  ]);
  assert.equal(out[0].author, "fromobject", "gh returns an object; readers want the login");
  assert.equal(out[1].author, "fromstring", "already-flat input passes through");
  assert.equal(out[2].author, null, "absent is null, never undefined — the row shape is fixed");
  assert.equal(out[3].author, null, "an author object with no login is absent, not '[object Object]'");

  // The projection has to ask for it, or the mapping has nothing to flatten.
  const src = readFileSync(new URL("../bin/prefetch-prs.mjs", import.meta.url), "utf8");
  const projection = src.match(/"--json", "([^"]+)"/u)?.[1] ?? "";
  assert.ok(projection.split(",").includes("author"),
    `--json projection must request author (got: ${projection})`);
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
