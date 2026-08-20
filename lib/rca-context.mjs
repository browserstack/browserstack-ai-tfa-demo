// The committed context artifact (R22-R26) — read, resolve, write, version.
//
// This module is the ONE place in lib/ that deliberately does not harden what it
// writes. Every other persisted artifact here (csv-state, evidence-file,
// turn1-registry, tool-cache) creates 0700 directories and 0600 files, and
// state-dir sweeps the tree to match. That is right for OS-temp run state and
// wrong for this: the context is git-tracked, git does not preserve the mode, and
// a 0600 file in a repo is a confusing artifact rather than a protected one.
// `hardenStateDir` must never be pointed at it.
//
// Owned by BOTH skills: the setup flow writes it, and the run skill's gate reads
// it through resolveIntake. tests/wiring.test.mjs enforces that its exports are
// documented in both skills' mandated reading, not just one.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { MANDATORY_CAPABILITY, looksLikeSecret } from "./verify.mjs";

/** Deliberately NOT under `.rca/`, which holds per-run state and is gitignored by
 *  convention — a context placed there would trip this module's own check-ignore
 *  guard and refuse to persist. */
export const CONTEXT_FILENAME = ".rca-context.json";

export const SCHEMA_VERSION = 1;

/** How a credential is referenced. Never the value itself. */
export const CREDENTIAL_KIND = {
  /** The customer exports it; we persist only the variable's NAME. */
  ENV_VAR: "env-var",
  /** `gh` via keyring or device flow has no variable to name. Without this kind a
   *  teammate is told to export something the first engineer never used. */
  PROVIDER_MANAGED: "provider-managed",
};

const REQUIRED_FIELDS = ["schemaVersion", "homeRepo", "complete"];

/** How far up to walk, matching discoverWorkspaceRoot's bounded 3 tries. Guessing
 *  harder risks reading an unrelated checkout, which is silently wrong. */
const MAX_LEVELS = 3;

/** Canonical form of a path, so the read side and the write side never disagree
 *  about the same file. `git rev-parse --show-toplevel` always reports a realpath,
 *  while a directory walk reports whatever it was handed — and on macOS `/var` is a
 *  symlink to `/private/var`, so the two differ for every temp-dir path. Returning
 *  two spellings of one location from two functions is a bug waiting for a caller
 *  that compares them. */
function canonical(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * `git check-ignore -v` exits 0 when the path IS ignored and 1 when it is not, so
 * a throw is the ordinary "not ignored" answer here.
 *
 * But only exit 1 means that. A bare `catch` also swallowed exit 128 — git failing
 * outright on a corrupt index, an unreadable excludes file, a broken worktree — and
 * reported it as "not ignored", letting the write proceed on the strength of a
 * question git never actually answered. `rev-parse` succeeding does not imply
 * `check-ignore` will.
 *
 * Returns `{ignored, rule}` or `{error}`.
 */
function ignoreRuleFor(dir, relPath) {
  try {
    const out = git(dir, ["check-ignore", "-v", "--", relPath]);
    return { ignored: true, rule: out.trim() || "an unnamed .gitignore rule" };
  } catch (err) {
    if (err?.status === 1) return { ignored: false };
    return { error: err?.status === undefined ? "git could not be run" : `git exited ${err.status}` };
  }
}

/** `git` with the exit status kept, for the callers that need to tell "no" from
 *  "could not answer". */
function gitTry(dir, args) {
  try {
    return { ok: true, out: git(dir, args) };
  } catch (err) {
    return { ok: false, status: err?.status ?? null };
  }
}

/** Is this file tracked by the repo it sits in? A committed context is tracked by
 *  construction — that is the entire point of committing it — so this separates an
 *  inherited context from a file that merely happens to share the name. */
function isTracked(dir, relPath) {
  return gitTry(dir, ["ls-files", "--error-unmatch", "--", relPath]).ok;
}

/** Does this worktree's origin remote name `homeRepo`? The basename check alone
 *  refuses a repo cloned into a differently-named directory — `acme/api` cloned as
 *  `api-service`, a renamed repo, a linked worktree — which dead-ended setup AFTER
 *  the whole interview had completed, with a next action the customer had already
 *  done ("run setup from inside the repository"). */
function originNames(dir, homeRepo) {
  const r = gitTry(dir, ["remote", "get-url", "origin"]);
  if (!r.ok) return false;
  const url = r.out.trim().replace(/\.git$/, "");
  const slug = String(homeRepo ?? "").replace(/^\/+|\/+$/g, "");
  if (!slug) return false;
  return url.endsWith(`/${slug}`) || url.endsWith(`:${slug}`);
}

function worktreeRoot(dir) {
  try {
    const root = git(dir, ["rev-parse", "--show-toplevel"]).trim();
    return root ? canonical(root) : null;
  } catch {
    return null;
  }
}

/** Bounded candidate directories: each level from `from` upward, plus that level's
 *  immediate children.
 *
 *  The children half is what makes a sibling layout work. Clones sit side by side
 *  under a workspace root, so a context committed to the product repo is invisible
 *  from the automation repo or from the plugin directory if you only walk upward —
 *  and the no-context refusal would then fire on a fully set-up machine. */
function childDirs(dir) {
  try {
    // withFileTypes avoids a stat per entry. A symlinked sibling clone reports as a
    // symlink rather than a directory, so those get the explicit stat they need.
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .filter((e) => {
        if (e.isDirectory()) return true;
        if (!e.isSymbolicLink()) return false;
        try { return statSync(join(dir, e.name)).isDirectory(); } catch { return false; }
      })
      .map((e) => join(dir, e.name));
  } catch {
    return []; // unreadable level — skip its children
  }
}

function candidateDirs(from) {
  // Nearest first, de-duplicated on the cheap `resolve` spelling. Canonicalisation
  // is deliberately NOT done here: a walk yields ~140 candidates and all but one or
  // two are discarded, so realpath'ing every one lstats every path component of a
  // directory nobody will look at. Callers canonicalise the survivor instead.
  const out = new Set();
  let dir = resolve(from);
  for (let level = 0; level < MAX_LEVELS; level++) {
    out.add(dir);
    for (const child of childDirs(dir)) out.add(child);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...out];
}

/** Does this directory plausibly hold the context its own declaration claims? */
function homeRepoMatches(dir, homeRepo) {
  return basename(dir) === basename(String(homeRepo ?? ""));
}

/**
 * Locate the context file, or null.
 *
 * `pluginRoot` is always refused as a candidate: the documented install flow is
 * `git clone <plugin> && cd <plugin> && claude --plugin-dir ./`, so cwd IS the
 * plugin directory on a first run. Writing or reading a context there would put it
 * somewhere no teammate ever inherits it.
 */
export function findContextFile({ from = process.cwd(), pluginRoot = null } = {}) {
  const found = locateContext({ from, pluginRoot });
  return found ? found.path : null;
}

/** Locate the context and return its already-read bytes.
 *
 * Returning `raw` matters: the caller has to parse this file to decide whether the
 * candidate's declared homeRepo matches its directory, and readRcaContext then
 * needed the same bytes — so the file was opened and parsed twice per read. */
function locateContext({ from = process.cwd(), pluginRoot = null } = {}) {
  const forbidden = pluginRoot ? canonical(pluginRoot) : null;
  const ownRoot = worktreeRoot(from);

  for (const dir of candidateDirs(from)) {
    const path = join(dir, CONTEXT_FILENAME);
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue; // absent or unreadable — try the next candidate
    }
    if (forbidden && canonical(dir) === forbidden) continue;

    // Adoption test, applied BEFORE anything the file says about itself.
    //
    // The walk covers cwd, cwd's children, and two levels up plus each of THEIR
    // children — around 140 directories. The only previous test was
    // `basename(dir) === basename(parsed.homeRepo)`, and homeRepo is a value the
    // file supplies, so any .rca-context.json in any repo cloned nearby was adopted
    // by naming its own directory. That file then drives the run: resolveIntake
    // ranks the context above connector defaults and inference, so repos, branch,
    // namespace and the capabilities overlay all come from it.
    //
    // Two things are trustworthy: the worktree we were actually invoked from, and a
    // file the repo it sits in TRACKS (a real inherited context is committed by
    // design). A planted, untracked file in a sibling is neither.
    const canon = canonical(dir);
    const isOwnWorktree = ownRoot !== null && canon === ownRoot;

    // A candidate outside our own worktree must at least BE a worktree root. That
    // alone removes the planted-file-in-any-subdirectory case; the walk covers
    // around 140 directories and previously accepted a file in any of them.
    let trust = "own-worktree";
    if (!isOwnWorktree) {
      const root = worktreeRoot(dir);
      if (root === null || root !== canon) continue;
      trust = isTracked(dir, CONTEXT_FILENAME) ? "tracked" : "untracked";
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A file that is there but unparseable is still THE context — returning it
      // lets readRcaContext report a parse error instead of walking past it and
      // reporting "no context", which would silently trigger a fresh interview.
      //
      // This return sits BELOW the adoption test on purpose. Above it, any junk
      // .rca-context.json anywhere in the walk short-circuited the search and the
      // run refused with parse-error — a denial of service on the run from any
      // writable directory near the repo.
      return { path: join(canon, CONTEXT_FILENAME), raw, trust };
    }
    // The homeRepo declaration must line up with the directory, for EVERY
    // candidate including our own worktree. Being the repo we were invoked from
    // raises trust; it does not waive the check, because a context declaring some
    // other repo is stale or misfiled wherever it sits, and adopting it hands the
    // run a repo map for a different project.
    //
    // `origin` naming the declared repo is evidence. The directory NAME matching is
    // only a claim — the file supplies homeRepo — so it is accepted (a first run in
    // a legitimate sibling clone has nothing stronger yet) but labelled, and the
    // gate shows the path and the label rather than adopting it silently.
    if (originNames(dir, parsed?.homeRepo)) {
      return { path: join(canon, CONTEXT_FILENAME), raw, trust: isOwnWorktree ? "own-worktree" : "origin-match" };
    }
    if (homeRepoMatches(dir, parsed?.homeRepo)) {
      const weak = isOwnWorktree ? "own-worktree" : trust === "tracked" ? "tracked" : "name-only";
      return { path: join(canon, CONTEXT_FILENAME), raw, trust: weak };
    }
  }
  return null;
}

/**
 * Read and validate the context.
 *
 * Fails LOUD on drift, matching csv-state.readRows, which throws on a foreign
 * header rather than dropping columns. Unparseable, wrong-version and
 * missing-field are three distinct named errors — never a silent fall-through to
 * "no context", because that degrades into a full re-interview and looks to the
 * customer like the feature forgetting them.
 */
export function readRcaContext({ from = process.cwd(), pluginRoot = null, path = null } = {}) {
  let file = path;
  let raw;
  // How strongly this file is tied to this machine. `own-worktree` and
  // `origin-match` are evidence; `tracked` means someone committed it on purpose;
  // `name-only` means the only link is a directory name the FILE itself declared,
  // which the gate must show rather than adopt silently. An explicit `path` is the
  // caller's own choice, so it is not ranked.
  let trust = path === null ? null : "caller-supplied";
  if (file === null) {
    const found = locateContext({ from, pluginRoot });
    if (!found) return { ok: false, code: "no-context", message: `no ${CONTEXT_FILENAME} found` };
    ({ path: file, raw } = found);
    trust = found.trust ?? null;
  } else {
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      return { ok: false, code: "unreadable", path: file, message: `cannot read ${file}: ${err.code ?? "error"}` };
    }
  }

  let context;
  try {
    context = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      code: "parse-error",
      path: file,
      message:
        `${file} is not valid JSON (${err.message.split("\n")[0]}). If this is a merge conflict, ` +
        `resolve it and re-run setup — it will not be treated as a missing context.`,
    };
  }

  const missing = REQUIRED_FIELDS.filter((f) => context?.[f] === undefined);
  if (missing.length > 0) {
    return {
      ok: false,
      code: "missing-field",
      path: file,
      fields: missing,
      message: `${file} is missing required field(s): ${missing.join(", ")}. Re-run setup to regenerate it.`,
    };
  }

  if (context.schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      code: "schema-version",
      path: file,
      found: context.schemaVersion,
      expected: SCHEMA_VERSION,
      message:
        `${file} declares schemaVersion ${context.schemaVersion}, but this plugin expects ` +
        `${SCHEMA_VERSION}. Re-run setup to regenerate it.`,
    };
  }

  return { ok: true, context, path: file, complete: context.complete === true, trust };
}

/** Every string value in the artifact, with a dotted path, so the guard below can
 *  name WHERE a refused value sat without ever quoting the value. */
function walkStrings(node, path = "", out = []) {
  if (typeof node === "string") {
    out.push({ path: path || "(root)", value: node });
  } else if (Array.isArray(node)) {
    node.forEach((v, i) => walkStrings(v, `${path}[${i}]`, out));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) walkStrings(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

/**
 * Refuse to persist a credential-shaped value, anywhere in the artifact.
 *
 * No field is exempt — not even the credential-reference field, which is exactly
 * where a pasted secret most plausibly lands. This artifact enters git history,
 * where a leak is effectively permanent, and unlike the ephemeral tool cache it has
 * no file-permission backstop: this guard is the only control.
 */
export function findSecretFields(context) {
  const hits = [];
  for (const { path, value } of walkStrings(context)) {
    const verdict = looksLikeSecret(value);
    if (verdict.secret) hits.push({ path, kind: verdict.kind });
  }
  return hits;
}

/**
 * Resolve the directory the context should be written to.
 *
 * Read-side resolution does not prevent a bad write: the install flow puts cwd
 * inside the plugin, so a first run that simply wrote next to cwd would land the
 * file where no teammate inherits it. The destination is the declared home repo's
 * working-tree root, chosen from the repos setup actually verified.
 */
export function contextHomeDir({ homeRepo, verifiedRepos = [], from = process.cwd(), pluginRoot = null } = {}) {
  if (!homeRepo) {
    return { ok: false, code: "no-home-repo", message: "the context declares no homeRepo, so there is nowhere to write it" };
  }
  // An empty list used to mean "every home repo is known", so a caller that simply
  // omitted verifiedRepos silently disabled this guard — and writeRcaContext
  // defaults it to []. The context itself records what verification actually
  // proved, so fall back to THAT instead of to blanket permission.
  const known =
    verifiedRepos.length === 0
      ? true
      : verifiedRepos.some((r) => basename(r) === basename(homeRepo));
  if (!known) {
    return {
      ok: false,
      code: "home-repo-unverified",
      message: `homeRepo '${homeRepo}' is not among the repos setup verified (${verifiedRepos.join(", ")})`,
    };
  }

  const forbidden = pluginRoot ? canonical(pluginRoot) : null;
  const allowed = (dir) => !(forbidden && canonical(dir) === forbidden);

  // Fast path: the clone directory is named after the repo.
  for (const dir of candidateDirs(from)) {
    if (!homeRepoMatches(dir, homeRepo)) continue;
    if (!allowed(dir)) continue;
    const root = worktreeRoot(dir);
    if (root) return { ok: true, dir: root };
  }

  // Fallback: ask git instead of the directory name. A basename-only match refused
  // `acme/api` cloned as `api-service`, a renamed repo, and every linked worktree —
  // after the interview and every verification had already succeeded, with nothing
  // persistable and a next action the customer had by definition already taken.
  for (const dir of [from, ...candidateDirs(from)]) {
    if (!allowed(dir)) continue;
    const root = worktreeRoot(dir);
    if (root && originNames(root, homeRepo)) return { ok: true, dir: root };
  }

  return {
    ok: false,
    code: "no-git-worktree",
    message:
      `could not find a git working tree for '${homeRepo}' near ${resolve(from)}. Run setup from ` +
      `inside the repository the context should be committed to.`,
  };
}

/**
 * Persist the context.
 *
 * Deliberately no `mode` and no chmod: the file is git-tracked, so owner-only
 * permissions are both wrong and not preserved. `hardenStateDir` must never be
 * pointed here.
 */
/** The context already at this path, or null. Used only to refuse a downgrade. */
function readExisting(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeRcaContext({
  context,
  verifiedRepos = [],
  from = process.cwd(),
  pluginRoot = null,
} = {}) {
  const missing = REQUIRED_FIELDS.filter((f) => context?.[f] === undefined);
  if (missing.length > 0) {
    return { ok: false, code: "missing-field", fields: missing, message: `refusing to write: missing ${missing.join(", ")}` };
  }
  if (context.schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      code: "schema-version",
      message: `refusing to write schemaVersion ${context.schemaVersion}; this plugin writes ${SCHEMA_VERSION}`,
    };
  }

  // Structural enforcement of the one rule the skill body cannot be trusted to keep
  // on its own: GitHub is the mandatory capability, so a context claiming
  // completeness while GitHub is unverified would be a state every run refuses —
  // with no signal to the customer which rule applies. The interview is told to
  // write a partial instead; this makes obeying it the only option.
  if (context.complete === true && context?.verified?.[MANDATORY_CAPABILITY]?.ok !== true) {
    return {
      ok: false,
      code: "incomplete-github",
      message:
        "refusing to write a complete context whose GitHub is not verified. GitHub is the " +
        "mandatory capability, so this would claim completeness while every run against it " +
        "refuses. Write it with complete: false instead — a partial is resumable.",
    };
  }

  const secrets = findSecretFields(context);
  if (secrets.length > 0) {
    return {
      ok: false,
      code: "secret-in-field",
      fields: secrets.map((s) => s.path),
      message:
        `refusing to write: ${secrets.map((s) => `${s.path} looks like a ${s.kind}`).join("; ")}. ` +
        `This file is committed, where a leaked credential is effectively permanent. Reference the ` +
        `credential by environment-variable NAME instead, and rotate the value that was pasted.`,
    };
  }

  // Derive the verified set from the artifact when the caller supplies none —
  // `verified.<mandatory>.targets` is what verification actually proved, so an
  // omitted argument no longer waives the home-repo guard.
  const effectiveVerified =
    verifiedRepos.length > 0
      ? verifiedRepos
      : (context?.verified?.[MANDATORY_CAPABILITY]?.targets ?? []);
  const home = contextHomeDir({
    homeRepo: context.homeRepo,
    verifiedRepos: effectiveVerified,
    from,
    pluginRoot,
  });
  if (!home.ok) return home;

  const ignore = ignoreRuleFor(home.dir, CONTEXT_FILENAME);
  if (ignore.error) {
    return {
      ok: false,
      code: "ignore-check-failed",
      message:
        `could not determine whether ${join(home.dir, CONTEXT_FILENAME)} is git-ignored (${ignore.error}). ` +
        `Refusing rather than writing a file that may never be committed.`,
    };
  }
  if (ignore.ignored) {
    return {
      ok: false,
      code: "ignored-destination",
      rule: ignore.rule,
      message:
        `${join(home.dir, CONTEXT_FILENAME)} is excluded by ${ignore.rule}, so it would never be committed ` +
        `and no teammate would inherit it. Narrow the rule or choose a different home repo.`,
    };
  }

  const path = join(home.dir, CONTEXT_FILENAME);

  // Never let a partial overwrite a complete one. Every write was unconditional, so
  // a resumed session that re-verified less than the first — or a second engineer
  // running setup from the same repo — silently replaced a committed, complete
  // context with a narrower one, discarding answers nothing else records.
  const existing = readExisting(path);
  if (existing?.complete === true && context.complete !== true) {
    return {
      ok: false,
      code: "would-downgrade",
      path,
      message:
        `${path} already holds a COMPLETE context and this one is partial, so writing would discard ` +
        `verified answers. Finish the interview, or delete the existing file deliberately if it is stale.`,
    };
  }

  try {
    writeFileSync(path, `${JSON.stringify(context, null, 2)}\n`, "utf8");
  } catch (err) {
    // Every other exit from this function is a result object; this was the one
    // uncaught I/O call, so EACCES/ENOSPC/EROFS threw where the caller — an agent
    // told to "report the code and its next action" — had no code to report.
    return {
      ok: false,
      code: "write-failed",
      path,
      message: `could not write ${path}: ${err?.code ?? "unknown error"}. Check permissions and free space.`,
    };
  }
  return { ok: true, path };
}

/**
 * Should the run refuse to start, given what reading the context returned?
 *
 * Four refusals, and they are a pure function of the read result — so they are a
 * tested function rather than four paragraphs in a gate section. The gate's own
 * history is the argument: it records rules that were read and violated on real
 * runs, and "context present but unreadable" is precisely the case a prose list
 * forgets, because it looks like "no context" until you notice the difference.
 *
 * The rule for partials is one line: a partial runs if and only if GitHub is
 * verified in it. GitHub is the mandatory capability, so a partial carrying
 * verified GitHub is genuinely runnable; one without it is no better than nothing.
 */
export function startOfRunRefusal(readResult) {
  if (!readResult || readResult.ok !== true) {
    // A nullish argument is a CALLER bug, not an absent context, and the two must
    // not share an outcome now that one of them proceeds: defaulting it to
    // "no-context" would send a broken call into the interview and then into a run.
    const code = readResult ? (readResult.code ?? "missing-code") : "no-read-result";
    if (code === "no-context") {
      // NOT a refusal. Absent context means "interview first", not "go away": setup
      // is a phase of the run skill, so the run performs it and continues. It was a
      // refusal while setup lived in a separate skill, which made the commonest
      // first contact with this plugin — a red build, from someone who has never
      // heard of setup — a dead end pointing at another command.
      //
      // `refuse` stays present and false so a caller that only checks `.refuse`
      // proceeds rather than reading undefined and treating it as truthy.
      return {
        refuse: false,
        setup: true,
        code: "no-context",
        message: "No RCA setup context found, so I will run the setup interview first.",
        nextAction:
          "Run the setup phase (skills/rca-build/references/setup.md), then continue into the gate. " +
          "Headless: stop here — there is nobody to interview.",
        partial: true,
      };
    }
    // Present but unreadable. Distinct from absent on purpose: telling someone to
    // run setup when their context is merely conflict-marked throws away every
    // answer they already gave.
    return {
      refuse: true,
      setup: false,
      code: "unreadable-context",
      message: `The RCA setup context is present but unusable (${code}).`,
      nextAction:
        readResult?.message ??
        "Resolve the problem named above, or delete the file to re-run the setup interview.",
      path: readResult?.path ?? null,
    };
  }

  const githubOk = readResult.context?.verified?.[MANDATORY_CAPABILITY]?.ok === true;
  if (!githubOk) {
    return {
      refuse: true,
      setup: false,
      code: "github-unverified",
      message:
        "GitHub is not verified in this context, and it is the one capability a run cannot " +
        "proceed without — there would be no culprit PR to name.",
      nextAction:
        "Re-run the setup phase to verify GitHub (check the credential it names first).",
      path: readResult.path ?? null,
    };
  }

  return {
    refuse: false,
    setup: false,
    partial: readResult.context?.complete !== true,
    path: readResult.path ?? null,
  };
}

// ---- intake precedence ------------------------------------------------------

/** Highest priority first. Inference is deliberately absent — see below. */
const SOURCE_ORDER = ["buildMeta", "invocationArgs", "context", "connectorDefaults"];

/**
 * Rank the four intake sources per field.
 *
 * `{value, source}` per field, and `{value: null, source: "unresolved"}` when none
 * of the four supply it.
 *
 * INFERENCE IS OUTSIDE THIS FUNCTION, on purpose. Git remotes, `gh repo view` and
 * cwd-holds-the-tests are agent work the gate performs, and it performs them only
 * on fields that come back `unresolved`. A five-tier chain cannot be ranked by a
 * function that receives four sources; pretending otherwise would either invent a
 * fifth parameter or silently drop the tier, and the pure-function guarantee would
 * then cover less than it claims.
 *
 * This is the adapter's load-bearing rule, which is why it is a tested function and
 * not prose in a gate section. tests/wiring.test.mjs additionally asserts the gate
 * actually CALLS it — a prose reimplementation would satisfy a string check.
 */
/**
 * Translate the persisted context into the RUN's intake vocabulary.
 *
 * Two vocabularies met here and nothing crossed between them. The capability table
 * and the artifact speak `repos` (a list), `homeRepo`, `baseBranch`, `namespace`,
 * `workloads`. The run's gate asks resolveIntake for `repo`, `automationRepo`,
 * `baseBranch`, `namespace`, `workloads`. resolveIntake matches keys EXACTLY, so
 * three of those five came back `source: "unresolved"` from a complete, verified
 * context — the gate then fell through to inference and re-asked, which is the
 * zero-questions guarantee the same block promises, broken.
 *
 * `homeRepo` is the product repo by definition: it is the repo the context is
 * committed to. The automation repo is whatever else verification proved, when that
 * is unambiguous — one candidate means one answer, several means the run should
 * infer rather than guess.
 */
export function intakeFromContext(context = {}) {
  const repos = Array.isArray(context.repos) ? context.repos : [];
  const others = repos.filter((r) => basename(String(r)) !== basename(String(context.homeRepo ?? "")));
  const out = {
    repo: context.homeRepo ?? repos[0],
    automationRepo: others.length === 1 ? others[0] : undefined,
    baseBranch: context.baseBranch,
    namespace: context.namespace,
    workloads: context.workloads,
    subpaths: context.subpaths,
    logIndex: context.logIndex,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

export function resolveIntake({
  buildMeta = {},
  invocationArgs = {},
  context = {},
  connectorDefaults = {},
  fields = null,
} = {}) {
  const sources = { buildMeta, invocationArgs, context, connectorDefaults };
  const names = fields ?? [
    ...new Set(SOURCE_ORDER.flatMap((s) => Object.keys(sources[s] ?? {}))),
  ];

  const out = {};
  for (const field of names) {
    let resolved = { value: null, source: "unresolved" };
    for (const source of SOURCE_ORDER) {
      const value = sources[source]?.[field];
      if (value === undefined || value === null || value === "") continue;
      resolved = { value, source };
      break;
    }
    out[field] = resolved;
  }
  return out;
}
