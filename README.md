# Production Guardian — Health Scan (MVP 1)

An AI-powered production health layer for InterSystems Health Connect. MVP 1 is **Health
Scan**: it reads production metrics from IRIS, compares them to a rolling baseline, and
surfaces findings — dead hosts, hung processes, queue buildup, error rates, slow processing,
system alerts. It detects and reports; it does not act (root `CLAUDE.md` §2).

## Running the whole chain

```bash
docker compose up
```

Then open **http://localhost:5173/?mode=live**

`?mode=live` matters. Without it the dashboard serves demo fixtures rather than live IRIS
data — which is the intended fallback, not a failure.

### Prerequisites — one time, and `compose up` will tell you if you skip it

The IRIS image is **not pullable**. It comes from the InterSystems Early Access Program,
which needs a customer login rather than a registry credential, so this repo references a
**local tag** and contains no credentials at all.

```bash
# 1. Download the AI Hub image from the EAP portal
# 2. Load it
docker load -i <the-downloaded-file>
# 3. Tag it to the name compose expects
docker tag <loaded-name>:<tag> productionguardian/irishealth:local
```

Same for the web gateway image, tagged `productionguardian/webgateway:local`.

`docker/preflight.sh` checks for the tag and prints this sequence if it is missing — because
Docker's own error is `pull access denied ... repository does not exist`, which reads as a
typo rather than a missed prerequisite.

**Why a local tag rather than a registry path:** compose then reproduces *the* system every
measurement in `docs/decisions/0005` and issue #70 was taken against. Pointing at the public
community image instead would reproduce *a* system and put all of those numbers back in
question (#72).

### First boot

IRIS needs its namespace, classes, web applications, credential and production once:

```bash
docker compose exec iris /pg-firstboot.sh
```

This calls `ProductionGuardian.Setup.FirstBoot`, which is idempotent — safe to re-run, and
it reports what it found rather than what it assumed. It is not the container entrypoint on
purpose: the image's own `/iris-main` must stay in charge of starting and stopping IRIS
cleanly, and first boot has to happen *after* IRIS is accepting sessions.

## The five services

| service | port | what it does |
|---|---|---|
| `iris` | — | LABDEMO namespace, the production, the HL7 generator |
| `webgateway` | 80 | Apache + the IRIS gateway. `/api/monitor/*`, `/labdemo/*`, the Management Portal |
| `metrics-proxy` | 3001 | polls IRIS, serves per-host JSON |
| `detection-engine` | 3002 | rolling baseline, the eight rules, `/api/healthscan/*` |
| `dashboard` | 5173 | the operator UI |

Nothing listens on 52773. The REST endpoints live behind the **gateway**, which is why
`Production.cls` names a hostname rather than `127.0.0.1` (#53).

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

## Running without IRIS

The engine defaults to `PROXY_MODE=mock` (ADR 0004), so the engine and dashboard stand up
with no IRIS and no proxy at all — fixtures over real HTTP, all eight finding types. That is
how the consumer side of the contract is verifiable on any machine (#70).

## Two images, deliberately

CI's `iris-compile` job uses the **public** `intersystems/irishealth-community` image,
because CI cannot authenticate to a private registry and a compile only needs `Ens.*` and the
HL7 schema. Compose uses the **EAP AI Hub** image, because that is what every live
measurement was taken against.

Do not "fix" this to use one image. The divergence is stated in `docker-compose.yml` and
`.github/workflows/ci.yml` for that reason.

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
