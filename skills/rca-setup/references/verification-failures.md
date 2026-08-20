# Verification failures

Load this file **before verifying anything**. It defines what verification proves,
what a report must contain, and how GitHub differs from everything else.

**Contents:** [What counts as verified](#what-counts-as-verified) ·
[The report](#what-you-report) · [Gap classes](#gap-classes) ·
[GitHub is binary](#github-is-binary) · [Secrets](#secrets)

## What counts as verified

A live read against the **resolved scope** — not the presence of a tool, and not
the presence of a credential. A runtime CLI being on PATH says nothing about
whether `prod` exists or whether this credential can see it. What counts for a
given capability is stated in that row's `intent` in `config/rca.config.json`;
read it, because it differs by capability.

**Per target, not per tool.** A capability valid for `acme/api` and 404 on
`acme/ghost` stays valid for `acme/api`; the failure is a scoped gap. Collapsing
that into a dead capability is what makes a coordinator degrade to "unavailable"
over one bad value.

**You choose the check.** There are no probe commands in the table. There were —
templates with the customer's scope interpolated in — and that design needed a
command gate, an interpolation guard and a per-runtime probe table to be safe,
produced a shell-injection escape anyway, and still could not verify a stack
nobody had listed. How to read a Fly.io app, a Coralogix index or a Dynatrace
scope is your judgement.

## What you report

`validateVerification` takes your report and holds you to this shape:

| Field | Why |
|---|---|
| `field` | which answer to fix — and it must be one the row DECLARES |
| `value` | what you checked it against |
| `ok` | your verdict for this target |
| `checkedBy` | **what you actually ran**, with its scoping arguments |
| `gap.class` | one of the three below, on a failure |
| `gap.nextAction` | non-empty, always — a diagnostic with no next step strands someone |

`checkedBy` is the load-bearing one. **A target reported `ok` with no `checkedBy`
is recorded `unverified`, not verified** — a claim with no named check carries no
information, and this is precisely what stopped a capability probe standing in for
a scope it had never read. Name the tool or command AND the arguments that scoped
it, specifically enough that a reader can tell what was proven.

A target you could reach but could not prove is `{ok: false, state: "unverified"}`
and needs no gap: nothing is wrong, there is simply no evidence. That is a real
state, not a soft failure.

**Raw provider output never reaches a report.** Reduce a failure to its class and
its next action; the bytes stay in your context. Not redacted-and-kept, because a
redacted string still carries whatever the redactor missed, and this record can end
up committed. `validateVerification` refuses a `raw`/`stdout`/`stderr`/`body` key
anywhere in the shape, and strips it rather than passing it on.

If a value looks like a typo, say so in the `nextAction` — but only when you are
confident. A wrong suggestion sends someone to correct a value that was already
right, which costs more than saying nothing.

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
