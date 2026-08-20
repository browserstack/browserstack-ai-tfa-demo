# `lib/rca-context.mjs` — the committed setup context

Mandated by BOTH skills, and documented here once. `rca-setup` writes this file;
`rca-build` reads it. Two copies of these signatures is what the every-owner
documentation rule used to cost — ~90 identical lines, both always loaded.

## Setup context — `lib/rca-context.mjs`

The committed artifact `rca-setup` wrote. Shared with that skill.

```
readRcaContext({from, pluginRoot, path}) → {ok, context, path, complete, trust}
                                         | {ok:false, code, message}
    codes: no-context · parse-error · schema-version · missing-field · unreadable
    Distinct on purpose: never degrade a broken context to "no context", which
    triggers a needless re-interview and reads as the feature forgetting the user.
    `trust` says how strongly this file is tied to this machine —
    own-worktree · origin-match · tracked · name-only. On `name-only` the only
    link is a directory name the FILE itself declared: print the path and the
    label before letting it drive the run.

startOfRunRefusal(readResult) → {refuse, code, message, nextAction, partial, trust}
    THE start-of-run policy. Refuses on no-context, unreadable-context and
    github-unverified. A partial with verified GitHub proceeds, `partial: true`.

intakeFromContext(context) → the run's intake vocabulary, translated from the
    artifact's. `repo` ← homeRepo (the repo the context is committed to IS the
    product repo); `automationRepo` ← the one other verified repo, when
    unambiguous. Required before resolveIntake, which matches keys exactly.

resolveIntake({buildMeta, invocationArgs, context, connectorDefaults, fields})
    → {field: {value, source}}
    source: buildMeta | invocationArgs | context | connectorDefaults | unresolved
    Inference is NOT a tier — the gate performs it, only on `unresolved` fields.

findContextFile({from, pluginRoot}) → path | null      refuses pluginRoot
findSecretFields(context) → [{path, kind}]             names WHERE, never the value
CONTEXT_FILENAME  ".rca-context.json"  at the home repo's worktree root
SCHEMA_VERSION    CREDENTIAL_KIND { ENV_VAR, PROVIDER_MANAGED }
```

Setup writes this file; the run only reads it. It is git-tracked, so it is the one
persisted file here that is deliberately **not** permission-hardened — never point
`hardenStateDir` at it.

## The write side — `rca-setup` only

The run never calls these; they are here because the guard documents a module, not
a half of one.

```
writeRcaContext({context, verifiedRepos, from, pluginRoot}) → {ok, path}
                                                            | {ok:false, code, message}
    codes: missing-field · schema-version · secret-in-field · incomplete-github
         · home-repo-unverified · no-git-worktree · ignored-destination
         · ignore-check-failed · would-downgrade · write-failed
    `incomplete-github` refuses a COMPLETE context whose GitHub is unverified —
    a state every run would then refuse. Write a partial instead; it resumes.
    `would-downgrade` refuses a partial over an existing complete context, so a
    re-run cannot silently discard the team's verified answers.

contextHomeDir({homeRepo, verifiedRepos, from, pluginRoot}) → {ok, dir}
                                                            | {ok:false, code, message}
    The destination is the declared home repo's worktree root. Matched by
    directory name, then by the repo the `origin` remote actually names — a clone
    in a differently-named directory is normal and must not dead-end setup.
```
