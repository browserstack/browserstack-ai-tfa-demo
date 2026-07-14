# Template — gate summary (printed once, when THE GATE closes)

One terse FYI before autonomous execution starts. Every intake field is tagged
`given | assumed | gap`; every connector `valid | invalid | absent`. After this
prints, the run never asks the user anything.

If the product repo could not be corroborated against the failures AND no PRs
were supplied, the gate asks ONE question (interactive only) before printing
this summary. Headless skips it and prints `product repo: unknown (gap)`.

```
GATE CLOSED — capability manifest:
  github ✅ valid (gh, authed) · infra ✅ valid (via <kubectl ctx …, docker, ecs, …>) · logs ❌ absent · metrics ❌ absent

Intake:
  build id:        <id>                      (given)
  product repo:    <org/repo>                (assumed — corroborated vs failures | asked — human answered | unknown (gap))
  automation repo: <org/repo>                (assumed — cwd holds the tests)
  working branch:  <branch>                  (assumed — current branch)
  default branch:  <branch>                  (assumed — origin HEAD)
  PRs in play:     <#123, #456 | none>       (given | gap)

Gaps declared to TFA: <logs, metrics | none>
Proceeding autonomously: discovery → clustering → fan-out (concurrency <N>, turn-cap <M>).
```
