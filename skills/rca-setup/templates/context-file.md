# Template — `.rca-context.json`

Written by `writeRcaContext` (`lib/rca-context.mjs`). Signatures and error codes
are in `<pluginRoot>/skills/rca-setup/references/api-reference.md`; the resolution
rules are in `<pluginRoot>/skills/rca-setup/references/context-resolution.md`.

**Field names are the capability table's, exactly.** `namespace` and `logIndex`
are singular because `config/rca.config.json` declares them that way, and both
`resolveIntake` and `intakeFromContext` look them up by exact key. This example
carried `namespaces`/`logIndexes`, so a context written from it resolved neither.

**Portable facts only.** Anything a different machine would answer differently is
re-derived on load, never written — workspace roots, local clone paths, which CLI
this developer happens to prefer. Writing them would make the file wrong for the
second person who clones it, which is the whole point of committing it.

**Credentials by reference, never by value.** Two kinds, because one is not
enough: `env-var` names the variable a teammate must export, and
`provider-managed` says there is no variable to name — `gh` via keyring or device
flow is the common case, and without this kind a teammate is told to export
something the first engineer never used.

```jsonc
{
  "schemaVersion": 1,
  "homeRepo": "acme/api",          // which repo this file is committed to
  "complete": true,                // false = resumable partial; see below

  "repos": ["acme/api", "acme/e2e-tests"],
  "subpaths": ["services/billing"],   // what we own inside a monorepo
  "baseBranch": "main",
  "namespace": "prod",
  "workloads": ["billing-consumer"],
  "logIndex": "app-logs-2026",

  "credentials": {
    "github": { "kind": "env-var", "name": "GH_TOKEN" }
    // or:     { "kind": "provider-managed" }
  },

  "verified": {
    "github": { "ok": true, "targets": ["acme/api", "main"], "via": "cli" }
  },

  "gaps": [
    { "capability": "logs", "classification": "absent-on-this-machine",
      "nextAction": "Install the log CLI or connect a log MCP server." }
  ],

  "warnings": [
    { "code": "empty-pr-window", "windowDays": 30, "branch": "main" }
  ],

  "capabilities": {}   // optional overlay: SCOPE DATA ONLY, never a probe
}
```

## `complete: false` is a first-class state

Written whenever the gate was reached but setup could not close — GitHub refused,
or the session ended after some capability was already verified. It exists so a
refusal costs a re-verify rather than a re-interview.

The run treats it by one rule: **a partial runs if and only if GitHub is verified
in it.** GitHub is the mandatory capability, so a partial carrying verified GitHub
is genuinely runnable — its verified fields are used, its unanswered capabilities
are declared as gaps. A partial without verified GitHub refuses exactly like no
context at all.

## The overlay is how an unlisted stack gets covered

`capabilities` may add `seedHints` and `scopeFields` for a capability — so a team
whose stack the shipped table does not name can teach it, in a file they own,
without waiting on a plugin release. A scope field must declare a `consumer`, the
same rule the shipped rows follow: a question nothing reads must not be asked.

It may **not** set `mandatory`, `resolvable`, `intent` or
`exemptFromDiscoveryReport` — the structure a row must not decide about itself. The
last one matters most: it controls what the gate SHOWS a human, so a row setting it
could hide its own absence.

This freedom is safe only because a hint authorises nothing. There are no probe
commands in the table, so the worst a wrong hint does is propose a route that then
has to be verified by a reported check.

## Never in this file

- A credential value. The write-time guard refuses one in **any** field, including
  the credential-reference field — exactly where a pasted secret most plausibly
  lands. It enters git history, where a leak is effectively permanent.
- Raw provider output. Failures are reduced to a class plus a next action.
- Anything machine-specific (see above).
