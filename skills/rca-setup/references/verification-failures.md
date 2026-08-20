# Verification failures

Load this file **before running the first probe**. It defines what verification
proves, what a failure record must contain, and how GitHub differs from everything
else.

**Contents:** [What counts as verified](#what-counts-as-verified) ·
[The record](#every-failure-record) · [Error classes](#error-classes) ·
[Gap classes](#gap-classes) · [GitHub is binary](#github-is-binary) ·
[Secrets](#secrets)

## What counts as verified

A live read against the **resolved scope** — not the presence of a tool, and not
the presence of a credential. `kubectl` being on PATH says nothing about whether
`prod` exists or whether this credential can see it.

**Per target, not per tool.** A capability valid for `acme/api` and 404 on
`acme/ghost` stays valid for `acme/api`; the failure is a scoped gap. Collapsing
that into a dead capability is what makes a coordinator degrade to "unavailable"
over one bad value.

Probes come from the table and are validated before they run — and the
*interpolated* command is re-validated immediately before execution, because the
template was checked against `{repo}`, not against what the customer typed.

## Every failure record

Four things, always:

| Field | Why |
|---|---|
| the failing field | which answer to fix |
| an error class | *what kind* of failure, never the raw text |
| the env-var name | safe to record; the value never is |
| a next action | non-empty, always — a diagnostic with no next step is how someone gets stuck |

Plus a `suggestion` when the value looks like a typo. `nearMatch` returns null
rather than a guess when nothing is close: a confident wrong suggestion sends
someone to correct a value that was already right.

**Raw provider output never reaches a record.** It is reduced to a class and
dropped — not redacted and kept, because a redacted string still carries whatever
the redactor's patterns missed, and these records can end up committed.

## Error classes

`not-installed` · `not-authenticated` · `unauthorized` · `forbidden` ·
`not-found` · `network` · `unknown`

Say the class and the next action. Never paste the provider's sentence.

## Gap classes

For the optional capabilities, every gap carries one of three classifications,
because the three need **opposite** responses:

| Class | What happened | Right response |
|---|---|---|
| `absent-on-this-machine` | the tool or server is not here | a local-setup instruction naming what to install |
| `scope-invalid-for-team` | the tool works; the recorded scope does not resolve | a targeted re-ask of that scope |
| `credential-under-scoped-for-target` | the tool works and is authenticated, but this credential lacks rights here | neither of the above |

That third class exists because both other responses are wrong for it. Re-asking
team scope invites one person to rewrite the team's shared value to fit their own
credential; a local-setup instruction names a tool they already have.

## GitHub is binary

`gh` or a GitHub MCP server. There is no degraded-completion class for GitHub, and
no third route — the dashboard GitHub App is out of scope for this plugin.

On the MCP route you invoke the tool yourself and hand the result to the verifier:
only an agent can call an MCP tool, and there is no command string for a
branch PR list over MCP, so the merged count you obtain **is** the base-branch
evidence on that route.

Failure wording, said once and plainly:

> GitHub is mandatory and I cannot move ahead without it. Without the code changes
> and the PRs merged into the branch under test, there is no culprit PR to name.

Then the next action, naming both routes. Then write the partial.

**The base-branch window.** A fixed 30-day lookback, independent of any build and
distinct from the run's per-build suspect window. Zero merged PRs is a **warning,
not a failure**: the branch is reachable, the window is merely empty. It persists
into the context rather than printing once, because it predicts a dead culprit hunt
and the person reading the eventual "no culprit PR identified" needs to know.

**Access level.** Report what the provider actually said. If it reports no scopes
at all — `gh` via keyring or device flow — that is its own state, `not-reportable`,
not "narrow" and not "broad". Both of those would be inventions. An over-broad
scope is a warning **alongside** a pass, never instead of it.

## Secrets

If a customer pastes a credential value, refuse it inline, do not echo it, and give
rotation guidance: it is already in the transcript once, and repeating it doubles
the exposure.

Detection is `looksLikeSecret`, **not** `redact`. `redact` needs a key prefix
(`token=`) or an auth scheme (`Bearer `) and returns text rather than a verdict, so
a bare pasted token comes back unchanged and a check built on it reports clean for
exactly the input that matters most.

The same guard runs again at write time over every field of the context, including
the credential-reference field — that is where a pasted secret most plausibly
lands, and the file is committed, where a leak is effectively permanent.
