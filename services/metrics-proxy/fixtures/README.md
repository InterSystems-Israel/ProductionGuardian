# fixtures/

Captures from a live IRIS instance, plus the smaller hand-written excerpts that predate
them. Committed so every developer mocks against the same bytes (ADR 0004).

**Selecting a fixture on Windows.** The `MOCK_FIXTURE=… npm run mock` and
`MOCK_HOSTSTATUS=… npm run mock` forms below are POSIX; PowerShell reads the prefix as the command
name and fails with `The term 'MOCK_FIXTURE=metrics.txt' is not recognized`. Two lines instead —
`$env:MOCK_FIXTURE = 'metrics.txt'`, then `npm run mock` — and **clear it afterwards**
(`Remove-Item Env:\MOCK_FIXTURE`), because unlike the POSIX prefix it stays set for the window and
the next `npm run mock` in that terminal keeps serving the trimmed excerpt while looking like the
default. Root `README.md` → *On Windows* has the whole table.

| File | Provenance |
|---|---|
| `metrics-live-capture.txt` | **Real, and the mock default.** Full 310-line `/api/monitor/metrics` body, IRIS for Health 2024.1 on Windows, captured 2026-08-11 **after** the production items were renamed to the spaced contract names. 12 hosts, 3 application. |
| `metrics-live-capture-preRename.txt` | **Real.** The same instance earlier the same day, 313 lines, before the rename: unspaced item names (`EMRSource`, `LabRouter`), `PIDExtractProcess` present, activity reporter called `ActivityReporter`. |
| `alerts-live-capture.json` | **Real.** Full `/api/monitor/alerts` body, same instance, 2026-08-11. See the warning below — this endpoint cannot be re-captured at will. |
| `hoststatus-live-capture.json` | **Real, and the mock default for per-host queued/errored.** Body served over HTTP by `/labdemo/monitor/hoststatus` from live LABDEMO, IRIS for Health 2026.1, captured 2026-08-12. 13 hosts, 4 application, production `Running`. See below. |
| `metrics-live-capture-3host.txt` | **Real, and the only capture taken from the production this repo defines.** 1383 lines, IRIS for Health 2026.1, captured 2026-08-12 with the generator running, immediately after `ProductionGuardian.LabDemo.Production` was first deployed (#34). 12 hosts, 3 application. Carries all four signals the earlier 3-host capture lacked — see below. |
| `hoststatus-live-capture-3host.json` | **Real.** `/labdemo/monitor/hoststatus` from the same production, same moment. 10 hosts, 3 application, production `Running`. |
| `hoststatus-live-capture-hosttype.json` | **Real, and the only capture carrying `hostType`.** `/labdemo/monitor/hoststatus` from `ProductionGuardian.LabDemo.Production`, IRIS for Health 2026.1, captured 2026-08-26 immediately after #127 added the field. 10 hosts, production `Running`. See below. |
| `metrics.txt` | Hand-trimmed 3-host excerpt in the real label shape. Small enough to reason about; `MOCK_FIXTURE=metrics.txt npm run mock` serves it. |
| `alerts.json` | **Hand-written, and its field names are wrong** — see below. |

## Two unrelated productions, not two versions of one (#34)

**The captures come from more than one environment, and — more importantly — from two
productions that were never related to each other.** Getting this wrong cost a full
diagnosis cycle, so it is recorded here rather than re-derived.

| Capture | Production | Application hosts |
|---|---|---|
| `metrics-live-capture.txt`, `metrics-live-capture-preRename.txt` | `ProductionGuardian.LabDemo.Production` | 3 |
| `hoststatus-live-capture.json` | **`LABDEMO.Production`** | **4** (incl. `FHIR Transform`) |
| `metrics-live-capture-3host.txt`, `hoststatus-live-capture-3host.json` | `ProductionGuardian.LabDemo.Production` | 3 |

`LABDEMO.Production` had its own class tree (`LABDEMO.Service.EMRSource`,
`LABDEMO.Process.FHIRTransform`, …) that **does not exist in this repo**. It was not a
stale deployment of `Production.cls` — there was no version of `Production.cls` it was
behind. `ProductionGuardian.LabDemo.Production` was not compiled in that namespace at all
until 2026-08-12, when 9 of this repo's 10 classes were deployed for the first time.

So a 4-host roster in a capture is not evidence that `Production.cls` ever had four items.
Both rosters were always correct, about different productions. The `-3host` captures are
the first from a production this repo actually defines, which is why they supersede rather
than merely update the others.

`LABDEMO.Production` is deliberately **not deleted**: it is the only artifact of whatever
built it, and #43/#44's measurements were taken against it.

## What the earlier 3-host capture is missing, and why it matters

`metrics-live-capture.txt` was taken from an **idle** production, so three metric families
and one label value are absent from it entirely:

| | `metrics-live-capture.txt` | `metrics-live-capture-3host.txt` |
|---|---|---|
| `iris_interop_last_activity` | absent | **present** |
| `iris_interop_messages_errored` | absent | **present** |
| `hosttype="actor"` | absent (only `service`) | **present** |
| `iris_interop_avg_processing_time` | present | present |

Those are the inputs to `stalled_host`, to #31, and to PROXY-Q6. **A capture taken from an
idle production cannot serve as evidence about them** — it looks like a production with no
errors and no activity rather than one that does not publish those figures per host. Always
capture with the generator running.

## #31 confirmed on the shipped production

#31's conclusion — `iris_interop_messages_errored` carries no `host` label — previously
rested only on the 4-host capture, i.e. on a production we do not ship. Re-confirmed
2026-08-12 against `ProductionGuardian.LabDemo.Production` with traffic flowing:

```
iris_interop_messages_errored{id="LABDEMO",production="ProductionGuardian.LabDemo.Production"} 0
iris_interop_queued{id="LABDEMO",production="ProductionGuardian.LabDemo.Production"} 0
```

One line each, no `host` label, while `iris_interop_last_activity` (11 lines) and
`iris_interop_avg_processing_time` (4 lines) do carry one. So the per-host/per-production
split is a property of IRIS, not of that one environment.

## Why the pre-rename capture is kept

`host` is the join key between the proxy, the findings API and the dashboard, and its
value changed spelling: `EMRSource` → `EMR Source`, `LabRouter` → `Lab Router`,
`ActivityReporter` → `Ens.Activity.Operation.Local`, and `PIDExtractProcess` was removed.

Both captures are covered by `src/parser.test.js`. A parser that only handles the current
spelling would pass against this instance and break against a colleague still running the
older production definition. The pre-rename file is also the only fixture where
`iris_system_alerts_new` is nonzero — the later capture reads `0` because the alerts had
already been consumed by then.

Only three application hosts exist now. `contracts/samples/hosts-response.json` lists
four, including `FHIR Transform`, which no longer exists in the production — PR #15
removes it and is still open.

## `hoststatus-live-capture.json` — where per-host `queued` and `errored` come from

Neither `iris_interop_queued` nor `iris_interop_messages_errored` carries a `host` label:
both are emitted once per production. So `queued` and `errored` were `null` on every host
and `queue_buildup` (#12) and `elevated_error_rate` (#31) could not fire. This fixture is
the body of the endpoint that supplies them —
`iris/labdemo/REST/HostStatusDispatcher.cls`, wrapping
`Ens.Util.Statistics:EnumerateHostStatus` — captured over HTTP, not hand-written.

**The join key is exact.** `EnumerateHostStatus`'s `Name` column and the metrics `host`
label are the same string, spaces intact (`Cloud API`, `Lab Router`), which is why
`src/hoststatus.js` merges with a plain map lookup and deliberately normalizes nothing.

Two values in it are worth knowing are real:

- **`queued: 0` here is a measured zero, not an absent reading.** The underlying query
  returns the **empty string** for an idle host — its shipped source does
  `If tQueueCount=0 Set tQueueCount=""` — so empty genuinely means "read the counter, it
  was 0". The endpoint coerces it to `0`.
- **`errored: 0` is a real count**, guarded by `_meta.erroredAvailable`. When that is
  `false` the proxy keeps `errored: null` rather than publishing a `0` it did not measure.

**Every `queued` in this capture is `0`, and a non-zero depth is NOT in any fixture.** The
production is healthy and drains immediately; 400 samples of `Ens.Queue.GetCount` and 40
of `EnumerateHostStatus` all read `0`/empty. Inducing a backlog means disabling a host,
which is a production change and out of bounds on the shared instance. A depth of `70` was
measured earlier on this instance with `Cloud API` disabled (#12), and the non-zero path is
covered by a synthetic case in `src/hoststatus.test.js` labelled as such. So: the plumbing
is verified end to end against live IRIS, and `queue_buildup` actually firing is a separate
unverified milestone — note `absoluteFloor: 50` in the engine's thresholds.

`MOCK_HOSTSTATUS=` (empty) serves the mock without it, reproducing the old
`queued: null` behaviour for an instance where the endpoint is not deployed.

## `hoststatus-live-capture-hosttype.json` — where most of `type` comes from (#127)

The earlier host-status captures **predate `hostType` and are kept unchanged**, since they are
bodies an endpoint actually served and back-filling a field into one would make it a hand-written
approximation wearing a real capture's provenance. This is the re-capture, taken after
`HostStatusDispatcher` started publishing the column.

`hostType` is the **raw IRIS word** from `EnumerateHostStatus`'s `Type` column, uninterpreted:
`BusinessService`, `BusinessOperation`, `BusinessProcess`, `Actor`. The proxy folds it into the
published `service`/`operation`/`process` vocabulary; IRIS does not, so that mapping lives in exactly
one place (`_hostType()` in `src/parser.js`).

Why the field exists: the `hosttype` **label** rides only on the `avg_*` metric families, so a host
nothing has flowed through carried no type and `type` read `'unknown'` — 8 of 12 hosts on this
production. This column covers every host the query enumerates, activity or not. The fill is
strictly additive (only where the metrics-derived type is `unknown`), so it cannot regress a type
that was already right.

**Two things in this capture are worth knowing are real, and one is a genuine gap.** `Ens.Actor`
reports `Actor` — the one host that exercises the `Actor → process` mapping. `Cloud API` reports
`errored: 813`, a real backlog from a pool-bottleneck experiment running at capture time, not a
healthy production. And **`Ens.Alarm` is absent from this payload entirely**: the query does not
enumerate it, so it is the one host in the metrics text that neither source can type and it stays
`unknown`. That is not a defect to fix here — it is what `_meta.hostStatus.untypedHosts` reports.

This capture is **not** the mock default. `hoststatus-live-capture.json` still is, paired with
`metrics-live-capture.txt`, so the mock keeps reproducing the pre-#127 endpoint — which is also a
real deployment state, since an instance whose dispatcher predates the field sends no `hostType` and
must degrade to the old `unknown` behaviour. Serve this one instead with
`MOCK_HOSTSTATUS=hoststatus-live-capture-hosttype.json npm run mock`.

## `/api/monitor/alerts` is consume-on-read

Verified 2026-08-11 against IRIS 2024.1: the first `GET` returned two alerts and every
`GET` after it returned `[]`, while `iris_system_alerts_log` stayed at `2` and
`iris_system_alerts_new` dropped `1 → 0`. The endpoint returns alerts *new since the
last read* and clears them. `mgr/alerts.log` keeps the durable copy.

Consequences:

- **`alerts-live-capture.json` may be the only JSON-shaped copy of this data.** It was
  obtained by accident, on the first-ever read of that instance. Re-running `curl`
  against a quiet instance returns `[]`, not this.
- The proxy **accumulates** alerts rather than replacing them each poll — its own read
  is what removes them from IRIS. See the note at the top of `../src/cache.js`.
- Anything else that reads that endpoint (a second proxy instance, a manual `curl`, the
  SMP) **steals alerts from the proxy**. If you need to inspect it by hand, expect to
  lose whatever you see from the proxy's view.

## The real alert shape vs `alerts.json`

The live body's keys are **`time`, `severity`, `message`**. `severity` is a
**numeric string** (`"2"`), matching the level column in `alerts.log`, not a word.

`alerts.json` was written before any capture existed and uses `id`, `severity`,
`text`, `timestamp`, `source` — with `severity: "warning"`. **Four of its five field
names do not exist upstream, and the fifth has a different value space.**

It has not been silently corrected, for two reasons:

1. Those field names are what `contracts/` implies downstream, and `contracts/` is
   read-only outside a contract PR. Rewriting the fixture to the real shape would put
   the mock and the contract in conflict without settling which one wins.
2. `alerts.json` is what Dev B's tests currently run against.

**This is an open contract question**, to be resolved in the `contracts/proxy-api.md` PR
alongside PROXY-Q1–Q5: either the proxy maps IRIS's `time`/`severity`/`message` onto the
`timestamp`/`severity`/`text` shape the findings API expects — including deciding what
`"2"` means as a word and where `source` comes from, since IRIS does not supply one — or
the contract adopts the upstream names. Until that is decided, the proxy forwards
upstream alert objects **unmodified** except for an added `observedAt`, so no mapping is
invented here.
