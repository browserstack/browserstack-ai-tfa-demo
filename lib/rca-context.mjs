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
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { looksLikeSecret } from "./verify.mjs";

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

/** `git check-ignore -v` exits 1 when NOT ignored, so a throw is the success case
 *  here. Returns the matching rule when the path is ignored, else null. */
function ignoreRuleFor(dir, relPath) {
  try {
    const out = git(dir, ["check-ignore", "-v", "--", relPath]);
    return out.trim() || "an unnamed .gitignore rule";
  } catch {
    return null;
  }
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
function candidateDirs(from) {
  const out = [];
  let dir = resolve(from);
  for (let level = 0; level < MAX_LEVELS; level++) {
    out.push(dir);
    let children = [];
    try {
      children = readdirSync(dir)
        .filter((e) => !e.startsWith("."))
        .map((e) => join(dir, e))
        .filter((p) => {
          try { return statSync(p).isDirectory(); } catch { return false; }
        });
    } catch { /* unreadable level — skip its children */ }
    out.push(...children);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Nearest first, de-duplicated.
  return [...new Set(out.map(canonical))];
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
  const forbidden = pluginRoot ? canonical(pluginRoot) : null;
  for (const dir of candidateDirs(from)) {
    if (forbidden && dir === forbidden) continue;
    const path = join(dir, CONTEXT_FILENAME);
    if (!existsSync(path)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // A file that is there but unparseable is still THE context — returning it
      // lets readRcaContext report a parse error instead of walking past it and
      // reporting "no context", which would silently trigger a fresh interview.
      return path;
    }
    if (homeRepoMatches(dir, parsed?.homeRepo)) return path;
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
  const file = path ?? findContextFile({ from, pluginRoot });
  if (!file) return { ok: false, code: "no-context", message: `no ${CONTEXT_FILENAME} found` };

  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    return { ok: false, code: "unreadable", path: file, message: `cannot read ${file}: ${err.code ?? "error"}` };
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

  return { ok: true, context, path: file, complete: context.complete === true };
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
  const known = verifiedRepos.length === 0 || verifiedRepos.some((r) => basename(r) === basename(homeRepo));
  if (!known) {
    return {
      ok: false,
      code: "home-repo-unverified",
      message: `homeRepo '${homeRepo}' is not among the repos setup verified (${verifiedRepos.join(", ")})`,
    };
  }

  const forbidden = pluginRoot ? canonical(pluginRoot) : null;
  for (const dir of candidateDirs(from)) {
    if (forbidden && dir === forbidden) continue;
    if (!homeRepoMatches(dir, homeRepo)) continue;
    const root = worktreeRoot(dir);
    if (root) return { ok: true, dir: root };
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
  if (context.complete === true && context?.verified?.github?.ok !== true) {
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

  const home = contextHomeDir({ homeRepo: context.homeRepo, verifiedRepos, from, pluginRoot });
  if (!home.ok) return home;

  const rule = ignoreRuleFor(home.dir, CONTEXT_FILENAME);
  if (rule) {
    return {
      ok: false,
      code: "ignored-destination",
      rule,
      message:
        `${join(home.dir, CONTEXT_FILENAME)} is excluded by ${rule}, so it would never be committed ` +
        `and no teammate would inherit it. Narrow the rule or choose a different home repo.`,
    };
  }

  const path = join(home.dir, CONTEXT_FILENAME);
  writeFileSync(path, `${JSON.stringify(context, null, 2)}\n`, "utf8");
  return { ok: true, path };
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
