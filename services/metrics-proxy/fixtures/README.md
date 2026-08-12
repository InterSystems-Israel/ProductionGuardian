# fixtures/

Captures from a live IRIS instance, plus the smaller hand-written excerpts that predate
them. Committed so every developer mocks against the same bytes (ADR 0004).

| File | Provenance |
|---|---|
| `metrics-live-capture.txt` | **Real, and the mock default.** Full 310-line `/api/monitor/metrics` body, IRIS for Health 2024.1 on Windows, captured 2026-08-11 **after** the production items were renamed to the spaced contract names. 12 hosts, 3 application. |
| `metrics-live-capture-preRename.txt` | **Real.** The same instance earlier the same day, 313 lines, before the rename: unspaced item names (`EMRSource`, `LabRouter`), `PIDExtractProcess` present, activity reporter called `ActivityReporter`. |
| `alerts-live-capture.json` | **Real.** Full `/api/monitor/alerts` body, same instance, 2026-08-11. See the warning below — this endpoint cannot be re-captured at will. |
| `hoststatus-live-capture.json` | **Real, and the mock default for per-host queued/errored.** Body served over HTTP by `/labdemo/monitor/hoststatus` from live LABDEMO, IRIS for Health 2026.1, captured 2026-08-12. 13 hosts, 4 application, production `Running`. See below. |
| `metrics.txt` | Hand-trimmed 3-host excerpt in the real label shape. Small enough to reason about; `MOCK_FIXTURE=metrics.txt npm run mock` serves it. |
| `alerts.json` | **Hand-written, and its field names are wrong** — see below. |

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
