# Production Guardian — Health Scan (MVP 1) + Early Warning, AI Detective, Smart Resolve (MVP 2)

An AI-powered production health layer for InterSystems Health Connect. MVP 1 is **Health
Scan**: it reads production metrics from IRIS, compares them to a rolling baseline, and
surfaces findings — dead hosts, hung processes, queue buildup, error rates, slow processing,
system alerts. It detects and reports; it does not act (root `CLAUDE.md` §2).

## Running the whole chain

```bash
docker compose up -d
```

That is the whole thing, from an empty volume: namespace, interop, classes, web
applications, credential, production and HL7 traffic. **No second step.** First boot is
automatic — see below. Measured at **64 seconds** to all four services healthy on a cold
volume (Windows host, Docker Desktop, IRIS 2026.3.0AI Build 126U).

`./docker/up.sh` does the same thing and additionally runs the preflight image check, which
`compose up` cannot do for itself.

Then open **http://localhost:5173/?mode=live**

`?mode=live` matters. Without it the dashboard serves demo fixtures rather than live IRIS
data — which is the intended fallback, not a failure.

### Prerequisites — one time, and `up.sh` will tell you if you skip it

The IRIS image is **not pullable**. It comes from the InterSystems Early Access Program,
which needs a customer login rather than a registry credential, so this repo references a
**local tag** and contains no credentials at all.

```bash
# 1. Download the AI Hub image from the EAP portal.
#    It arrives as an OCI archive. Note it may be named .tar.gz while actually being an
#    uncompressed tar -- docker load handles either, so do not try to gunzip it first.
# 2. Load it
docker load -i <the-downloaded-file>
# 3. Tag it to the name compose expects
docker tag <loaded-name>:<tag> productionguardian/irishealth:local
```

One image, and no web gateway image: this build serves HTTP itself (see below).

`docker/preflight.sh` checks for the tag and prints this sequence if it is missing — because
Docker's own error is `pull access denied ... repository does not exist`, which reads as a
typo rather than a missed prerequisite. `up.sh` runs it; until #78 nothing did, which made
this heading untrue.

**Why a local tag rather than a registry path:** compose then reproduces *the* system every
measurement in `docs/decisions/0005` and issue #70 was taken against. Pointing at the public
community image instead would reproduce *a* system and put all of those numbers back in
question (#72).

### First boot — automatic

IRIS needs its namespace, classes, web applications, credential and production once. Compose
does it for you:

```yaml
command: ["-a", "sh /pg-firstboot.sh"]
```

`/iris-main -a <cmd>` runs a command **after** `iris start`, which is exactly the slot first
boot needs — and it leaves the image's own entrypoint in charge of starting and stopping IRIS
cleanly, which is the reason this used to be a documented manual step. Verified synchronous
rather than assumed from the flag name: a 12-second hook delays `...executed command` by 12
seconds.

It calls `ProductionGuardian.Setup.FirstBoot`, which is **idempotent** — every step reports
what it found rather than what it assumed, so it runs on every start and is a no-op after the
first. That is also what makes restarts work: `docker stop` kills IRIS with the production
running, and the next start would otherwise refuse with
`ErrProductionNotShutdownCleanly` — leaving the stack dead every second run. FirstBoot detects
that specific error, cleans and retries.

Watch it happen:

```bash
docker compose logs -f iris
```

### If `compose up` fails, read the IRIS log first

Now that first boot runs inside the container, **a first-boot failure surfaces three services
away from its cause**:

```
dependency failed to start: container pg-iris is unhealthy
```

That message names the symptom. The cause is in `docker compose logs iris` — every step of
`FirstBoot` prints what it did or what it could not do, and `pg-firstboot:` lines bracket the
run. The same applies to `metrics-proxy` or `detection-engine` reporting a failed dependency:
they are gated on IRIS being ready, so the explanation is upstream of them, not in their own
logs.

IRIS reports healthy only once the **LABDEMO production is serving interop metrics**, so
"unhealthy" after several minutes means first boot did not finish, not that IRIS is down. Check
in this order:

```bash
docker compose logs iris | grep pg-firstboot   # did first boot run, and did it finish?
docker compose logs iris | grep -E '^[0-9]'    # the numbered steps, and which one stopped
docker compose ps -a                           # iris-init should be Exited (0), not Exited (1)
```

To run it by hand (it is safe at any time):

```bash
docker compose exec iris sh /pg-firstboot.sh
```

## The four services

| service | port | what it does |
|---|---|---|
| `iris` | 52773 | LABDEMO namespace, the production, the HL7 generator — and the HTTP endpoints |
| `metrics-proxy` | 3001 | polls IRIS, serves per-host JSON |
| `detection-engine` | 3002 | rolling baseline, the eight rules, `/api/healthscan/*` |
| `dashboard` | 5173 | the operator UI |

Plus `iris-init`, which runs once to fix volume ownership and exits — a fresh named volume is
root-owned and IRIS runs as uid 51773, so without it IRIS dies before it starts.

**IRIS serves its own HTTP on 52773.** This image runs an embedded Apache
(`httpd ... -c Listen 52773`, and the image label `com.intersystems.ports.default.webserver`
says so), so `/api/monitor/*`, `/labdemo/*` and the Management Portal all come straight from
the `iris` container and there is no gateway service.

That **reverses #53's premise for this image.** "Nothing listens on 52773" was true of
`containers.intersystems.com/intersystems/irishealth`, which the demo instance runs — not of
the EAP build. So `Production.cls`'s original `127.0.0.1:52773` was right all along here, and
`FirstBoot.ApplyDeploymentSettings()` is what switches between the two deployments without a
code change. `docker/webgateway/` is kept for the demo instance, which *is* gateway-fronted;
compose does not use it.

## Inducing a finding

The dashboard is deliberately boring when the production is healthy. To see it work:

```bash
docker compose exec iris iris session IRIS -U LABDEMO
```

```objectscript
do ##class(ProductionGuardian.LabDemo.Triggers).Status()      // what is armed
do ##class(ProductionGuardian.LabDemo.Triggers).ErrorRate()   // four findings at once
do ##class(ProductionGuardian.LabDemo.Triggers).Reset()       // undo everything
```

One method per finding type, each idempotent, each printing what it changed *and* what it is
still waiting for. Full table in `iris/labdemo/README.md`.

**Do not `curl /api/monitor/alerts`** — it is consume-on-read, and reading it steals the
alert from the proxy. Read `http://localhost:3001/proxy/alerts` instead.

The Management Portal is at **http://localhost:52773/csp/sys/UtilHome.csp**.

## The MVP 2 demo — WHAT, WHY, FIX

One scenario, end to end: a queue builds on `Cloud API`, an AI agent explains why, and one
governed, approved, reversible action clears it.

### It runs without a key, and says so

`AGENT_MODE` defaults to `mock`, so a fresh clone demonstrates the **shape** of the loop with no
credential: the investigation is a canned narrative built from the live measured values, and the
resolve is applied against an in-memory pool size. Both are labelled — `source: "canned"`, and the
audit id reads `mock-audit-N`.

**The mock resolve reports `applied` and does not change the production.** That is deliberate and it
is the one thing to know before demonstrating from a clone: the pool stays at 1 and the queue keeps
growing. If the queue does not drain after an apply, check which mode you are in before looking for
a bug.

### For a live agent and a real write

```bash
export PG_LLM_API_KEY=sk-...          # OpenAI key; goes into the AI Hub wallet, never the repo
export PG_AGENT_MODE=live             # engine calls IRIS instead of its own mock
docker compose up -d
```

`PG_LLM_API_KEY` is read at first boot by `Setup.AIHub`, which creates the wallet entry and the
`AI.LLM.pgdetective` config that references it as `secret://PGSecrets.openai#apikey`. The key is
never written to the configuration, the repo, or a log line — the boot prints its length and that it
was stored. Rotating it is: change the variable, restart. `PG_LLM_MODEL` overrides the model
(default `gpt-4o-mini`).

Without the key the boot says so plainly and the loop still runs, canned:

```
4b. LLM provider: SKIPPED -- PG_LLM_API_KEY is not set
    AI Detective will serve a CANNED investigation (source "canned"), which is
    labelled and correct but is not a live agent. Set the variable to enable it.
```

### Driving it

```bash
docker compose exec iris iris session IRIS -U LABDEMO
```

```objectscript
// Arm: throttles the downstream to ~1s/message and raises inflow, after warming the baseline
// at zero. Takes about 2 minutes to produce a confirmed finding.
do ##class(ProductionGuardian.LabDemo.Triggers).PoolBottleneck()
do ##class(ProductionGuardian.LabDemo.Triggers).Status()   // what is armed, and the queue cap
do ##class(ProductionGuardian.LabDemo.Triggers).Reset()    // undo, including the pool size
```

Then, against the dashboard's own API path so it is the same route the UI uses:

```bash
# WHAT -- the finding
curl -s localhost:5173/api/healthscan/findings

# WHY -- root cause, evidence, a recommended action
curl -s -XPOST localhost:5173/api/investigate \
  -H 'Content-Type: application/json' -d '{"findingId":"<id from above>"}'

# FIX -- preview first, then apply
curl -s -XPOST localhost:5173/api/resolve -H 'Content-Type: application/json' \
  -d '{"mode":"dry_run","action":{"type":"set_pool_size","host":"Cloud API","size":4}}'

curl -s -XPOST localhost:5173/api/resolve -H 'Content-Type: application/json' \
  -d '{"mode":"apply","requestedBy":"you@laptop",
       "action":{"type":"set_pool_size","host":"Cloud API","size":4},
       "origin":{"findingId":"<id>"}}'
```

A live run looks like this — the queue drains because four workers clear ~4/sec against ~2/sec
inbound:

```
queue_buildup at 147  ->  investigate: gpt-4o-mini, 5 tool calls, recommends set_pool_size 4
apply -> applied 1 -> 4, audit pg-audit-2
queue 80 -> 42 -> 14 -> 0,  findings (all clear)
```

**If `investigate` returns `state: "unavailable"` with `note: "agent returned HTTP 500"`, the key is
wrong or expired.** That is the honest failure and worth recognising: `rootCause` is `null` and
`evidence` is empty rather than a plausible narrative, because a fabricated root cause is worse than
none when a human approves a production write on the strength of it. The FIX half is unaffected — it
does not use the LLM — so a bad key costs you WHY and nothing else.

### MVP 3 — the same loop where the answer is *no action at all*

MVP 2's scenario always ended in a governed fix, so nothing exercised the case where the correct
answer is **words for an operator**. This is that case, and it is the same three URLs.

```objectscript
// Arm: repoints EMR Source at a directory that does not exist. Takes ~20s to reach Error.
do ##class(ProductionGuardian.LabDemo.Triggers).MissingFolder()
do ##class(ProductionGuardian.LabDemo.Triggers).Status()   // reports the armed path
do ##class(ProductionGuardian.LabDemo.Triggers).Reset()    // restores the real path
```

```bash
curl -s localhost:5173/api/healthscan/findings          # dead_host on EMR Source
curl -s -XPOST localhost:5173/api/investigate \
  -H 'Content-Type: application/json' -d '{"findingId":"<the dead_host id>"}'
```

A live run:

```
source: agent   model: gpt-4o-mini   toolCalls: 4
recommendedAction: null                    <- there is no governed fix, and it says so
manualRemediation:
  summary: "Configured directory path does not exist."
  steps:   Check if the directory /tmp/labdemo/hl7-in-missing/ exists.
           Create the directory /tmp/labdemo/hl7-in-missing/ if it is missing.
  target:  {host: "EMR Source", setting: "FilePath",
            currentValue: "/tmp/labdemo/hl7-in-missing/"}
  appliedBy: "operator"
```

**`recommendedAction: null` with `manualRemediation` populated is the whole point** — the drawer
shows the fix in words and renders **no approve control**, because there is no `action` object to
send. That negative is the acceptance criterion, not a missing feature.

Two details that are easy to misread:

- **The path comes from `get_host_settings`, never from the log.** `get_recent_errors` returns a
  fixed catalogue string keyed by error code (`#5021` → "a configured directory or file path does
  not exist") and never message text, because `Ens_Util.Log` carries `PatientID` in plain text. So
  the agent learns the *kind* of fault from the catalogue and the *value* from configuration —
  which the data boundary permits.
- **`appliedBy` is set by us, not read from the model.** The prompt never mentions the field, so a
  model cannot assert `"system"`.

Also in MVP 3, and needing no setup: two rail entries under **Production Guardian** in the
dashboard — **Architecture** (two slides, drawn as SVG from the design tokens) and **Brochure**.
Both are static documents about the product; no API, no engine, no IRIS.

### Driving it from the dashboard instead of a terminal

The rail can carry buttons for the three scenarios plus **Reset all**, which is usually easier on
stage than a second window. **Off by default** — the flag is what enables it:

```bash
export PG_DEMO_TRIGGERS=1
docker compose up -d
```

Without it every trigger route answers **404** and the rail looks exactly as it does now. That is
deliberate rather than tidy: the buttons deliberately break the production, which is the opposite of
the governed, bounded, audited Smart Resolve write, so nothing in the shipped default can arm a
fault from a browser. Set it only on a throwaway demo instance.

The trigger's own explanation of what it armed comes back with the response, so the panel shows the
same text the terminal prints — which findings to expect, and which deliberately will not fire.
Armed state is read from IRIS on each poll, so driving the terminal at the same time stays correct.

**Reset all** is always available when the flag is on, and it is the same `Triggers.Reset()`
described above, with the same one caveat: a `system_alert` finding outlives it, because the alert
sits in the metrics proxy's in-memory buffer where IRIS cannot reach.

### Before a rehearsal: three things that will bite

- **`AGENT_MODE` defaults to `mock`.** Rebuild or restart the engine without `PG_AGENT_MODE=live`
  in the environment and `investigate` quietly serves `source: "canned"` — a plausible narrative
  built from real measured values, which looks correct and demonstrates nothing about the agent.
  Check `source` is `agent` and `toolCalls` is non-zero. That is the standing #108 check and it
  earns its keep: it caught exactly this regression during MVP 3.
- **Restarting the `iris` container reverts an armed trigger.** Recompiling `Production.cls` resets
  its settings, so `FilePath` and `PoolSize` go back to the shipped values and the scenario
  disarms itself. Re-arm after any restart; `Status()` shows what is actually live.
- **A live agent is not deterministic.** The model occasionally proposes `set_pool_size` on a host
  the tool does not accept. `AgentDispatcher.DropUnapplicableAction()` removes such a
  recommendation before it reaches the UI, reading the permitted host from the tool itself — so the
  drawer never offers an approve button for an action that would be refused. The prompt asks; this
  enforces.

### What the safety model actually enforces

- **One action, one host, bounded.** `set_pool_size` on `Cloud API`, size `2`–`8`. Anything else is
  refused by the tool with a named reason — including size `1`, because `1` is the shipped value and
  "setting it to 1" is a no-op dressed as a fix.
- **Dry run first, and it cannot mutate** — that path returns before the write.
- **Reversible.** Every response carries the prior value in `reversal`, captured live. Undo with
  `Triggers.Reset()`.
- **RBAC-gated and audited.** Every tool call, read and write, becomes a row in
  `ProductionGuardian.LabDemo.Audit.Entry` naming the actor. An unauthorized caller is refused with
  `200` and `refusal.reason: "not_authorized"`, and *the refusal is audited too*.
- **Metrics and configuration only ever leave the instance.** Never message content, never PHI.

```objectscript
do ##class(ProductionGuardian.Setup.AIHub).Status()          // roles, tools, provider
do ##class(ProductionGuardian.LabDemo.Audit.Entry).Purge()   // reset the log between rehearsals
```

**One caveat, stated rather than buried:** the engine authenticates to IRIS as `superuser`, which
holds `%All`, and under `%All` a resource check passes for everything — so the RBAC boundary is
proven by `iris/test/GovernanceProof.cls` with a purpose-made unprivileged principal rather than by
the running demo. See issue #104 for why that is not fixed yet (this image has no `%Ens_*`
privileges to grant).

## Running without IRIS

The engine defaults to `PROXY_MODE=mock` (ADR 0004), so the engine and dashboard stand up
with no IRIS and no proxy at all — fixtures over real HTTP, all eight finding types. That is
how the consumer side of the contract is verifiable on any machine (#70).

## One runtime image, and a CI job with no choice

Compose uses the **EAP AI Hub** image — the one every live measurement was taken against.
There is no second runtime image.

CI's `iris-compile` job compiles against the **public** `intersystems/irishealth-community`
image because a GitHub-hosted runner cannot authenticate to a private registry, let alone
perform an EAP download. So that job's choice was never *which image to prefer* — it was
*compile-check the ObjectScript on every PR, or not at all*.

**Do not align them.** The consequence is that `iris-compile` is a **subset check**: it has
never produced a false pass, but it will go red on correct code the day we depend on an
AI-Hub-only class. The options for that day are ranked in a comment beside the job, because
the cheapest response to a red build — deleting the job — is the worst one.

## Documentation

| | |
|---|---|
| Shared rules, scope boundary, ownership | `CLAUDE.md` |
| Why the code is shaped as it is | `docs/decisions/` |
| The two API contracts | `contracts/` |
| LABDEMO, triggers, setup | `iris/labdemo/README.md` |
| Per-area detail | `apps/dashboard/`, `services/*/CLAUDE.md` |

MVP 1 does not meet one clause of its acceptance criteria, deliberately and on the record:
see **ADR 0005** for the latency bar and why 10 s was not reachable without giving up the
false-positive protection MVP §6 asks for.
