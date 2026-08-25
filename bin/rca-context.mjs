#!/usr/bin/env node
// The ONLY way an agent touches the committed setup context.
//
//   node bin/rca-context.mjs find              [--from DIR]
//   node bin/rca-context.mjs read              [--from DIR] [--path FILE]
//   node bin/rca-context.mjs capabilities      [--config FILE]
//   node bin/rca-context.mjs select            [--build-name NAME] [--project-name NAME] [--profile LABEL]
//                                             [--today YYYY-MM-DD] [--stale-after-days N]
//   node bin/rca-context.mjs write             --file DOC.json | -
//   node bin/rca-context.mjs upsert-connector  --capability C --file CONN.json
//                                             [--profile LABEL] [--today YYYY-MM-DD]
//   node bin/rca-context.mjs record-knowledge  --artifact A --artifact-path P --part T
//   node bin/rca-context.mjs record-gap        --capability C --classification K
//   node bin/rca-context.mjs record-warning    --capability C --classification K
//                                             [--note TEXT] [--target T] [--profile LABEL]
//
// argv in, JSON on stdout, non-zero exit on refusal: 1 = refused (a `code` and a
// `message` say why), 2 = usage. Prose goes to stderr so stdout stays parseable.
//
// Flags are a CLOSED set per verb: an unknown or misspelled flag is a usage error,
// never ignored. `--projectname` used to parse and vanish, and selection then ran
// with no project filter and exited 0.
//
// WHY THIS EXISTS: the alternative is an agent hand-writing JS to edit a
// git-tracked file mid-interview. Every deterministic decision — where the file
// lives, whether a profile is runnable, which profile a build name selects, and
// whether a write would discard a teammate's verified connector — belongs here,
// once, tested. What goes IN the file stays the agent's judgement.
//
// The clock is read HERE and nowhere else: `--today` defaults to today's UTC day
// and is passed into the library, which never reads it. That is what keeps
// selection and staleness deterministic under test.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTEXT_README,
  DEFAULT_STALE_AFTER_DAYS,
  SCHEMA_VERSION,
  capabilitySequence,
  findContextFile,
  isProvisioned,
  isRunnable,
  missingCapabilities,
  readRcaContext,
  recordGap,
  recordKnowledge,
  recordWarning,
  selectProfile,
  upsertConnector,
  writeRcaContext,
} from "../lib/rca-context.mjs";

// The plugin's own root is never a valid home for a context: the documented
// install flow is `git clone <plugin> && cd <plugin> && claude --plugin-dir ./`,
// so cwd IS the plugin root on first contact, and a context written there is
// inherited by nobody. Defaulted here rather than asked for, because a flag the
// caller forgets silently re-opens the hole. There is no override.
const PLUGIN_ROOT = new URL("..", import.meta.url).pathname;

const USAGE = [
  "usage: rca-context.mjs <command> [options]",
  "",
  "  find                        print the resolved context path",
  "  read                        print the parsed, validated context",
  "  capabilities                print the capability sequence from config",
  "  select                      choose a profile for this run",
  "  write --file DOC.json|-     create the context document",
  "  upsert-connector --capability C --file CONN.json [--profile L] [--today D]",
  "  record-knowledge --artifact A --artifact-path P --part T [--capability C] [--note N] [--profile L]",
  "  record-gap --capability C --classification K [--note T] [--target T] [--profile L]",
  "  record-warning --capability C --classification K [--note T] [--target T] [--profile L]",
  "",
  "  common: --from DIR  --path FILE  --config FILE  --today YYYY-MM-DD  --stale-after-days N",
].join("\n");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function emit(payload, exitCode) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(exitCode);
}

/** A refusal is data, not a crash: it carries a `code` the caller can branch on
 *  and a `message` written for the customer. */
function refuse(payload) {
  emit({ ok: false, ...payload }, 1);
}

function usage(message) {
  console.error(message ? `${message}\n\n${USAGE}` : USAGE);
  process.exit(2);
}

function readJsonArg(args, what) {
  const source = args.file ?? args._[1];
  if (source === undefined || source === true) usage(`${what} needs --file <path> (or --file - for stdin)`);
  try {
    const raw = source === "-" ? readFileSync(0, "utf8") : readFileSync(String(source), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    // The path and the parser's complaint, never the bytes: a document refused
    // for holding something it should not must not be echoed back into the
    // transcript.
    usage(`could not read JSON from ${source === "-" ? "stdin" : source}: ${err?.message?.split("\n")[0] ?? "error"}`);
  }
}

function loadConfig(args) {
  const path = args.config && args.config !== true ? String(args.config) : join(PLUGIN_ROOT, "config/rca.config.json");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // A missing config is not fatal for find/read/write — only the capability
    // sequence needs it, and an empty sequence means `provisioned` is reported as
    // unknown rather than falsely true.
    return null;
  }
}

// Closed flag sets, per verb. The same principle as the schema's closed key sets and
// for the same reason: an unknown key is a MISTAKE, and the cost of accepting it
// quietly is a wrong answer nobody is told about.
//
// This was open. `--projectname` (one missing hyphen) parsed, was ignored, and
// `select` ran with no project filter — resolving to `defaultProfile` and exiting 0.
// That is the wrong-context run `projectMatch` was added to prevent, reachable by a
// typo, with no signal at any layer. A live run also invented `--plugin-dir` and was
// silently obliged.
//
// Nothing here validates a VALUE. Deciding whether a flag's value is sensible is the
// library's job or the agent's; this only decides whether a flag is a flag.
const COMMON_FLAGS = ["from", "path", "config", "today", "stale-after-days"];
const VERB_FLAGS = {
  find: [],
  read: [],
  capabilities: [],
  select: ["build-name", "project-name", "profile"],
  write: ["file"],
  "upsert-connector": ["capability", "file", "profile"],
  "record-knowledge": ["artifact", "artifact-path", "part", "capability", "note", "profile"],
  "record-gap": ["capability", "classification", "note", "target", "profile"],
  "record-warning": ["capability", "classification", "note", "target", "profile"],
};

function checkFlags(verb, parsed) {
  const allowed = VERB_FLAGS[verb];
  if (allowed === undefined) return; // unknown verb — reported by its own usage error
  const permitted = new Set([...COMMON_FLAGS, ...allowed]);
  const unknown = Object.keys(parsed).filter((k) => k !== "_" && !permitted.has(k));
  if (unknown.length === 0) return;
  // Name the near miss. Every real instance of this has been a typo or a flag
  // borrowed from another verb, and both are one edit from correct.
  const near = (bad) => {
    const hit = [...permitted].find(
      (ok) => ok.replaceAll("-", "") === bad.replaceAll("-", "").toLowerCase(),
    );
    return hit ? ` (did you mean --${hit}?)` : "";
  };
  usage(
    `${verb}: unknown flag${unknown.length > 1 ? "s" : ""} ` +
      unknown.map((u) => `--${u}${near(u)}`).join(", ") +
      `\n\nAccepted here: ${[...permitted].sort().map((f) => `--${f}`).join(" ")}\n` +
      `Refused rather than ignored: an ignored --project-name selects a profile without ` +
      `checking the project, which is a run against another environment's repos.`,
  );
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const from = args.from && args.from !== true ? String(args.from) : process.cwd();
const path = args.path && args.path !== true ? String(args.path) : null;
const today =
  args.today && args.today !== true ? String(args.today) : new Date().toISOString().slice(0, 10);
const common = { from, pluginRoot: PLUGIN_ROOT, path };

if (!command || command === "--help" || command === "-h" || command === "help") usage();

// `<verb> --help` is a real thing to type and reaches here with command set, so it is
// handled before the closed-flag check — otherwise asking for help earns an unknown-flag
// error, which is the least helpful possible response to it. Found by replaying a live
// run's invocations against the new allowlist.
if (args.help || args.h) usage();

checkFlags(command, args);

if (command === "find") {
  const found = findContextFile({ from, pluginRoot: PLUGIN_ROOT });
  if (found === null) {
    // NOT an error condition in the product sense — no context means first
    // contact, which is a phase of the run rather than a dead end. It still exits
    // non-zero so a shell `if` can branch on it.
    refuse({ code: "no-context", message: "no .rca-context.json is resolvable from here — this is first contact" });
  }
  emit({ ok: true, path: found }, 0);
}

if (command === "read") {
  const read = readRcaContext(common);
  if (!read.ok) refuse(read);
  emit({ ok: true, path: read.path, trust: read.trust, context: read.context }, 0);
}

if (command === "capabilities") {
  const config = loadConfig(args);
  if (config === null) refuse({ code: "no-config", message: "could not read the plugin config, so the capability sequence is unknown" });
  emit({ ok: true, capabilities: capabilitySequence(config) }, 0);
}

if (command === "select") {
  const read = readRcaContext(common);
  if (!read.ok) refuse(read);

  const config = loadConfig(args);
  const capabilities = config === null ? [] : capabilitySequence(config);
  const staleAfterDays =
    args["stale-after-days"] && args["stale-after-days"] !== true
      ? Number(args["stale-after-days"])
      : Number(config?.context?.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS);

  const selected = selectProfile({
    context: read.context,
    buildName: args["build-name"] && args["build-name"] !== true ? String(args["build-name"]) : null,
    projectName: args["project-name"] && args["project-name"] !== true ? String(args["project-name"]) : null,
    requested: args.profile && args.profile !== true ? String(args.profile) : null,
    todayISO: today,
    staleAfterDays: Number.isFinite(staleAfterDays) ? staleAfterDays : DEFAULT_STALE_AFTER_DAYS,
  });
  if (!selected.ok) refuse({ ...selected, path: read.path });

  const missing = missingCapabilities(selected.profile, capabilities);
  emit(
    {
      ok: true,
      path: read.path,
      trust: read.trust,
      homeRepo: read.context.homeRepo,
      label: selected.label,
      labels: selected.labels,
      matchedBy: selected.matchedBy,
      alsoMatched: selected.alsoMatched,
      overriddenBuildMatch: selected.overriddenBuildMatch,
      projectUnchecked: selected.projectUnchecked,
      // Two predicates, two consumers. `runnable` gated the selection above and is
      // restated for the digest; `provisioned` decides only whether the gate
      // offers to finish setup — it never blocks a run.
      runnable: isRunnable(selected.profile),
      provisioned: capabilities.length === 0 ? null : isProvisioned(selected.profile, capabilities),
      capabilities,
      missing,
      // The resume point, derived rather than stored: the first capability with
      // neither a connector nor a gap.
      resumeAt: missing[0] ?? null,
      stale: selected.stale,
      ages: selected.ages,
      staleAfterDays: selected.staleAfterDays,
      todayISO: today,
      profile: selected.profile,
    },
    0,
  );
}

if (command === "write") {
  const document = readJsonArg(args, "write");
  // Deterministic boilerplate belongs in a script, not in an agent's head.
  if (document && typeof document === "object" && !Array.isArray(document)) {
    if (document.schemaVersion === undefined) document.schemaVersion = SCHEMA_VERSION;
    if (document._README === undefined) document._README = CONTEXT_README;
  }
  const result = writeRcaContext({ context: document, from, pluginRoot: PLUGIN_ROOT, path });
  if (!result.ok) refuse(result);
  emit(result, 0);
}

if (command === "upsert-connector") {
  const capability = args.capability && args.capability !== true ? String(args.capability) : null;
  if (capability === null) usage("upsert-connector needs --capability <name>");
  const connector = readJsonArg(args, "upsert-connector");
  const result = upsertConnector({
    capability,
    connector,
    profile: args.profile && args.profile !== true ? String(args.profile) : null,
    todayISO: today,
    ...common,
  });
  if (!result.ok) refuse(result);
  emit(result, 0);
}

// record-gap and record-warning share one handler: same flags, same schema. The
// only difference is whether the entry degrades evidence (a gap, declared to TFA)
// or merely predicts a thin answer (a warning, printed at the gate). Two dispatch
// arms would drift.
if (command === "record-knowledge") {
  const str = (k) => (args[k] && args[k] !== true ? String(args[k]) : null);
  // NOT `--path`: that is a common flag meaning the CONTEXT file. Reusing it here
  // silently sent the artifact's path to readRcaContext as the document to open.
  for (const [flag, key] of [["artifact", "artifact"], ["artifact-path", "artifactPath"], ["part", "part"]]) {
    if (str(flag) === null) usage(`record-knowledge needs --${flag} <value>`);
  }
  const result = recordKnowledge({
    artifact: str("artifact"),
    artifactPath: str("artifact-path"),
    part: str("part"),
    capability: str("capability"),
    note: str("note"),
    judgedAt: str("today"),
    profile: str("profile"),
    ...common,
  });
  if (!result.ok) refuse(result);
  emit(result, 0);
}

if (command === "record-gap" || command === "record-warning") {
  const capability = args.capability && args.capability !== true ? String(args.capability) : null;
  if (capability === null) usage(`${command} needs --capability <name>`);
  const record = command === "record-warning" ? recordWarning : recordGap;
  const result = record({
    capability,
    classification: args.classification && args.classification !== true ? String(args.classification) : null,
    note: args.note && args.note !== true ? String(args.note) : null,
    target: args.target && args.target !== true ? String(args.target) : null,
    profile: args.profile && args.profile !== true ? String(args.profile) : null,
    ...common,
  });
  if (!result.ok) refuse(result);
  emit(result, 0);
}

usage(`unknown command '${command}'`);
