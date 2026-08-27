# What bounds a capability — how to ask a relevant question

Loaded with `<pluginRoot>/skills/rca-build/references/interview.md` at
`<pluginRoot>/skills/rca-build/SKILL.md` § Step 0b (T5/T6), and again whenever a
gate re-ask has to bound one capability. That file owns the turn order and the
question shapes; this file owns **what to ask about**, per
capability: what has to be *bounded* before a read can be scoped, what **verified**
means, and the shape of a read that proves it.

A generic question ("what's your logging setup?") gets a generic answer and bounds
nothing. Relevance is knowledge that can be written down once, so it is written
here rather than guessed per run.

**Contents:** [How to read an entry](#how-to-read-an-entry) ·
[Two hard rules](#two-hard-rules) ·
[The empty-read rule](#the-empty-read-rule-stated-once-applies-to-every-capability) ·
[github](#github--mandatory) · [ci](#ci) · [logs](#logs) · [infra](#infra) ·
[metrics](#metrics) · [other](#other)

## How to read an entry

Each entry is four things, in this order:

1. **What bounds the read** — the levels, stated abstractly. This is the rule.
2. **A table instantiating it across differently-built stacks** — illustrations,
   never a menu. Concrete products appear **only** in these tables, at least three
   alternatives per table, so no single one reads as the default. **No product name
   appears in any generic rule, any heading, any "verified means" sentence, or any
   standalone example** — and every table ends with its no-match escape.
3. **Verified means** — the one sentence that decides whether a connector is
   written or a gap is recorded.
4. **What nothing downstream reads** — the levels not to ask for.

`github` is the exception to the neutrality rule: it is mandatory and there are
exactly two supported routes, so it is concrete throughout.

## Two hard rules

**Ask only for levels the customer's stack actually has.** A process manager on
hosts has no namespace; a single-repo team has no monorepo subpath; a
forge-native CI has no separate project id. Asking for a level that does not exist
tells the customer you do not understand their setup, and the answer you get back
will be an invented one that fails at first use.

**Never ask a question whose answer nothing downstream reads.** Every part of every
question names its consumer — the routed ask, the manifest field, or the culprit-PR
hunt that eats it. If you cannot name the consumer, cut the question. Each entry
below names its consumers under *what nothing downstream reads*.

## Where a bound comes from before you ask

Every entry below states the levels a read needs. It does not say where the answer
comes from, and the cheapest source is the one easiest to walk past: **the build's
own metadata.** Its name, branch, tags, environment label and CI URL are already in
hand from the insights read at T1, and they describe *this* run rather than the
customer's setup in general.

> **Before asking a human for a level, and before listing a live control plane for
> it, check whether the build's metadata already names it.** An environment or
> tenant label on a build is frequently the literal name of the grouping its reads
> have to be scoped to.

This matters most where a product-named grouping and a per-run one both exist and
both answer to the product's name. Searching a control plane for the product's name
finds the shared one; only the metadata says which one served this build. Picking
the wrong one reads as success — an authorised read returning the wrong workload's
evidence — which the empty-read rule below cannot catch, because the read was not
empty.

Getting this from a human instead is worse than slow: a level they supply from
memory is the same guess with a confirmation attached.

## The no-match escape

Every table below is a closed list of stack shapes, and a closed list of shapes is
the same failure as the closed list of vendor names this design deleted — one turn
more abstract. So each table ends with the same escape, and it is not optional:

> **If the customer's stack matches no row, derive the bounds from their own
> vocabulary and omit any level they lack — never map them onto the nearest row.**

Mapping onto the nearest row is how a team gets asked for a "namespace" they do not
have, or a "cluster" that is one box.

## The empty-read rule (stated once, applies to every capability)

**Zero rows from a log, metrics, CI or runtime query in a quiet window is the
normal healthy case during an RCA.** Most windows this plugin reads are minutes
long and most services are quiet in them.

> **Verification asks only whether the read was AUTHORISED. Zero rows inside the
> window is a warning on the connector, never a gap.**

Record it as a verified connector — `verifiedBy: {count: 0, note: "<what the window
was>"}`; a count of 0 is a decidable claim and the runnable predicate accepts it —
plus a line in the digest so a human can see it. Getting this wrong makes the run
declare a capability unavailable to the BrowserStack agent that it actually had
access to, and the RCA then silently omits evidence it could have gathered. The two
outcomes that *are* gaps: the read was refused (auth, permission, unknown target),
or the target does not exist.

---

## `github` — mandatory

**What bounds a code read.** Four things: the **repo**, the **role** that repo
plays (product code under test versus the automation suite that produced the
build), the **base branch** merged PRs land on, and the **owned subpaths** inside
the repo these tests exercise. Role is asked, never guessed: a flat repo list
forces the "if there's exactly one other repo it must be the automation repo"
guess, and that guess attributes failures to the wrong codebase.

Two routes, and only two: a **GitHub MCP server** in this session, or the **`gh`
CLI** authenticated for the org. The dashboard GitHub App is out of scope for this
plugin — see `interview.md` § GitHub failure classes for the wording that keeps
that from becoming a support ticket.

| If the code lives as… | repo(s) | base branch | owned subpaths |
|---|---|---|---|
| one service in one repo | the repo | its default branch | — (the whole repo is owned) |
| several services in a monorepo | the monorepo | its default branch | the service directories these tests exercise |
| services split across repos | one per service, plus the automation repo | per repo — they differ | — per repo |
| a fork or mirror that PRs land on upstream | both, and which one merges | the branch on the repo that *merges* | — |

**If the customer's stack matches no row, derive the bounds from their own
vocabulary and omit any level they lack — never map them onto the nearest row.**

**Verified means** a listing of PRs merged into the **named base branch of the
named repo** came back, or a repo read returned that repo's default branch.
`gh auth status`, a version banner, and "the MCP tool is in the session list" are
**route checks, not verification**: they prove a route exists and say nothing about
whether this credential can see that repo.

**What nothing downstream reads:** issue trackers, labels, review state, CI status
checks on the PR (that is `ci`), and org membership. The consumers are the
culprit-PR hunt (`<pluginRoot>/skills/rca-build/references/github-evidence.md`) and
Part B's intake resolution — nothing else.

## `ci`

**What bounds a pipeline read.** Three things: the **project** the pipeline belongs
to, the **pipeline identity** within it, and — the one teams forget — **how a build
maps to a run**. Without the mapping you can list runs and still not know which one
produced this build, which makes every run of the pipeline equally suspect.

| If CI is… | project | pipeline identity | build→run mapping |
|---|---|---|---|
| native to the git forge (GitHub Actions, GitLab CI) | the repo | the workflow file or job name | the head commit sha |
| a standalone server (Jenkins, TeamCity) | the folder or view | the job path | the run's recorded build tag or parameter |
| a hosted pipeline service (CircleCI, Buildkite, Azure Pipelines) | the org + project slug | the pipeline name | the branch plus the run's start time window |
| the same system that runs the tests | — (there is no second system) | — | it *is* the build; use the forge fallback below |

**If the customer's stack matches no row, derive the bounds from their own
vocabulary and omit any level they lack — never map them onto the nearest row.**

**Verified means** one run of the **named pipeline** came back carrying the field
that maps it to a build. A run listing with no mapping field is not verification: it
proves the pipeline exists and leaves every subsequent `ci` ask unanswerable.

**Store the mapping, never the resolved run.** A run number pinned into the stored call
keeps answering long after it stops being this build's run, so the gate's replay returns
success while the evidence belongs to another build — see `interview.md` § Authoring a
procedure for why a passing probe is the dangerous shape here.

**Two legitimate sources for the run itself, in this order:** a run the customer pinned at
invocation, then the build's own metadata (`SKILL.md` § Part B, precedence). The pinned one
wins — a customer naming a run is stating which one to read, and losing that to
`ci_build_url` is the wrong-run read this rule exists to prevent, arrived at from the other
direction.

Many teams have no separate CI system, and that is a correct answer — neither a
connector nor a gap. `<pluginRoot>/config/rca.config.json` routes a `ci` ask to the
`github` capability as `fallbackCapability`, resolved once in `buildManifest`, so
the fallback keeps serving `ci` evidence without declaring a phantom gap.

**So record nothing for `ci` in that case.** Do not invent a connector to avoid a
gap, and do not write a gap either: a gap says the evidence will not be gathered,
and it will be. `missingCapabilities` treats a capability whose fallback has a
connector as covered, so the profile still counts as provisioned and the gate will
not offer to resume a finished interview. Writing a gap here would make the digest
report "ci unavailable" about a connector that works.

**What nothing downstream reads:** build queues, agent pools, artifact retention,
per-step timings. The consumer is a routed `ci` ask
(`<pluginRoot>/skills/rca-build/references/evidence-routing.md`).

## `logs`

**What bounds a log read.** Three things: the **store or dataset** the lines are
in, the **field that carries the service or workload identity**, and the **time
bound**. The identity field is the level most often skipped and the one that makes
the difference between a scoped read and a raw tail — and this plugin never reads a
raw tail (`<pluginRoot>/skills/rca-build/references/github-evidence.md` § Field-filtering).

| If the log store is… | store / dataset | identity field | time bound |
|---|---|---|---|
| an index-based search store (Elasticsearch, OpenSearch) | the index or index pattern | the mapped field holding the service name | an absolute from/to on the timestamp field |
| a query-language store (Loki, CloudWatch Logs Insights, BigQuery) | the log group, stream set, or table | the label or column selected on | the query's own range clause |
| an event platform (Datadog Logs, Honeycomb, Splunk) | the dataset or index | the tag or attribute | the query's relative window |
| files on hosts, collected by an agent | the path glob | the filename or a prefix in the line | the file's rotation window |

**If the customer's stack matches no row, derive the bounds from their own
vocabulary and omit any level they lack — never map them onto the nearest row.**

**Verified means** a query against the **named dataset**, filtered on the **named
identity field** for the workload in play, was authorised and returned a result set
— rows, or an empty result set for the window. See § The empty-read rule: an empty
window here is a warning, and a service that logs nothing in a quiet six-hour
window is ordinary.

**Never** verify by reading the store's health endpoint, its index list, or its
version. Those prove the store is up; they say nothing about whether this
credential can read this dataset.

**What nothing downstream reads:** retention policy, ingest volume, parser
configuration, the full field mapping. The consumers are routed `kibana`/log asks —
and note that TFA owns **test** logs and the client never gathers them
(`<pluginRoot>/skills/rca-build/references/evidence-routing.md`); this capability is the customer's
**application** logs only.

## `infra`

**What bounds a runtime read.** Three things: the *control plane* you are talking
to, the *logical grouping* inside it, and the *workload* itself. Ask for whichever
of the three the pre-read did not already answer, and never ask for a level the
customer's runtime does not have.

| If the runtime is… | control plane | grouping | workload |
|---|---|---|---|
| a container orchestrator (Kubernetes, OpenShift) | cluster / context | namespace | deployment or pod selector |
| a managed container service (ECS, Cloud Run) | account + region | cluster | service / task family |
| a scheduler (Nomad, Mesos) | region / datacentre | job namespace | job + task group |
| a process manager on hosts (systemd, PM2, Supervisor) | the host or host group | — | process name |
| a serverless platform (Lambda, Cloud Functions) | account + region | app | function |

**If the customer's stack matches no row, derive the bounds from their own
vocabulary and omit any level they lack — never map them onto the nearest row.**

**Verified means** the named grouping answered *for the named workload* — a listing
that includes it, or a log line from it. A version banner from the CLI is not
verification: it proves the binary exists and says nothing about whether this
credential can see that workload.

An authorised listing that comes back empty (the workload is scaled to zero, the
window is quiet) is a **warning on the connector, not a gap** — § The empty-read
rule.

**What nothing downstream reads:** node inventory, resource quotas, the full
manifest, anything about workloads other than the ones these tests exercise. The
consumer is a routed `infra`/`k8s` ask — and `k8s` there is the sender's wire
vocabulary, not a claim about the customer's stack.

## `metrics`

**What bounds a metrics read.** Three things: the **query surface** (the endpoint
or workspace the query goes to), the **label or dimension that carries the workload
identity**, and **one metric name known to exist**. The last one is not a
formality: a query surface answers happily for a metric nobody ever emitted, which
is indistinguishable from a working connector until the RCA needs a number.

| If the metrics backend is… | query surface | identity label | a metric known to exist |
|---|---|---|---|
| a PromQL-compatible endpoint (Prometheus, Thanos, VictoriaMetrics) | the query endpoint | the label the scrape config sets | one series name from that scrape |
| a hosted metrics API (Datadog, New Relic, Grafana Cloud) | the org/account + API host | the tag or facet | one metric from the dashboard the team already uses |
| a cloud provider's metric store (CloudWatch, Cloud Monitoring) | account + region | the namespace + dimension pair | one metric in that namespace |
| an application-emitted store (StatsD/Graphite trees) | the host + prefix | the path segment naming the service | one leaf under that prefix |

**If the customer's stack matches no row, derive the bounds from their own
vocabulary and omit any level they lack — never map them onto the nearest row.**

**Verified means** a query executed against the **named surface**, filtered on the
**named identity label**, returned a series or an empty series set for the window —
and the metric name resolved rather than being rejected as unknown. A metadata or
label-values call that names the metric is enough; a health check or a build-info
read is not.

An empty series set inside a quiet window is a **warning, not a gap** — § The
empty-read rule. A metric name the surface *rejects* is a gap: that is a refusal,
not an empty window.

**What nothing downstream reads:** alert rules, recording rules, dashboard
definitions, the full metric catalogue. The consumer is a routed `metrics` ask.

## `other`

The catch-all, and the only entry whose first bound is a sentence rather than a
level. **What bounds it:** one sentence of **purpose** naming the ask it would
serve, plus **one proving read**. If the customer cannot say which kind of question
the tool answers, there is nothing to route to it and it should not be recorded.

| If the tool is… | purpose it serves | a single proving read |
|---|---|---|
| a bespoke internal service CLI or API | "it tells us the deployed version of a service" | that read, for the workload in play |
| a ticketing or incident system (Jira, PagerDuty, Linear) | "it says whether this was a known incident at that time" | one query over the failure window |
| a feature-flag service (LaunchDarkly, Unleash, Flagsmith) | "it says whether the flag guarding this code was on" | one flag's state, for the run's environment |

**If the customer's stack matches no row, derive the bounds from their own
vocabulary and omit any level they lack — never map them onto the nearest row.**

**Verified means** the one proving read named in the purpose sentence came back
authorised. Empty is a warning — § The empty-read rule.

**What nothing downstream reads:** anything the purpose sentence does not mention.
`other` is best-effort by ask text, so a connector whose purpose sentence does not
resemble any ask will simply never be routed to — record it only when the purpose
is specific. Note also that the gate digest deliberately does **not** list `other`
as a missing connector, because it would otherwise show as a gap on every run
(`<pluginRoot>/skills/rca-build/templates/gate-summary.md`).
