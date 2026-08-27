import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { normalizePrs, parsePrList, hydrateSuppliedPrs } from "../bin/prefetch-prs.mjs";

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

// --- parsePrList: the customer's supplied candidate set -----------------------
//
// The supplied list replaces ENUMERATION (the window search), not analysis — it is the
// superset of merged PRs, good and bad, and finding the bad ones is still ours. So what
// this parser gets wrong lands directly in the candidate set.

test("parsePrList: a bare list is every number in it", () => {
  assert.deepEqual(parsePrList("7900,7892,7898"), [7900, 7892, 7898]);
  assert.deepEqual(parsePrList("7900 7892"), [7900, 7892], "spaces too — people paste both");
  assert.deepEqual(parsePrList(" 7900 , 7892 "), [7900, 7892]);
  assert.deepEqual(parsePrList("7900,7900,7892"), [7900, 7892], "deduped: a repeat is not two candidates");
});

test("parsePrList: in PROSE, only an explicit PR marker counts", () => {
  // MUTATION: scrape every integer regardless of form -> fails.
  //
  // THE bug this test exists for. The real invocation is a pasted regression-bot message
  // carrying a JIRA ticket and a timestamp beside the PR links. Scraping every integer
  // read `TRAP-4767` as PR 4767 and `[2:55 PM]` as PRs 2 and 55 — three unrelated PRs
  // fetched and added to the candidate set, silently, in the one place the customer was
  // being explicit about scope.
  const paste = [
    "Slot2RegressionBot  [2:55 PM]",
    "Owner @Some One",
    "JIRA Ticket",
    "https://browserstack.atlassian.net/browse/TRAP-4767",
    "PR(s)",
    "https://github.com/browserstack/observability-api/pull/9254",
    "https://github.com/browserstack/observability-pipeline/pull/7900",
  ].join("\n");

  assert.deepEqual(parsePrList(paste), [9254, 7900], "the two /pull/ URLs, and nothing else");

  assert.deepEqual(parsePrList("fixed by #7900 and #7892"), [7900, 7892], "#N is a PR reference");
  assert.deepEqual(parsePrList("TRAP-4767"), [], "a ticket is not a PR");
  assert.deepEqual(parsePrList("regression at [2:55 PM]"), [], "a timestamp is not a PR");
  assert.deepEqual(parsePrList("see the 9254 change"), [],
    "a bare integer in prose is not a marker — being wrong here adds a phantom candidate");
});

test("parsePrList: nothing usable yields an empty list, never a guess", () => {
  // The CLI turns an empty result into a usage error rather than writing
  // `prsSearched: true` with no PRs — which would assert "searched, found none" about a
  // search that never ran, the exact confusion prsSearched exists to prevent.
  for (const v of ["", "   ", null, undefined, 7900, {}, []]) {
    assert.deepEqual(parsePrList(v), [], `${JSON.stringify(v)} yields nothing`);
  }
});

test("both enumeration sources are documented in the usage text", () => {
  // MUTATION: drop the --prs usage line -> fails. The window form and the supplied form
  // share one binary precisely so hydration, the row shape and `prsSearched: true` cannot
  // drift between them; a caller who cannot discover the second form re-implements it.
  const src = readFileSync(new URL("../bin/prefetch-prs.mjs", import.meta.url), "utf8");
  assert.match(src, /--prs <n,n,n>/u, "the supplied-list form must appear in usage");
  assert.match(src, /<branch> <fromISO> <toISO>/u, "and the window form must survive it");
  assert.match(src, /gh pr view|"pr", "view"/u,
    "a supplied list is not a search, so it hydrates per PR with `gh pr view`");
});

test("hydrateSuppliedPrs: one unfetchable PR is skipped, the rest survive", () => {
  // MUTATION: rethrow instead of skipping -> fails.
  // The customer named several PRs; losing all of them because one number was mistyped
  // is worse than proceeding with the rest. Designed behaviour that shipped untested —
  // a mutation that failed the whole run survived the suite.
  const fetchOne = (repo, n) => {
    if (n === 7892) throw new Error("Could not resolve to a PullRequest");
    return { number: n, title: `t${n}`, author: { login: "who" }, files: [{ path: "a.ts" }] };
  };
  const out = hydrateSuppliedPrs("acme/api", [7900, 7892, 7898], fetchOne);
  assert.deepEqual(out.map((p) => p.number), [7900, 7898], "the good ones are kept");
});

test("hydrateSuppliedPrs: ALL unfetchable throws, rather than writing an empty list", () => {
  // MUTATION: return [] instead of throwing -> fails.
  // Returning empty would write `prsInWindow: []` with `prsSearched: true` — asserting
  // "the candidate set is complete and there is nothing in it", which is the precise
  // confusion prsSearched exists to prevent (lib/evidence-file.mjs:463-479).
  const boom = () => { throw new Error("nope"); };
  assert.throws(
    () => hydrateSuppliedPrs("acme/api", [1, 2], boom),
    /none of the 2 supplied PR\(s\) could be fetched/u,
  );
});

test("the CLI refuses --prs with nothing readable in it", () => {
  // MUTATION: drop the `supplied.length === 0` guard -> exit 0 and an empty list is
  // written with prsSearched:true -> fails.
  const cli = new URL("../bin/prefetch-prs.mjs", import.meta.url).pathname;
  const run = (...argv) => {
    try {
      execFileSync(process.execPath, [cli, ...argv], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { status: 0, stderr: "" };
    } catch (err) {
      return { status: err.status, stderr: String(err.stderr ?? "") };
    }
  };

  const empty = run("b1", "acme/api", "--prs", "");
  assert.equal(empty.status, 2, "a usage error, not a run that writes an empty candidate set");
  assert.match(empty.stderr, /no PR number could be read/u);

  const prose = run("b1", "acme/api", "--prs", "see TRAP-4767");
  assert.equal(prose.status, 2, "a ticket is not a PR number, so nothing was readable");

  // And the window form still requires its own args.
  assert.equal(run("b1", "acme/api").status, 2, "the window form needs branch and both bounds");
  assert.equal(run().status, 2);
});
