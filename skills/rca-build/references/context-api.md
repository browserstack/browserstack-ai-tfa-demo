# `lib/rca-context.mjs` — the committed setup context

The setup phase writes this file; every later run reads it. It was mandated by two
skills and documented in two places, which the every-owner documentation rule
priced at ~90 identical lines, both always loaded. One skill now, one copy.

```
readRcaContext({from, pluginRoot, path}) → {ok, context, path, complete, trust}
                                         | {ok:false, code, message}
    codes: no-context · parse-error · schema-version · missing-field · unreadable
    Distinct on purpose: never degrade a broken context to "no context", which
    now triggers an actual re-interview and reads as the feature forgetting the
    user.
    `trust` says how strongly this file is tied to this machine —
    own-worktree · origin-match · tracked · name-only. On `name-only` the only
    link is a directory name the FILE itself declared: print the path and the
    label before letting it drive the run.

startOfRunRefusal(readResult) → {refuse, setup, code, message, nextAction, partial}
    THE start-of-run policy, and three outcomes rather than two:
      refuse:true          unreadable-context | github-unverified → print and stop
      setup:true           no-context → run the setup phase, then continue
      refuse:false, setup:false                                  → usable
    An absent context stopped the run while setup was a separate skill. A nullish
    argument is `unreadable-context`, NOT `no-context`: one of them proceeds into
    an interview now, so a broken call must not be able to reach it.
    A partial with verified GitHub proceeds, `partial: true`.

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

It is git-tracked, so it is the one persisted file here that is deliberately **not**
permission-hardened — never point `hardenStateDir` at it.

## The write side — the setup phase only

A run that found a usable context never calls these.

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
